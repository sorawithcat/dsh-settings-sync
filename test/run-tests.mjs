/**
 * 设置同步插件 · 离线自测
 *
 * 运行：node test/run-tests.mjs
 *
 * 不需要 DSH、不需要浏览器：脚本伪造模块加载器、React、localStorage 和 fetch，
 * 把 client.js 当普通脚本加载测纯逻辑与界面装配；宿主半区（index.js）直接用 ESM
 * 导入，在临时目录里跑真实的文件读写与三条路由的边界。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

//#region 伪造浏览器环境
const storage = new Map();
globalThis.localStorage = {
	get length() {
		return storage.size;
	},
	key: (index) => [...storage.keys()][index] ?? null,
	getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
	setItem: (key, value) => storage.set(String(key), String(value)),
	removeItem: (key) => storage.delete(String(key)),
	clear: () => storage.clear()
};

const reactStub = {
	createElement(type, props, ...children) {
		const merged = { ...(props ?? {}) };
		if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
		return { $$element: true, type, props: merged };
	},
	useState(initial) {
		return [typeof initial === "function" ? initial() : initial, () => {}];
	},
	useEffect(fn) {
		const cleanup = fn();
		if (typeof cleanup === "function") cleanups.push(cleanup);
	},
	useMemo(fn) {
		return fn();
	},
	useCallback: (fn) => fn,
	useRef: (initial) => ({ current: initial ?? null })
};
const cleanups = [];

/** 让 Promise 链跑完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 让真实的文件读写（fs 线程池）也跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

/** 极简 fetch 替身：按 URL 返回预置响应（未预置就抛错，用来测降级路径）。 */
let fetchRoutes = new Map();
let fetchCalls = [];
globalThis.fetch = async (url, init) => {
	fetchCalls.push({ url, init });
	const body = fetchRoutes.get(String(url));
	if (body === undefined) throw new Error(`没有预置的响应：${url}`);
	return {
		ok: true,
		status: 200,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body))
	};
};
//#endregion

//#region 加载 client.js
const clientPath = path.join(import.meta.dirname, "..", "client.js");
const code = fs.readFileSync(clientPath, "utf8");
let factory = null;
let loadedId = null;
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			loadedId = definition.id;
			factory = definition.factory;
		}
	}
};
new Function(code)();
assert.equal(loadedId, "dsh-settings-sync", "模块 id 必须是插件名");
const mod = factory((specifier) => {
	if (specifier === "react") return reactStub;
	throw new Error(`插件不该 require：${specifier}`);
});
const t = mod.__test;
//#endregion

//#region 宿主半区（真实文件读写）
const host = await import(pathToFileURL(path.join(import.meta.dirname, "..", "index.js")).href);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-settings-sync-"));
//#endregion

//#region 结果收集
const results = [];
const runners = [];
function check(name, fn) {
	runners.push(async () => {
		try {
			await fn();
			results.push({ name, ok: true });
		} catch (error) {
			results.push({ name, ok: false, error: error?.stack ?? String(error) });
		}
	});
}
function resetStorage(entries = {}) {
	storage.clear();
	for (const [key, value] of Object.entries(entries)) storage.set(key, value);
}
//#endregion

//#region 插件外壳
check("模块元信息：名称 / 注入 / 导出", () => {
	assert.equal(mod.name, "dsh-settings-sync");
	assert.deepEqual(mod.inject, ["slots", "layout"]);
	assert.equal(typeof mod.apply, "function");
	assert.ok(t, "必须导出 __test");
	assert.equal(t.FORMAT, "dsh-settings-sync");
	assert.equal(t.FORMAT_VERSION, 1);
});

check("apply 只注册一个 settings.section 席位，且能被释放", () => {
	const injected = [];
	let registered = null;
	let disposed = 0;
	let disposer = null;
	const ctx = {
		slots: {
			inject(name, makeRegister) {
				injected.push(name);
				registered = makeRegister();
				return () => {
					disposed += 1;
				};
			},
			register(definition, component) {
				return { definition, component };
			}
		},
		effect(fn) {
			disposer = fn();
		}
	};
	mod.apply(ctx);
	assert.deepEqual(injected, ["settings.section"]);
	assert.equal(registered.definition.id, t.SECTION_ID);
	assert.equal(registered.definition.name, "settings.section");
	assert.equal(registered.definition.label, "设置同步");
	assert.equal(registered.definition.order, t.SECTION_ORDER);
	assert.equal(registered.component, t.SettingsSyncPage);
	assert.equal(typeof disposer, "function");
	disposer();
	assert.equal(disposed, 1, "释放时必须 dispose");
});

check("没有 slots 服务时不抛错", () => {
	const originalError = console.error;
	console.error = () => {};
	try {
		mod.apply({});
		mod.apply(undefined);
	} finally {
		console.error = originalError;
	}
});

check("没有 slots 服务时进 logger.error（不是只 console.warn）", () => {
	const logged = [];
	mod.apply({ logger: { error: (...args) => logged.push(args) } });
	assert.equal(logged.length, 1, "装配失败必须记一条 error 级日志");
	assert.match(String(logged[0][0]), /slots/);
});

check("注册席位抛错：不炸掉、退一个「加载失败」席位、写 error 级日志", () => {
	const errors = [];
	const originalError = console.error;
	console.error = (...args) => errors.push(args);
	try {
		const injected = [];
		const seats = [];
		mod.apply({
			slots: {
				inject(name, makeRegister) {
					injected.push(name);
					return makeRegister();
				},
				register(definition) {
					if (definition.label === "设置同步") throw new Error("slots 坏了");
					seats.push(definition);
					return { definition };
				}
			},
			effect() {}
		});
		assert.deepEqual(injected, ["settings.section", "settings.section"], "失败后应再试一个提示席位");
		assert.equal(seats.length, 1, "提示席位要真的注册");
		assert.equal(seats[0].label, "设置同步（加载失败）");
		assert.equal(errors.length, 1, "必须写 error 级日志");
	} finally {
		console.error = originalError;
	}
});
//#endregion

//#region 本地存储分类与读取
check("scopeOf：自己的键 / 会话草稿 / 可同步状态", () => {
	assert.equal(t.scopeOf("dsh-settings-sync/last.v1"), "own");
	assert.equal(t.scopeOf("dsh.conversation.abc"), "session");
	assert.equal(t.scopeOf("dsh.sidebar-right.v1.abc"), "session");
	assert.equal(t.scopeOf("dsh.user-questions.drafts.v1.abc"), "session");
	assert.equal(t.scopeOf("dsh-health-reminder/state.v1"), "state");
	assert.equal(t.scopeOf("dsh.workspace.view.v5"), "state");
	assert.equal(t.scopeOf(""), "own");
	assert.equal(t.scopeOf(null), "own");
});

check("readLocalEntries：跳过自己的键、标注会话草稿、按 key 排序", () => {
	resetStorage({
		"dsh-health-reminder/state.v1": "{\"a\":1}",
		"dsh.conversation.session-1": "draft",
		"dsh-settings-sync/last.v1": "{\"kind\":\"export\"}",
		"dsh.workspace.view.v5": "{}"
	});
	const entries = t.readLocalEntries();
	assert.deepEqual(
		entries.map((entry) => entry.key),
		["dsh-health-reminder/state.v1", "dsh.conversation.session-1", "dsh.workspace.view.v5"]
	);
	assert.equal(entries.find((entry) => entry.key === "dsh.conversation.session-1").scope, "session");
	assert.equal(entries.find((entry) => entry.key === "dsh-health-reminder/state.v1").scope, "state");
	assert.equal(entries.find((entry) => entry.key === "dsh-health-reminder/state.v1").bytes, 7);
});

check("readLocalEntries：整个读不到时留失败标志，界面据此区分「读不到」和「本机没有」", () => {
	const originalStorage = globalThis.localStorage;
	const originalWarn = console.warn;
	try {
		resetStorage({ "dsh.workspace.view.v5": "{}" });
		assert.equal(t.readLocalEntries().length, 1);
		assert.equal(t.localReadFailedFlag(), false);
		console.warn = () => {};
		globalThis.localStorage = {
			get length() {
				throw new Error("隐私模式：本地存储不可用");
			},
			key() {
				throw new Error("隐私模式：本地存储不可用");
			},
			getItem() {
				throw new Error("隐私模式：本地存储不可用");
			},
			setItem() {
				throw new Error("隐私模式：本地存储不可用");
			}
		};
		assert.deepEqual(t.readLocalEntries(), [], "读不到就返回空表，不能炸");
		assert.equal(t.localReadFailedFlag(), true);
	} finally {
		globalThis.localStorage = originalStorage;
		console.warn = originalWarn;
	}
	resetStorage({ "dsh.workspace.view.v5": "{}" });
	assert.equal(t.readLocalEntries().length, 1);
	assert.equal(t.localReadFailedFlag(), false, "恢复正常后标志要清掉");
});

check("上限：键数到 MAX_KEYS 就截断、超长值不导出（常量与实现同一个数）", () => {
	const entries = {};
	for (let i = 0; i < t.MAX_KEYS + 5; i += 1) entries[`dsh.workspace.k${String(i).padStart(4, "0")}`] = "1";
	entries["dsh.workspace.aaa-huge"] = "x".repeat(t.MAX_TEXT + 1);
	resetStorage(entries);
	const read = t.readLocalEntries();
	assert.equal(read.length, t.MAX_KEYS, `最多只收 ${t.MAX_KEYS} 个键`);
	assert.equal(read.some((entry) => entry.key === "dsh.workspace.aaa-huge"), false, "超过 1 MB 的值不导出");
	resetStorage({});
});

check("上限：文件 / 浏览器 / profile 条目超上限都整份拒绝，市场备份正好到上限要收下", () => {
	const payload = (extra) => JSON.stringify({ format: t.FORMAT, version: t.FORMAT_VERSION, ...extra });
	const manyFiles = { files: Array.from({ length: t.MAX_FILES + 1 }, (_, i) => ({ id: `f${i}`, text: "x" })) };
	assert.equal(t.parsePayload(payload(manyFiles)).code, "TOO_MANY");
	const manyStorage = { browser: { storage: Array.from({ length: t.MAX_KEYS + 1 }, (_, i) => ({ key: `dsh.workspace.k${i}`, value: "x" })) } };
	assert.equal(t.parsePayload(payload(manyStorage)).code, "TOO_MANY");
	const manyProfile = { profile: Array.from({ length: t.MAX_PROFILE + 1 }, (_, i) => ({ path: `p${i}.yml`, text: "x" })) };
	assert.equal(t.parsePayload(payload(manyProfile)).code, "TOO_MANY");
	const atLimit = { format: t.MARKET_FORMAT, version: t.MARKET_VERSION, files: Array.from({ length: t.MAX_PROFILE }, (_, i) => ({ path: `p${i}.yml`, lines: ["x"] })) };
	assert.equal(t.marketProfileEntries(atLimit).entries.length, t.MAX_PROFILE, "正好到上限要收下");
	assert.equal(t.marketProfileEntries({ ...atLimit, files: Array.from({ length: t.MAX_PROFILE + 1 }, (_, i) => ({ path: `p${i}.yml`, lines: ["x"] })) }).error.code, "TOO_MANY");
	for (const name of t.PROFILE_EXCLUDED) assert.equal(t.profileEntryProblem(`a/${name}/b`, "x"), "这个路径属于排除范围");
});
//#endregion

//#region 导出
check("buildExport：形状、格式版本、浏览器数据分类", () => {
	const payload = t.buildExport({
		home: "C:\\Users\\x\\.dsh",
		origin: "app://dsh",
		files: [{ id: "agents", rel: "AGENTS.md", label: "全局工作规则", text: "# 规则", sha256: "abc" }],
		storage: [{ key: "dsh.workspace.view.v5", value: "{}" }],
		exportedAt: "2026-10-09T07:00:00.000Z"
	});
	assert.equal(payload.format, "dsh-settings-sync");
	assert.equal(payload.version, 1);
	assert.equal(payload.exportedAt, "2026-10-09T07:00:00.000Z");
	assert.equal(payload.home, "C:\\Users\\x\\.dsh");
	assert.equal(payload.origin, "app://dsh");
	assert.deepEqual(payload.files, [{ id: "agents", rel: "AGENTS.md", label: "全局工作规则", secret: false, sha256: "abc", text: "# 规则" }]);
	assert.deepEqual(payload.browser.storage, [{ key: "dsh.workspace.view.v5", value: "{}", scope: "state" }]);
});

check("导出文件名用本地时间", () => {
	assert.equal(t.exportFileName(new Date(2026, 9, 9, 15, 4)), "dsh-settings-20261009-1504.json");
	assert.equal(t.exportFileName(new Date(2026, 0, 1, 0, 0)), "dsh-settings-20260101-0000.json");
});

check("formatBytes / readableTime 的退化输入", () => {
	assert.equal(t.formatBytes(0), "0 B");
	assert.equal(t.formatBytes(2048), "2.0 KB");
	assert.equal(t.formatBytes(2 * 1024 * 1024), "2.0 MB");
	assert.equal(t.formatBytes(undefined), "—");
	assert.equal(t.readableTime(""), null);
	assert.equal(t.readableTime("not-a-date"), null);
	assert.equal(typeof t.readableTime("2026-10-09T07:00:00.000Z"), "string");
	assert.ok(t.readableTime("2026-10-09T07:00:00.000Z").includes("2026"));
});
//#endregion

//#region 解析与校验
const validPayload = () =>
	JSON.stringify({
		format: "dsh-settings-sync",
		version: 1,
		exportedAt: "2026-10-09T07:00:00.000Z",
		home: "C:\\Users\\x\\.dsh",
		files: [{ id: "agents", rel: "AGENTS.md", text: "# 规则" }],
		browser: { storage: [{ key: "dsh.workspace.view.v5", value: "{}" }] }
	});

check("parsePayload：接受合法文件", () => {
	const parsed = t.parsePayload(validPayload());
	assert.equal(parsed.ok, true);
	assert.equal(parsed.payload.version, 1);
	assert.deepEqual(parsed.payload.files, [{ id: "agents", rel: "AGENTS.md", label: null, secret: false, text: "# 规则" }]);
	assert.equal(parsed.payload.storage[0].key, "dsh.workspace.view.v5");
});

check("parsePayload：拒绝坏 JSON / 不是本插件 / 版本不认识 / 空内容", () => {
	assert.equal(t.parsePayload("{").code, "BAD_JSON");
	assert.equal(t.parsePayload("[]").code, "BAD_FORMAT");
	assert.equal(t.parsePayload(JSON.stringify({ format: "other" })).code, "BAD_FORMAT");
	assert.equal(t.parsePayload(JSON.stringify({ format: "dsh-settings-sync", version: 99 })).code, "BAD_VERSION");
	assert.equal(t.parsePayload(JSON.stringify({ format: "dsh-settings-sync", version: 1 })).code, "EMPTY");
	assert.equal(t.parsePayload(undefined).code, "TOO_LARGE");
});

check("parsePayload：拒绝坏条目与超大值、忽略自己的键", () => {
	const badFile = JSON.stringify({ format: "dsh-settings-sync", version: 1, files: [{ id: "agents" }] });
	assert.equal(t.parsePayload(badFile).code, "BAD_ITEM");
	const bigValue = JSON.stringify({
		format: "dsh-settings-sync",
		version: 1,
		browser: { storage: [{ key: "k", value: "x".repeat(t.MAX_TEXT + 1) }] }
	});
	assert.equal(t.parsePayload(bigValue).code, "TOO_LARGE");
	const ownKey = JSON.stringify({
		format: "dsh-settings-sync",
		version: 1,
		browser: { storage: [{ key: "dsh-settings-sync/last.v1", value: "{}" }] }
	});
	assert.equal(t.parsePayload(ownKey).code, "EMPTY", "只含自己键的文件等同空文件");
	const mixed = JSON.stringify({
		format: "dsh-settings-sync",
		version: 1,
		browser: {
			storage: [
				{ key: "dsh-settings-sync/last.v1", value: "{}" },
				{ key: "dsh.workspace.view.v5", value: "{}" }
			]
		}
	});
	const parsed = t.parsePayload(mixed);
	assert.equal(parsed.ok, true);
	assert.deepEqual(parsed.payload.storage.map((item) => item.key), ["dsh.workspace.view.v5"]);
});
//#endregion

//#region 预览与写入
check("previewRows：新增 / 覆盖 / 相同 / 不认识", () => {
	const payload = {
		exportedAt: null,
		home: null,
		files: [
			{ id: "agents", text: "# 新规则" },
			{ id: "pet", text: "same" },
			{ id: "ghost", text: "x" }
		],
		storage: [
			{ key: "dsh.workspace.view.v5", value: "{}", scope: "state" },
			{ key: "dsh.conversation.x", value: "draft", scope: "session" }
		]
	};
	const manifest = {
		files: [
			{ id: "agents", rel: "AGENTS.md", label: "全局工作规则", exists: true },
			{ id: "pet", rel: "pet.json", label: "桌面宠物", exists: true }
		]
	};
	const current = [
		{ id: "agents", text: "# 旧规则" },
		{ id: "pet", text: "same" }
	];
	const rows = t.previewRows(payload, manifest, current, [{ key: "dsh.conversation.x", value: "old" }]);
	const byId = new Map(rows.map((row) => [`${row.section}:${row.id}`, row]));
	assert.equal(byId.get("file:agents").action, "update");
	assert.equal(byId.get("file:agents").label, "全局工作规则");
	assert.equal(byId.get("file:pet").action, "same");
	assert.equal(byId.get("file:ghost").action, "unknown");
	assert.equal(byId.get("browser:dsh.workspace.view.v5").action, "add");
	assert.equal(byId.get("browser:dsh.conversation.x").action, "update");
	assert.equal(byId.get("browser:dsh.conversation.x").detail, "会话草稿");
});

check("previewRows：拿不到本机内容时文件算「覆盖（无法对比）」", () => {
	const payload = { files: [{ id: "agents", text: "x" }], storage: [] };
	const manifest = { files: [{ id: "agents", rel: "AGENTS.md", label: "全局工作规则", exists: true }] };
	const rows = t.previewRows(payload, manifest, [], []);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].action, "update?");
});

check("applyStorage：写入并统计，单个键失败不影响其余", () => {
	resetStorage();
	const result = t.applyStorage([
		{ key: "a", value: "1" },
		{ key: "b", value: "2" }
	]);
	assert.deepEqual(result, { written: 2, skipped: 0 });
	assert.equal(storage.get("a"), "1");
	assert.equal(storage.get("b"), "2");
});

check("rememberRun / readLastRun 往返（自己的键不参与同步）", () => {
	resetStorage();
	assert.equal(t.readLastRun(), null);
	t.rememberRun("export", "2026-10-09T07:00:00.000Z");
	const last = t.readLastRun();
	assert.equal(last.kind, "export");
	assert.ok(last.at);
	assert.equal(t.scopeOf(t.LAST_KEY), "own");
	assert.equal(t.readLocalEntries().length, 0, "自己的键不出现在可同步列表里");
});

check("readLastRun 遇到垃圾内容返回 null", () => {
	resetStorage({ [t.LAST_KEY]: "not json" });
	assert.equal(t.readLastRun(), null);
	resetStorage({ [t.LAST_KEY]: "\"str\"" });
	assert.equal(t.readLastRun(), null);
});
//#endregion

/** 在渲染出来的元素树里按条件找一个节点（reactStub 不渲染子组件，只能自己走一遍）。 */
function findElement(tree, predicate) {
	const queue = [tree];
	while (queue.length > 0) {
		const node = queue.shift();
		if (!node || typeof node !== "object") continue;
		if (node.$$element === true && predicate(node)) return node;
		const children = node.props?.children;
		if (children === undefined) continue;
		for (const child of Array.isArray(children) ? children : [children]) queue.push(child);
	}
	return null;
}

//#region 界面冒烟
check("设置页：能拉到清单并渲染（含勾选与按钮）", async () => {
	resetStorage({ "dsh.workspace.view.v5": "{}", "dsh.conversation.s1": "draft" });
	fetchRoutes = new Map([
		[
			"/dsh-settings-sync/manifest",
			{
				ok: true,
				home: "C:\\Users\\x\\.dsh",
				files: [
					{ id: "agents", rel: "AGENTS.md", label: "全局工作规则", secret: false, exists: true, bytes: 1507 },
					{ id: "credentials", rel: ".credentials.yaml", label: "账号凭据", secret: true, exists: true, bytes: 478 }
				],
				profile: { dir: "C:\\Users\\x\\.dsh\\profiles\\desktop", files: [{ path: "package.json", exists: true, bytes: 1246, secret: false }] }
			}
		]
	]);
	fetchCalls = [];
	const tree = t.SettingsSyncPage();
	await settle();
	const json = JSON.stringify(tree);
	assert.ok(json.includes("设置同步"));
	assert.ok(json.includes("配置文件"));
	assert.ok(json.includes("浏览器本地数据"));
	assert.ok(json.includes("profile 配置（插件清单）"));
	assert.ok(json.includes("导出 JSON"));
	assert.ok(json.includes("导出市场格式"));
	assert.ok(json.includes("重装插件"));
	assert.ok(json.includes("导入…"));
	assert.equal(fetchCalls.length, 1);
	assert.equal(fetchCalls[0].url, "/dsh-settings-sync/manifest");
	assert.equal(fetchRoutes.size, 1);
});

check("设置页：点「重装插件」会请求宿主的安装路由", async () => {
	resetStorage({});
	fetchRoutes = new Map([
		["/dsh-settings-sync/manifest", { ok: true, home: "H", files: [], profile: { dir: "P", files: [] } }],
		["/dsh-settings-sync/install", { ok: true, code: "INSTALLED", source: "runtime", exitCode: 0, output: "装好了" }]
	]);
	fetchCalls = [];
	const tree = t.SettingsSyncPage();
	await settle();
	const button = findElement(tree, (node) => node.props?.children === "重装插件");
	assert.ok(button, "必须渲染出「重装插件」按钮");
	button.props.onClick();
	await settle();
	const call = fetchCalls.find((entry) => entry.url === "/dsh-settings-sync/install");
	assert.ok(call, "点击后必须请求安装路由");
	assert.equal(call.init.method, "POST");
});

check("设置页：宿主半区不可用时降级（错误被吞掉，不产生未处理拒绝）", async () => {
	fetchRoutes = new Map();
	fetchCalls = [];
	const tree = t.SettingsSyncPage();
	await settle();
	assert.equal(fetchCalls.length, 1);
	assert.ok(JSON.stringify(tree).includes("设置同步"), "页面本身仍然渲染");
});

check("设置页：没有 fetch 时安然降级", async () => {
	const saved = globalThis.fetch;
	delete globalThis.fetch;
	try {
		const tree = t.SettingsSyncPage();
		await settle();
		assert.ok(JSON.stringify(tree).includes("正在读取本机目录"));
	} finally {
		globalThis.fetch = saved;
	}
});

check("导入预览弹窗能渲染（新增 / 覆盖 / 相同 / 跳过）", () => {
	const preview = {
		payload: { exportedAt: "2026-10-09T07:00:00.000Z", home: "C:\\Users\\x\\.dsh" },
		rows: [
			{ section: "file", id: "agents", label: "全局工作规则", detail: "AGENTS.md", action: "update", bytes: 12 },
			{ section: "file", id: "pet", label: "桌面宠物", detail: "pet.json", action: "same", bytes: 4 },
			{ section: "file", id: "ghost", label: "ghost", detail: "", action: "unknown", bytes: 1 },
			{ section: "browser", id: "dsh.workspace.view.v5", label: "dsh.workspace.view.v5", detail: "", action: "add", bytes: 2 }
		]
	};
	const tree = t.PreviewDialog({ preview, busy: false, onCancel: () => {}, onConfirm: () => {} });
	const json = JSON.stringify(tree);
	assert.ok(json.includes("导入这份设置？"));
	assert.ok(json.includes("确认导入"));
	assert.ok(json.includes("配置文件（2）"), "相同项不进预览清单，其余 2 项按分组列出");
	assert.ok(json.includes("浏览器本地数据（1）"));
	assert.ok(json.includes("标着「跳过」"));
	assert.ok(json.includes("来自 C:\\\\Users\\\\x\\\\.dsh"));
	for (const cleanup of cleanups.splice(0)) cleanup();
});

check("动作徽标：五种动作的文案", () => {
	const text = (action) => t.ActionBadge({ action }).props.children;
	assert.equal(text("add"), "新增");
	assert.equal(text("update"), "覆盖");
	assert.equal(text("update?"), "覆盖（无法对比）");
	assert.equal(text("same"), "相同");
	assert.equal(text("unknown"), "跳过");
	assert.equal(text("没有这个动作"), "相同", "未知动作退化成「相同」而不是崩");
});

check("预览弹窗：全部相同时给出「不会改变任何东西」", () => {
	const preview = {
		payload: { exportedAt: null, home: null },
		rows: [{ section: "file", id: "agents", label: "全局工作规则", detail: "AGENTS.md", action: "same", bytes: 1 }]
	};
	const json = JSON.stringify(t.PreviewDialog({ preview, busy: false, onCancel: () => {}, onConfirm: () => {} }));
	assert.ok(json.includes("导入这份设置？"));
	assert.ok(json.includes("本机内容和它完全一致"));
});
//#endregion

//#region profile 配置与插件市场格式
check("marketProfileEntries：市场备份的两种条目与各种拒绝", () => {
	const backup = {
		format: "dsh-profile-backup",
		version: 0.2,
		createdAt: "2026-10-09T07:00:00.000Z",
		profile: "desktop",
		files: [
			{ path: "package.json", json: { name: "dsh-profile-desktop", dependencies: { dshmarket: "^1.0.0" } } },
			{ path: "cordis.patch.yml", lines: ["- insert:", "  - id: ui-x"] }
		]
	};
	const converted = t.marketProfileEntries(backup);
	assert.equal(converted.createdAt, "2026-10-09T07:00:00.000Z");
	assert.deepEqual(converted.entries.map((entry) => entry.path), ["package.json", "cordis.patch.yml"]);
	assert.equal(JSON.parse(converted.entries[0].text).dependencies.dshmarket, "^1.0.0");
	assert.equal(converted.entries[1].text, "- insert:\n  - id: ui-x");
	assert.equal(converted.entries[0].secret, false);
	assert.equal(converted.entries[1].secret, false);
	const withSecret = t.marketProfileEntries({
		format: "dsh-profile-backup",
		version: 0.2,
		files: [{ path: "pnpm-workspace.yaml", lines: ["packages:", "  - 'apps/*'"] }]
	});
	assert.equal(withSecret.entries[0].secret, true, "市场备份里像凭据的文件名也要被标出来");
	assert.equal(t.marketProfileEntries({ format: "dsh-settings-sync", version: 1 }), null, "本插件格式不该被当成市场备份");
	assert.equal(t.marketProfileEntries({ format: "dsh-profile-backup", version: 0.3, files: [] }), null, "版本不认识就不认");
	assert.equal(t.marketProfileEntries({ format: "dsh-profile-backup", version: 0.2, files: [{ lines: [] }] }).error.code, "BAD_ITEM");
	assert.equal(t.marketProfileEntries({ format: "dsh-profile-backup", version: 0.2, files: [{ path: "package.json" }] }).error.code, "BAD_ITEM");
	assert.equal(t.marketProfileEntries({ format: "dsh-profile-backup", version: 0.2, files: [{ path: "a.yml", lines: [1] }] }).error.code, "BAD_ITEM");
});

check("parsePayload：整份插件市场备份可以直接导入", () => {
	const text = JSON.stringify({
		format: "dsh-profile-backup",
		version: 0.2,
		createdAt: "2026-10-09T07:00:00.000Z",
		profile: "desktop",
		files: [{ path: "package.json", json: { name: "x" } }]
	});
	const parsed = t.parsePayload(text);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.payload.market, true);
	assert.equal(parsed.payload.home, null);
	assert.equal(parsed.payload.files.length, 0);
	assert.equal(parsed.payload.profile[0].path, "package.json");
	assert.equal(t.parsePayload(JSON.stringify({ format: "dsh-profile-backup", version: 0.2, files: [{ path: "package.json", lines: [] }] })).code, "BAD_ITEM");
	assert.equal(t.parsePayload(JSON.stringify({ format: "dsh-profile-backup", version: 9, files: [] })).code, "BAD_FORMAT");
	assert.equal(t.parsePayload(JSON.stringify({ format: "dsh-profile-backup", version: 0.2, files: [] })).code, "EMPTY");
});

check("parsePayload：本插件文件里的 profile 段落按同一套规则校验", () => {
	const good = JSON.stringify({ format: "dsh-settings-sync", version: 1, profile: [{ path: "sub\\cordis.patch.yml", text: "- insert:\n" }] });
	const parsed = t.parsePayload(good);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.payload.profile[0].path, "sub/cordis.patch.yml", "反斜杠归一化");
	const escape = JSON.stringify({ format: "dsh-settings-sync", version: 1, profile: [{ path: "../x", text: "a" }] });
	assert.equal(t.parsePayload(escape).code, "BAD_ITEM");
	const excluded = JSON.stringify({ format: "dsh-settings-sync", version: 1, profile: [{ path: "node_modules/x", text: "a" }] });
	assert.equal(t.parsePayload(excluded).code, "BAD_ITEM");
	const duplicated = JSON.stringify({
		format: "dsh-settings-sync",
		version: 1,
		profile: [
			{ path: "a.yml", text: "1" },
			{ path: "a.yml", text: "2" }
		]
	});
	assert.equal(t.parsePayload(duplicated).code, "BAD_ITEM");
});

check("profileEntryProblem：路径与体积的边界", () => {
	assert.equal(t.profileEntryProblem("package.json", "{}"), null);
	assert.equal(t.profileEntryProblem("sub/cordis.patch.yml", "x"), null);
	assert.ok(t.profileEntryProblem("", "x"));
	assert.ok(t.profileEntryProblem("/etc/passwd", "x"));
	assert.ok(t.profileEntryProblem("C:/x", "x"));
	assert.ok(t.profileEntryProblem("a/../b", "x"));
	assert.ok(t.profileEntryProblem("a//b", "x"));
	assert.ok(t.profileEntryProblem("node_modules/x", "x"));
	assert.ok(t.profileEntryProblem(".git/config", "x"));
	assert.ok(t.profileEntryProblem("pnpm-lock.yaml", "x"));
	assert.ok(t.profileEntryProblem(`${"a".repeat(301)}.json`, "x"));
	assert.ok(t.profileEntryProblem("a.txt", 5), "内容必须是字符串");
	assert.ok(t.profileEntryProblem("a.txt", "x".repeat(t.MAX_TEXT + 1)));
});

check("marketFileName：市场格式备份的文件名", () => {
	assert.equal(t.marketFileName(new Date(2026, 9, 9, 15, 4)), "dsh-profile-backup-20261009-1504.json");
	assert.equal(t.marketFileName(new Date(2026, 0, 1, 0, 0)), "dsh-profile-backup-20260101-0000.json");
});

check("buildExport：profile 与市场格式一起带出去", () => {
	const payload = t.buildExport({
		home: "H",
		origin: "app://dsh",
		files: [],
		storage: [],
		profile: [{ path: "package.json", text: "{}", secret: false, sha256: "abc" }],
		market: { format: "dsh-profile-backup", version: 0.2, files: [] },
		exportedAt: "T"
	});
	assert.deepEqual(payload.profile, [{ path: "package.json", secret: false, sha256: "abc", text: "{}" }]);
	assert.equal(payload.market.format, "dsh-profile-backup");
	assert.equal(t.buildExport({}).market, null, "没有市场格式时给 null 而不是 undefined");
});

check("previewRows：profile 的合并 / 新增 / 相同", () => {
	const payload = {
		files: [],
		storage: [],
		profile: [
			{ path: "package.json", text: "{\"a\":1}" },
			{ path: "cordis.patch.yml", text: "x" },
			{ path: "keep.yml", text: "same" }
		]
	};
	const manifest = { files: [], profile: { files: [{ path: "package.json", exists: true }, { path: "cordis.patch.yml", exists: false }] } };
	const rows = t.previewRows(payload, manifest, [], [], [{ path: "keep.yml", text: "same" }]);
	const byId = new Map(rows.map((row) => [row.id, row]));
	assert.equal(byId.get("package.json").section, "profile");
	assert.equal(byId.get("package.json").action, "merge");
	assert.equal(byId.get("package.json").detail, "插件清单合并");
	assert.equal(byId.get("cordis.patch.yml").action, "add");
	assert.equal(byId.get("cordis.patch.yml").detail, "本机没有这个文件");
	assert.equal(byId.get("keep.yml").action, "same");
});

check("预览弹窗：profile 分组与「插件市场备份」来源", () => {
	const preview = {
		payload: { exportedAt: "2026-10-09T07:00:00.000Z", home: null, market: true },
		rows: [
			{ section: "profile", id: "package.json", label: "package.json", detail: "插件清单合并", action: "merge", bytes: 12 },
			{ section: "profile", id: "a.yml", label: "a.yml", detail: "本机没有这个文件", action: "add", bytes: 3 }
		]
	};
	const json = JSON.stringify(t.PreviewDialog({ preview, busy: false, onCancel: () => {}, onConfirm: () => {} }));
	assert.ok(json.includes("profile 配置（插件清单等）"));
	assert.ok(json.includes("插件市场备份"));
	assert.ok(json.includes("插件清单合并"));
	assert.equal(t.ActionBadge({ action: "merge" }).props.children, "合并");
});

check("敏感提示：导入预览标出「含凭据」，并在弹窗里单独提醒", () => {
	const payload = {
		files: [{ id: "credentials", text: "token: 1" }],
		storage: [],
		profile: [{ path: "pnpm-workspace.yaml", text: "packages:\n" }]
	};
	const manifest = {
		files: [{ id: "credentials", rel: ".credentials.yaml", label: "账号凭据", secret: true, exists: true }],
		profile: { files: [] }
	};
	const rows = t.previewRows(payload, manifest, [], [], []);
	const byId = new Map(rows.map((row) => [row.id, row]));
	assert.equal(byId.get("credentials").secret, true, "固定表里标了凭据的文件要带标记");
	assert.equal(byId.get("pnpm-workspace.yaml").secret, true, "本机没有、但文件名像凭据的 profile 配置也要带标记");
	assert.equal(t.PROFILE_SECRET_HINTS.test("config.toml"), true);
	assert.equal(t.PROFILE_SECRET_HINTS.test("cordis.patch.yml"), false);

	const warned = JSON.stringify(
		t.PreviewDialog({
			preview: { payload: { exportedAt: null, home: null, market: false }, rows },
			busy: false,
			onCancel: () => {},
			onConfirm: () => {}
		})
	);
	assert.ok(warned.includes("含凭据"), "弹窗里要有凭据提示");
	assert.ok(warned.includes("2 个"), "提示要报出条数");

	const clean = JSON.stringify(
		t.PreviewDialog({
			preview: {
				payload: { exportedAt: null, home: null, market: false },
				rows: [
					{ section: "profile", id: "package.json", label: "package.json", detail: "插件清单合并", action: "merge", bytes: 3, secret: false },
					{ section: "profile", id: "old.yml", label: "old.yml", detail: "", action: "same", bytes: 3, secret: true }
				]
			},
			busy: false,
			onCancel: () => {},
			onConfirm: () => {}
		})
	);
	assert.ok(!clean.includes("这份文件里有"), "内容相同的条目不该触发凭据提醒");
});
//#endregion

//#region 宿主半区：home 解析
check("resolveDshHome：DSH_HOME 优先、空白视为未设置", () => {
	assert.equal(host.resolveDshHome({ DSH_HOME: "D:\\dsh" }), path.resolve("D:\\dsh"));
	assert.equal(host.resolveDshHome({ DSH_HOME: "   " }), path.resolve(host.defaultDshHome()));
	assert.equal(host.resolveDshHome({}), path.resolve(host.defaultDshHome()));
	assert.equal(host.expandHomePath("~/x"), path.join(os.homedir(), "x"));
	assert.equal(host.expandHomePath("~"), os.homedir());
});

check("固定表：路径不越界、id 唯一、敏感项只有凭据", () => {
	const home = path.join(tempRoot, "home-check");
	const seen = new Set();
	for (const entry of host.FILES) {
		assert.ok(!seen.has(entry.id), `id 重复：${entry.id}`);
		seen.add(entry.id);
		assert.ok(!entry.rel.includes(".."), `rel 不能含 ..：${entry.rel}`);
		assert.ok(path.resolve(path.join(home, entry.rel)).startsWith(path.resolve(home)), `越界：${entry.rel}`);
	}
	assert.deepEqual(
		host.FILES.filter((entry) => entry.secret === true).map((entry) => entry.id),
		["credentials"]
	);
	assert.equal(host.fileById("agents").rel, "AGENTS.md");
	assert.equal(host.fileById("nope"), null);
	assert.equal(host.fileById(123), null);
});
//#endregion

//#region 宿主半区：请求校验
check("validateExportRequest：未知 id / 去重 / 敏感项要显式允许", () => {
	assert.equal(host.validateExportRequest(null).code, "BAD_BODY");
	assert.equal(host.validateExportRequest({ ids: "agents" }).code, "BAD_BODY");
	assert.equal(host.validateExportRequest({ ids: ["nope"] }).code, "UNKNOWN_FILE");
	assert.equal(host.validateExportRequest({ ids: ["credentials"] }).code, "SECRET_NOT_ALLOWED");
	const ok = host.validateExportRequest({ ids: ["credentials"], allowSecrets: true });
	assert.equal(ok.ok, true);
	const dedup = host.validateExportRequest({ ids: ["agents", "agents", "pet"] });
	assert.deepEqual(dedup.entries.map((entry) => entry.id), ["agents", "pet"]);
});

check("validateImportRequest：未知 id / 重复 / 非字符串 / 超大 / 空", () => {
	assert.equal(host.validateImportRequest(null).code, "BAD_BODY");
	assert.equal(host.validateImportRequest({ files: [] }).code, "EMPTY");
	assert.equal(host.validateImportRequest({ files: [{ id: "nope", text: "x" }] }).code, "UNKNOWN_FILE");
	assert.equal(host.validateImportRequest({ files: [{ id: "agents", text: 1 }] }).code, "BAD_BODY");
	assert.equal(
		host.validateImportRequest({
			files: [
				{ id: "agents", text: "a" },
				{ id: "agents", text: "b" }
			]
		}).code,
		"DUPLICATE"
	);
	assert.equal(host.validateImportRequest({ files: [{ id: "agents", text: "x".repeat(1024 * 1024 + 1) }] }).code, "TOO_LARGE");
	const ok = host.validateImportRequest({ files: [{ id: "agents", text: "hello" }] });
	assert.equal(ok.ok, true);
	assert.equal(ok.items[0].entry.rel, "AGENTS.md");
	assert.equal(ok.items[0].text, "hello");
});

check("backupStamp：可读且不含 Windows 非法字符", () => {
	const stamp = host.backupStamp(new Date("2026-10-09T07:00:00.000Z"));
	assert.equal(stamp, "2026-10-09T07-00-00-000Z");
	assert.ok(!/[:*?"<>|]/.test(stamp));
});
//#endregion

//#region 宿主半区：真实文件读写
check("applyWrites：新建 / 覆盖留备份 / 相同跳过", async () => {
	const home = path.join(tempRoot, "write-home");
	const first = await host.applyWrites(home, [{ entry: host.fileById("agents"), text: "v1" }], "STAMP");
	assert.equal(first[0].action, "created");
	assert.equal(first[0].backup, null);
	assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), "v1");

	const second = await host.applyWrites(home, [{ entry: host.fileById("agents"), text: "v2" }], "STAMP");
	assert.equal(second[0].action, "written");
	assert.equal(second[0].backup, path.join(home, "AGENTS.md.bak-settings-sync-STAMP"));
	assert.equal(fs.readFileSync(second[0].backup, "utf8"), "v1");
	assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), "v2");

	const third = await host.applyWrites(home, [{ entry: host.fileById("agents"), text: "v2" }], "STAMP");
	assert.equal(third[0].action, "unchanged");
	assert.equal(third[0].backup, null);
});

check("applyWrites：storages/ 这种子目录会自动建", async () => {
	const home = path.join(tempRoot, "subdir-home");
	const results = await host.applyWrites(home, [{ entry: host.fileById("workspaces"), text: "[]" }], "S");
	assert.equal(results[0].action, "created");
	assert.equal(fs.readFileSync(path.join(home, "storages", "workspace.json"), "utf8"), "[]");
});

check("applyWrites：读不出内容的老文件也先留一份备份，并记成覆盖", async () => {
	const home = path.join(tempRoot, "unreadable-home");
	fs.mkdirSync(home, { recursive: true });
	const target = path.join(home, ".credentials.yaml");
	fs.writeFileSync(target, "x".repeat(1024 * 1024 + 64), "utf8");
	const results = await host.applyWrites(home, [{ entry: host.fileById("credentials"), text: "fresh" }], "STAMP");
	assert.equal(results[0].action, "written", "已经存在的文件不能记成新增");
	assert.equal(results[0].backup, `${target}.bak-settings-sync-STAMP`);
	assert.equal(fs.statSync(results[0].backup).size, 1024 * 1024 + 64, "备份是原文件的完整副本");
	assert.equal(fs.readFileSync(target, "utf8"), "fresh");
});

check("readManifest：报告存在性 / 大小 / 指纹，且路径都在 home 下", async () => {
	const home = path.join(tempRoot, "manifest-home");
	await host.applyWrites(home, [{ entry: host.fileById("pet"), text: "{}" }], "S");
	const manifest = await host.readManifest(home);
	assert.equal(manifest.home, home);
	const pet = manifest.files.find((file) => file.id === "pet");
	assert.equal(pet.exists, true);
	assert.equal(pet.bytes, 2);
	assert.equal(pet.sha256, host.sha256("{}"));
	assert.equal(pet.readable, true);
	const credentials = manifest.files.find((file) => file.id === "credentials");
	assert.equal(credentials.exists, false);
	assert.equal(credentials.bytes, 0);
	assert.equal(credentials.sha256, null);
	for (const file of manifest.files) assert.ok(file.path.startsWith(home));
});
//#endregion

//#region 宿主半区：三条路由
/** 假的 req / res，够 handler 用。 */
function fakeRequest(method, body, contentType = "application/json") {
	const chunks = body === undefined ? [] : [Buffer.from(body, "utf8")];
	return {
		method,
		headers: body === undefined ? {} : { "content-type": contentType },
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk;
		},
		resume() {}
	};
}
function fakeResponse() {
	return {
		statusCode: 0,
		headers: {},
		body: "",
		setHeader(key, value) {
			this.headers[String(key).toLowerCase()] = value;
		},
		end(text) {
			this.body = text ?? "";
		}
	};
}

let routes = [];
let savedEnv = null;

/** 把上一步改过的进程环境还原（安装路由在请求时才读环境，所以要留到用例结束）。 */
function restoreEnv() {
	if (savedEnv === null) return;
	if (savedEnv.home === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = savedEnv.home;
	if (savedEnv.dir === undefined) delete process.env.DSH_PROFILE_DIR;
	else process.env.DSH_PROFILE_DIR = savedEnv.dir;
	savedEnv = null;
}

/**
 * 挂载宿主半区并记下注册的路由。
 * `options.profileDir` 会写进 DSH_PROFILE_DIR（请求阶段也读它）；
 * `options.services` 是 `ctx.get(name)` 的替身（`profileContext` 走这里）。
 */
function mountHost(home, options = {}) {
	restoreEnv();
	routes = [];
	savedEnv = { home: process.env.DSH_HOME, dir: process.env.DSH_PROFILE_DIR };
	process.env.DSH_HOME = home;
	if (options.profileDir === undefined) delete process.env.DSH_PROFILE_DIR;
	else process.env.DSH_PROFILE_DIR = options.profileDir;
	const services = { ...(options.services ?? {}) };
	const ctx = {
		logger: { info() {} },
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			}
		},
		connection: { requestRejection: () => undefined },
		get: (name) => services[name],
		effect(fn) {
			fn();
		}
	};
	host.apply(ctx);
}
const routeOf = (p) => routes.find((route) => route.path === p);

check("apply 注册四条 exact 路由", () => {
	mountHost(path.join(tempRoot, "route-home"));
	assert.deepEqual(
		routes.map((route) => route.path).sort(),
		[host.internals.MANIFEST_PATH, host.internals.EXPORT_PATH, host.internals.IMPORT_PATH, host.internals.INSTALL_PATH].sort()
	);
	for (const route of routes) assert.equal(route.kind, "exact");
});

check("manifest 路由：GET 200、POST 405", async () => {
	mountHost(path.join(tempRoot, "route-home"));
	const route = routeOf(host.internals.MANIFEST_PATH);
	const res = fakeResponse();
	route.handler(fakeRequest("GET"), res);
	await settle();
	assert.equal(res.statusCode, 200);
	const payload = JSON.parse(res.body);
	assert.equal(payload.ok, true);
	assert.equal(payload.files.length, host.FILES.length);

	const res405 = fakeResponse();
	route.handler(fakeRequest("POST", "{}"), res405);
	assert.equal(res405.statusCode, 405);
	assert.equal(res405.headers.allow, "GET");
});

check("import 路由：405 / 415 / 400 / 未知 id / 成功写入", async () => {
	const home = path.join(tempRoot, "route-import-home");
	mountHost(home);
	const route = routeOf(host.internals.IMPORT_PATH);

	const res405 = fakeResponse();
	route.handler(fakeRequest("GET"), res405);
	assert.equal(res405.statusCode, 405);

	const res415 = fakeResponse();
	route.handler(fakeRequest("POST", "{}", "text/plain"), res415);
	assert.equal(res415.statusCode, 415);

	const res400 = fakeResponse();
	route.handler(fakeRequest("POST", "{"), res400);
	await settle();
	assert.equal(res400.statusCode, 400);

	const resUnknown = fakeResponse();
	route.handler(fakeRequest("POST", JSON.stringify({ files: [{ id: "nope", text: "x" }] })), resUnknown);
	await settle();
	assert.equal(resUnknown.statusCode, 400);
	assert.equal(JSON.parse(resUnknown.body).code, "UNKNOWN_FILE");

	const resOk = fakeResponse();
	route.handler(fakeRequest("POST", JSON.stringify({ files: [{ id: "agents", text: "imported" }] })), resOk);
	await settle();
	assert.equal(resOk.statusCode, 200);
	const payload = JSON.parse(resOk.body);
	assert.equal(payload.ok, true);
	assert.equal(payload.results[0].action, "created");
	assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), "imported");
});

check("export 路由：拒绝敏感文件、正常导出内容", async () => {
	const home = path.join(tempRoot, "route-export-home");
	mountHost(home);
	const route = routeOf(host.internals.EXPORT_PATH);
	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(path.join(home, "AGENTS.md"), "rules", "utf8");

	const resSecret = fakeResponse();
	route.handler(fakeRequest("POST", JSON.stringify({ ids: ["credentials"] })), resSecret);
	await settle();
	assert.equal(resSecret.statusCode, 400);
	assert.equal(JSON.parse(resSecret.body).code, "SECRET_NOT_ALLOWED");

	const resOk = fakeResponse();
	route.handler(fakeRequest("POST", JSON.stringify({ ids: ["agents", "pet"] })), resOk);
	await settle();
	const payload = JSON.parse(resOk.body);
	assert.equal(payload.ok, true);
	assert.deepEqual(payload.files.map((file) => file.id), ["agents"], "不存在的文件不该出现在导出里");
	assert.equal(payload.files[0].text, "rules");
	assert.equal(payload.files[0].sha256, host.sha256("rules"));
});

check("栅栏：connection 拒绝时直接结束，不执行 handler 逻辑", async () => {
	const home = path.join(tempRoot, "route-fence-home");
	routes = [];
	const ctx = {
		logger: { info() {} },
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			}
		},
		connection: { requestRejection: () => 403 },
		effect(fn) {
			fn();
		}
	};
	host.apply(ctx);
	const res = fakeResponse();
	routeOf(host.internals.IMPORT_PATH).handler(fakeRequest("POST", JSON.stringify({ files: [{ id: "agents", text: "x" }] })), res);
	assert.equal(res.statusCode, 403);
	assert.equal(res.body, "");
	assert.equal(fs.existsSync(path.join(home, "AGENTS.md")), false);
});
//#endregion

//#region 宿主半区：profile 配置
check("resolveProfileDir：DSH_PROFILE_DIR > profileContext.dir > 兜底目录", () => {
	const explicit = host.resolveProfileDir(null, { DSH_PROFILE_DIR: "D:\\p\\mine" });
	assert.equal(explicit, path.resolve("D:\\p\\mine"));
	const launchedDir = path.join(tempRoot, "launched-profile");
	const launched = host.resolveProfileDir({ get: (name) => (name === "profileContext" ? { dir: launchedDir } : undefined) }, { DSH_HOME: path.join(tempRoot, "h") });
	assert.equal(launched, path.resolve(launchedDir));
	const fallback = host.resolveProfileDir({ get: () => undefined }, { DSH_HOME: path.join(tempRoot, "h") });
	assert.equal(fallback, path.join(path.resolve(path.join(tempRoot, "h")), "profiles", "desktop"));
	const named = host.resolveProfileDir({ get: () => undefined }, { DSH_HOME: path.join(tempRoot, "h"), DSH_PROFILE: "work" });
	assert.equal(named, path.join(path.resolve(path.join(tempRoot, "h")), "profiles", "work"));
});

check("listProfileFiles：递归收集，跳过排除项 / .bak / 符号链接", () => {
	const dir = path.join(tempRoot, "profile-list");
	fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
	fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
	fs.writeFileSync(path.join(dir, "cordis.patch.yml"), "- insert:\n", "utf8");
	fs.writeFileSync(path.join(dir, "package.json.bak"), "old", "utf8");
	fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lock", "utf8");
	fs.writeFileSync(path.join(dir, "node_modules", "x", "index.js"), "x", "utf8");
	fs.writeFileSync(path.join(dir, "sub", "nested.json"), "{}", "utf8");
	assert.deepEqual(host.listProfileFiles(dir).sort(), ["cordis.patch.yml", "package.json", "sub/nested.json"]);
	assert.deepEqual(host.listProfileFiles(path.join(tempRoot, "no-such-profile")), []);
});

check("listProfileFiles：严格卡在上限 256（不会多收一个）", () => {
	const dir = path.join(tempRoot, "profile-cap");
	fs.mkdirSync(path.join(dir, "many"), { recursive: true });
	for (let i = 0; i < host.MAX_PROFILE_FILES + 10; i += 1) {
		fs.writeFileSync(path.join(dir, "many", `f${String(i).padStart(3, "0")}.json`), "{}", "utf8");
	}
	const files = host.listProfileFiles(dir);
	assert.equal(files.length, host.MAX_PROFILE_FILES, `上限就是 ${host.MAX_PROFILE_FILES} 个`);
	assert.equal(new Set(files).size, files.length, "不该有重复条目");
});

check("readProfileManifest：存在性 / 指纹 / 敏感标记", async () => {
	const dir = path.join(tempRoot, "profile-manifest");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
	fs.writeFileSync(path.join(dir, "config.toml"), "k = 1\n", "utf8");
	const manifest = await host.readProfileManifest(dir);
	assert.equal(manifest.dir, dir);
	const byPath = new Map(manifest.files.map((file) => [file.path, file]));
	assert.equal(byPath.get("package.json").exists, true);
	assert.equal(byPath.get("package.json").bytes, 2);
	assert.equal(byPath.get("package.json").sha256, host.sha256("{}"));
	assert.equal(byPath.get("package.json").secret, false);
	assert.equal(byPath.get("config.toml").secret, true, "config.toml 属于敏感配置");
});

check("validateProfileFiles：缺省 / 穿越 / 重复 / 缺目录 / 反斜杠归一化", () => {
	assert.deepEqual(host.validateProfileFiles(undefined, "/p"), { ok: true, items: [] });
	assert.deepEqual(host.validateProfileFiles({ files: [] }, "/p"), { ok: true, items: [] });
	assert.equal(host.validateProfileFiles({ files: [{ path: "../x", text: "a" }] }, "/p").code, "UNSAFE_PATH");
	assert.equal(host.validateProfileFiles({ files: [{ path: "node_modules/a", text: "a" }] }, "/p").code, "UNSAFE_PATH");
	assert.equal(host.validateProfileFiles({ files: [{ path: "/abs", text: "a" }] }, "/p").code, "UNSAFE_PATH");
	assert.equal(host.validateProfileFiles({ files: [{ path: "a.json", text: 1 }] }, "/p").code, "BAD_PROFILE");
	assert.equal(host.validateProfileFiles({ files: "x" }, "/p").code, "BAD_PROFILE");
	assert.equal(
		host.validateProfileFiles(
			{
				files: [
					{ path: "a.json", text: "x" },
					{ path: "a.json", text: "y" }
				]
			},
			"/p"
		).code,
		"DUPLICATE"
	);
	assert.equal(host.validateProfileFiles({ files: [{ path: "a.json", text: "x" }] }, "").code, "NO_PROFILE_DIR");
	const ok = host.validateProfileFiles({ files: [{ path: "sub\\.env", text: "A=1" }] }, "/p");
	assert.equal(ok.ok, true);
	assert.equal(ok.items[0].path, "sub/.env", "反斜杠归一化成正斜杠");
});

check("mergeProfileManifest：deps 取并集（同名以导入为准）、bundles 取并集、dsh 深层以本机为准", () => {
	const current = JSON.stringify({
		name: "dsh-profile-desktop",
		dependencies: { a: "1", b: "2" },
		scripts: { test: "node test/run-tests.mjs" },
		devDependencies: { onlyLocal: "1" },
		dsh: { profile: { bundles: ["a", "local"] }, keep: 1 }
	});
	const incoming = JSON.stringify({ name: "other", dependencies: { b: "9", c: "3" }, dsh: { profile: { bundles: ["a", "new"] } } });
	const merged = host.mergeProfileManifest(current, incoming);
	assert.equal(merged.ok, true);
	const text = JSON.parse(merged.text);
	assert.equal(text.name, "other", "两边都有的字段：导入文件优先");
	assert.deepEqual(text.dependencies, { a: "1", b: "9", c: "3" });
	assert.deepEqual(text.dsh.profile.bundles, ["a", "local", "new"]);
	assert.equal(text.dsh.keep, 1, "dsh 下本机独有的字段不能丢");
	assert.deepEqual(text.scripts, { test: "node test/run-tests.mjs" }, "本机独有的顶层字段不能丢");
	assert.deepEqual(text.devDependencies, { onlyLocal: "1" }, "本机独有的顶层字段不能丢");
	assert.deepEqual(merged.addedDependencies, ["c"]);
	assert.deepEqual(merged.addedBundles, ["new"]);
	assert.equal(host.mergeProfileManifest(current, "{").code, "BAD_PACKAGE_JSON");
	const fresh = host.mergeProfileManifest(null, incoming);
	assert.equal(fresh.ok, true);
	assert.equal(JSON.parse(fresh.text).dependencies.b, "9");
});

check("applyProfileWrites：package.json 合并、其它整文件写、都留备份", async () => {
	const dir = path.join(tempRoot, "profile-write");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "here", dependencies: { a: "1" } }), "utf8");
	const results = await host.applyProfileWrites(
		dir,
		[
			{ path: "package.json", text: JSON.stringify({ name: "from-backup", dependencies: { b: "2" } }) },
			{ path: "cordis.patch.yml", text: "- insert:\n" },
			{ path: "sub/inner.json", text: "{}" }
		],
		"STAMP"
	);
	const byPath = new Map(results.map((result) => [result.path, result]));
	assert.equal(byPath.get("package.json").action, "written");
	assert.equal(byPath.get("package.json").backup, path.join(dir, "package.json.bak-settings-sync-STAMP"));
	assert.deepEqual(byPath.get("package.json").merged.addedDependencies, ["b"]);
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
	assert.equal(manifest.name, "from-backup");
	assert.deepEqual(manifest.dependencies, { a: "1", b: "2" });
	assert.equal(byPath.get("cordis.patch.yml").action, "created");
	assert.equal(byPath.get("cordis.patch.yml").backup, null);
	assert.equal(fs.readFileSync(path.join(dir, "sub", "inner.json"), "utf8"), "{}");
	const again = await host.applyProfileWrites(dir, [{ path: "sub/inner.json", text: "{}" }], "STAMP");
	assert.equal(again[0].action, "unchanged");
	const bad = await host.applyProfileWrites(dir, [{ path: "package.json", text: "{" }], "STAMP");
	assert.equal(bad[0].action, "skipped");
	assert.ok(bad[0].reason.includes("package.json"));
});

check("市场格式互通：本插件能读进来，也能产出一份", () => {
	const backup = {
		format: "dsh-profile-backup",
		version: 0.2,
		createdAt: "T",
		profile: "desktop",
		files: [
			{ path: "package.json", json: { name: "x" } },
			{ path: "a.yml", lines: ["1", "2"] }
		]
	};
	const converted = host.profileFilesFromMarketBackup(backup);
	assert.equal(converted.profile, "desktop");
	assert.equal(converted.createdAt, "T");
	assert.deepEqual(converted.items.map((item) => item.path), ["package.json", "a.yml"]);
	assert.equal(converted.items[1].text, "1\n2");
	assert.equal(host.profileFilesFromMarketBackup({ format: "other" }), null);
	assert.throws(() => host.profileFilesFromMarketBackup({ format: "dsh-profile-backup", version: 0.2, files: [{ path: "a", lines: [1] }] }), /内容不合法/);
	const out = host.marketBackupOf(
		"desktop",
		[
			{ path: "package.json", text: "{\"name\":\"x\"}" },
			{ path: "a.yml", text: "1\n2" }
		],
		"T"
	);
	assert.deepEqual(out, {
		format: "dsh-profile-backup",
		version: 0.2,
		createdAt: "T",
		profile: "desktop",
		files: [
			{ path: "package.json", json: { name: "x" } },
			{ path: "a.yml", lines: ["1", "2"] }
		]
	});
	assert.equal(host.profileNameOf(path.join(tempRoot, "profiles", "desktop")), "desktop");
});

check("packageManagerOf：启动器发布 > 环境变量 > 运行时；都没有就是 null", () => {
	const emptyHome = { DSH_HOME: path.join(tempRoot, "no-runtimes-here") };
	const launched = host.packageManagerOf(
		{ get: (name) => (name === "profileContext" ? { packageManager: { command: "node", args: ["pnpm.mjs"], env: { FOO: "1", BAD: 2 } } } : undefined) },
		emptyHome
	);
	assert.deepEqual(launched, { command: "node", args: ["pnpm.mjs"], env: { FOO: "1" }, source: "launcher" });
	assert.equal(host.packageManagerOf({ get: () => ({ packageManager: { command: "", args: [] } }) }, emptyHome), null);
	assert.equal(host.packageManagerOf({ get: () => ({ packageManager: { command: "node", args: "x" } }) }, emptyHome), null);
	assert.equal(host.packageManagerOf({}, emptyHome), null, "三条都拿不到就该老实说没有");
	assert.equal(host.packageManagerOf({}, { ...emptyHome, DSH_SETTINGS_SYNC_PNPM: path.join(tempRoot, "nope.mjs") }), null);
	const fakePnpm = path.join(tempRoot, "fake-pnpm.mjs");
	fs.writeFileSync(fakePnpm, "", "utf8");
	const viaEnv = host.packageManagerOf({}, { ...emptyHome, DSH_SETTINGS_SYNC_PNPM: fakePnpm });
	assert.equal(viaEnv.source, "env");
	assert.deepEqual(viaEnv.args, [fakePnpm]);
});

check("findRuntimePnpm：认出 $DSH_HOME/dsh-runtimes 下的 node + pnpm", () => {
	const home = path.join(tempRoot, "runtime-home");
	const base = path.join(home, "dsh-runtimes", "primary", "dependencies");
	fs.mkdirSync(path.join(base, "pnpm", "bin"), { recursive: true });
	fs.mkdirSync(path.join(base, "node", "bin"), { recursive: true });
	fs.writeFileSync(path.join(base, "pnpm", "bin", "pnpm.mjs"), "", "utf8");
	fs.writeFileSync(path.join(base, "node", "bin", process.platform === "win32" ? "node.exe" : "node"), "", "utf8");
	const found = host.findRuntimePnpm({ DSH_HOME: home });
	assert.ok(found);
	assert.equal(found.pnpm, path.join(base, "pnpm", "bin", "pnpm.mjs"));
	assert.equal(host.findRuntimePnpm({ DSH_HOME: path.join(tempRoot, "empty-home") }), null);
});

check("manifest 路由：带 profile 目录时多返回 profile 一栏", async () => {
	const home = path.join(tempRoot, "route-profile-home");
	const profileDir = path.join(tempRoot, "route-profile-dir");
	fs.mkdirSync(profileDir, { recursive: true });
	fs.writeFileSync(path.join(profileDir, "package.json"), "{\"name\":\"p\"}", "utf8");
	mountHost(home, { profileDir, services: { profileContext: { dir: profileDir } } });
	const res = fakeResponse();
	routeOf(host.internals.MANIFEST_PATH).handler(fakeRequest("GET"), res);
	await settle();
	assert.equal(res.statusCode, 200);
	const payload = JSON.parse(res.body);
	assert.equal(payload.profile.dir, profileDir);
	assert.ok(payload.profile.files.some((file) => file.path === "package.json"));
});

check("export 路由：includeProfile 时给 profile 与市场格式", async () => {
	const home = path.join(tempRoot, "route-export-profile-home");
	const profileDir = path.join(tempRoot, "route-export-profile-dir");
	fs.mkdirSync(profileDir, { recursive: true });
	fs.writeFileSync(path.join(profileDir, "package.json"), "{\"name\":\"p\"}", "utf8");
	fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), "- insert:\n", "utf8");
	mountHost(home, { profileDir, services: { profileContext: { dir: profileDir } } });
	const res = fakeResponse();
	routeOf(host.internals.EXPORT_PATH).handler(fakeRequest("POST", JSON.stringify({ ids: [], includeProfile: true })), res);
	await settle();
	const payload = JSON.parse(res.body);
	assert.equal(payload.ok, true);
	assert.equal(payload.profile.name, path.basename(profileDir));
	assert.deepEqual(payload.profile.files.map((file) => file.path).sort(), ["cordis.patch.yml", "package.json"]);
	assert.equal(payload.market.format, "dsh-profile-backup");
	assert.equal(payload.market.version, 0.2);
	assert.equal(payload.market.files.find((file) => file.path === "package.json").json.name, "p");
	assert.equal(payload.market.files.find((file) => file.path === "cordis.patch.yml").lines[0], "- insert:");
});

check("import 路由：profile 里的 package.json 走合并，不丢本机原有插件", async () => {
	const home = path.join(tempRoot, "route-import-profile-home");
	const profileDir = path.join(tempRoot, "route-import-profile-dir");
	fs.mkdirSync(profileDir, { recursive: true });
	fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({ name: "local", dependencies: { local: "1" } }), "utf8");
	mountHost(home, { profileDir, services: { profileContext: { dir: profileDir } } });
	const body = JSON.stringify({
		files: [{ id: "agents", text: "imported" }],
		profile: {
			files: [
				{ path: "package.json", text: JSON.stringify({ name: "from-backup", dependencies: { incoming: "2" } }) },
				{ path: "cordis.patch.yml", text: "- insert:\n" }
			]
		}
	});
	const res = fakeResponse();
	routeOf(host.internals.IMPORT_PATH).handler(fakeRequest("POST", body), res);
	await settle();
	assert.equal(res.statusCode, 200);
	const payload = JSON.parse(res.body);
	assert.equal(payload.ok, true);
	assert.equal(payload.results[0].action, "created");
	assert.ok(payload.profileResults.some((result) => result.path === "package.json" && result.action === "written"));
	const merged = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8"));
	assert.equal(merged.name, "from-backup");
	assert.deepEqual(merged.dependencies, { local: "1", incoming: "2" });
	assert.equal(fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8"), "- insert:\n");
	assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), "imported");
});

check("import 路由：整份市场备份可以直接丢进来", async () => {
	const home = path.join(tempRoot, "route-market-home");
	const profileDir = path.join(tempRoot, "route-market-dir");
	fs.mkdirSync(profileDir, { recursive: true });
	mountHost(home, { profileDir, services: { profileContext: { dir: profileDir } } });
	const body = JSON.stringify({
		format: "dsh-profile-backup",
		version: 0.2,
		createdAt: "T",
		profile: "desktop",
		files: [{ path: "a.yml", lines: ["x", "y"] }]
	});
	const res = fakeResponse();
	routeOf(host.internals.IMPORT_PATH).handler(fakeRequest("POST", body), res);
	await settle();
	assert.equal(res.statusCode, 200);
	const payload = JSON.parse(res.body);
	assert.equal(payload.results.length, 0);
	assert.equal(payload.profileResults[0].path, "a.yml");
	assert.equal(fs.readFileSync(path.join(profileDir, "a.yml"), "utf8"), "x\ny");
});

check("import 路由：profile 路径穿越被拒绝，且一个字节都不写", async () => {
	const home = path.join(tempRoot, "route-escape-home");
	const profileDir = path.join(tempRoot, "route-escape-dir");
	fs.mkdirSync(profileDir, { recursive: true });
	mountHost(home, { profileDir, services: { profileContext: { dir: profileDir } } });
	const body = JSON.stringify({ profile: { files: [{ path: "../escape.txt", text: "x" }] } });
	const res = fakeResponse();
	routeOf(host.internals.IMPORT_PATH).handler(fakeRequest("POST", body), res);
	await settle();
	assert.equal(res.statusCode, 400);
	assert.equal(JSON.parse(res.body).code, "UNSAFE_PATH");
	assert.equal(fs.existsSync(path.join(tempRoot, "escape.txt")), false);

	const empty = fakeResponse();
	routeOf(host.internals.IMPORT_PATH).handler(fakeRequest("POST", "{}"), empty);
	await settle();
	assert.equal(empty.statusCode, 400);
	assert.equal(JSON.parse(empty.body).code, "EMPTY");
});

check("install 路由：没有包管理器时给出可照抄的命令", async () => {
	const home = path.join(tempRoot, "route-install-home");
	const profileDir = path.join(tempRoot, "route-install-dir");
	fs.mkdirSync(profileDir, { recursive: true });
	mountHost(home, { profileDir, services: { profileContext: { dir: profileDir } } });
	const res = fakeResponse();
	routeOf(host.internals.INSTALL_PATH).handler(fakeRequest("POST", "{}"), res);
	await settle();
	assert.equal(res.statusCode, 200);
	const payload = JSON.parse(res.body);
	assert.equal(payload.ok, false);
	assert.equal(payload.code, "NO_PACKAGE_MANAGER");
	assert.ok(payload.message.includes("pnpm install"));
	assert.ok(payload.message.includes(profileDir));

	const res405 = fakeResponse();
	routeOf(host.internals.INSTALL_PATH).handler(fakeRequest("GET"), res405);
	assert.equal(res405.statusCode, 405);
	assert.equal(res405.headers.allow, "POST");

	const res415 = fakeResponse();
	routeOf(host.internals.INSTALL_PATH).handler(fakeRequest("POST"), res415);
	await settle();
	assert.equal(res415.statusCode, 415, "没有 content-type: application/json 就拒掉");
	assert.equal(JSON.parse(res415.body).code, "UNSUPPORTED_MEDIA_TYPE");
});

check("install 路由：有包管理器时真的跑一次并回传输出", async () => {
	const home = path.join(tempRoot, "route-install-run-home");
	const profileDir = path.join(tempRoot, "route-install-run-dir");
	fs.mkdirSync(profileDir, { recursive: true });
	const script = path.join(tempRoot, "fake-pnpm.mjs");
	fs.writeFileSync(script, "console.log(`fake install ${process.argv.slice(2).join(' ')}`);\n", "utf8");
	mountHost(home, {
		profileDir,
		services: { profileContext: { dir: profileDir, packageManager: { command: process.execPath, args: [script] } } }
	});
	const res = fakeResponse();
	routeOf(host.internals.INSTALL_PATH).handler(fakeRequest("POST", "{}"), res);
	await settle();
	await settle();
	assert.equal(res.statusCode, 200);
	const payload = JSON.parse(res.body);
	assert.equal(payload.code, "INSTALLED");
	assert.equal(payload.ok, true);
	assert.equal(payload.exitCode, 0);
	assert.equal(payload.source, "launcher");
	assert.ok(payload.output.includes("fake install install --prefer-offline"), `输出该带上真实参数：${payload.output}`);
	assert.equal(payload.profileDir, profileDir);
});
//#endregion

//#region 跑全部用例
for (const runner of runners) await runner();
for (const cleanup of cleanups.splice(0)) cleanup();
restoreEnv();
fs.rmSync(tempRoot, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
for (const result of results) {
	if (result.ok) console.log(`  ok  ${result.name}`);
	else console.log(`FAIL  ${result.name}\n${result.error}\n`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
//#endregion
