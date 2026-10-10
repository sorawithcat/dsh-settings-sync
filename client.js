/**
 * 设置同步插件 · 浏览器半区
 *
 * 一个普通 JS 客户端插件（无构建步骤）：宿主加载本文件时只提供 `react`，所以界面全部
 * 用 `react.createElement` 手写，样式只用 DSH 的主题 token（`--dsw-alias-*` /
 * `--dsw-static-*`），不 import 任何 Harness 客户端包。
 *
 * 职责划分：
 *   - 配置文件（`$DSH_HOME` 根目录 + `storages/`）由宿主半区读写，见 `./index.js`；
 *   - 浏览器本地数据（localStorage）只有这里能碰，所以导出时由这里合并进同一个 JSON。
 *
 * 结构：常量 → 主题 token 与样式 → 纯逻辑（可单测）→ 宿主接口 → 界面 → apply(ctx)。
 */
window.__ModuleLoader__.load({
	id: "dsh-settings-sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const e = react.createElement;
		const useState = react.useState;
		const useEffect = react.useEffect;
		const useRef = react.useRef;

		//#region 常量
		/** 插件名 / 设置页席位 id。 */
		const PLUGIN_ID = "dsh-settings-sync";
		const SECTION_ID = "settings-sync";
		/** 排在健康提醒（60）后面。 */
		const SECTION_ORDER = 61;
		/** 宿主路由前缀。 */
		const API = "/dsh-settings-sync";
		/** 导出文件的格式标识与版本。 */
		const FORMAT = "dsh-settings-sync";
		const FORMAT_VERSION = 1;
		/** 单个值（文件内容 / 一个 localStorage 值）上限。 */
		const MAX_TEXT = 1024 * 1024;
		/** 单个导出 / 导入文件上限。 */
		const MAX_TOTAL = 8 * 1024 * 1024;
		/** 条目数上限。 */
		const MAX_KEYS = 500;
		const MAX_FILES = 64;
		/** 本插件自己的记录（上次导出时间），永远不参与同步。 */
		const LAST_KEY = `${PLUGIN_ID}/last.v1`;
		/** 会话级草稿：换台机器没有意义，默认不勾选。 */
		const SESSION_KEY = /^dsh\.(conversation|sidebar-right|user-questions\.drafts)\./;
		/** 本插件自己的键永不同步（否则会把「上次导出时间」也搬走）。 */
		const OWN_KEY_PREFIX = `${PLUGIN_ID}/`;
		/** profile 配置（插件清单等）的条目上限，与宿主半区一致。 */
		const MAX_PROFILE = 256;
		/** 插件市场（dshmarket）备份格式：这样一份备份可以直接丢进来。 */
		const MARKET_FORMAT = "dsh-profile-backup";
		const MARKET_VERSION = 0.2;

		const T = {
			fg: "var(--dsw-alias-label-primary, #0f1115)",
			fg2: "var(--dsw-alias-label-secondary, #61666b)",
			fg3: "var(--dsw-alias-label-tertiary, #81858c)",
			caption: "var(--dsw-alias-label-caption, #adb2b8)",
			line: "var(--dsw-alias-border-l2, rgba(0,0,0,0.1))",
			lineStrong: "var(--dsw-alias-border-l4, rgba(0,0,0,0.16))",
			card: "var(--dsw-alias-button-elevated-fill, #fff)",
			hover: "var(--dsw-alias-button-floating-hover, #f1f3f5)",
			brand: "var(--dsw-alias-brand-primary, #3b82f6)",
			onBrand: "var(--dsw-alias-label-primary-inverted, #fff)",
			warn: "var(--dsw-static-amber-500, #f59e0b)",
			ok: "var(--dsw-static-green-500, #22c55e)",
			info: "var(--dsw-static-blue-450, #4d93f8)"
		};

		const S = {
			page: { padding: "18px 20px 40px", maxWidth: 880, margin: "0 auto", color: T.fg, fontSize: 13, lineHeight: 1.6, boxSizing: "border-box", colorScheme: "inherit" },
			header: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", margin: "0 0 12px" },
			title: { fontSize: 16, fontWeight: 600, color: T.fg, margin: 0, letterSpacing: "0.01em" },
			subtitle: { fontSize: 12, color: T.fg3 },
			card: { background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: "14px 16px", marginBottom: 12, boxSizing: "border-box" },
			cardTitle: { fontSize: 13, fontWeight: 600, color: T.fg, marginBottom: 10, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
			cardNote: { fontSize: 11, fontWeight: 400, color: T.caption },
			row: { display: "flex", alignItems: "center", gap: 10, padding: "5px 0", minWidth: 0 },
			rowLabel: { color: T.fg, fontSize: 12.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			rowDetail: { color: T.caption, fontSize: 11 },
			rowMeta: { marginLeft: "auto", color: T.fg3, fontSize: 11.5, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
			mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 11.5, wordBreak: "break-all" },
			actions: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 2 },
			btnPrimary: { border: "none", background: T.brand, color: T.onBrand, borderRadius: 8, padding: "6px 14px", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" },
			btnSoft: { border: `1px solid ${T.line}`, background: T.hover, color: T.fg, borderRadius: 8, padding: "6px 12px", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" },
			btnGhost: { border: "none", background: "transparent", color: T.fg2, borderRadius: 8, padding: "5px 8px", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" },
			btnDanger: { border: "none", background: T.warn, color: "#fff", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" },
			hint: { color: T.caption, fontSize: 12 },
			secretNote: { color: T.warn, fontSize: 12, lineHeight: "17px", border: `1px solid ${T.warn}`, borderRadius: 8, padding: "6px 8px", marginBottom: 8 },
			secretBadge: { display: "inline-block", marginLeft: 6, borderRadius: 999, padding: "0 6px", fontSize: 10.5, lineHeight: "15px", color: T.warn, border: `1px solid ${T.warn}` },
			status: { fontSize: 12.5, marginTop: 8, wordBreak: "break-word" },
			badge: { display: "inline-block", borderRadius: 999, padding: "1px 8px", fontSize: 11, lineHeight: "16px", border: `1px solid ${T.line}` },
			confirmLayer: { position: "fixed", inset: 0, zIndex: 2147483200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, boxSizing: "border-box" },
			confirmBackdrop: { position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)" },
			confirmCard: { position: "relative", width: 520, maxWidth: "94vw", maxHeight: "86vh", display: "flex", flexDirection: "column", background: T.card, border: `1px solid ${T.lineStrong}`, borderRadius: 14, boxShadow: "0 18px 48px rgba(0,0,0,0.35)", padding: 16, color: T.fg, fontSize: 13, boxSizing: "border-box", colorScheme: "inherit" },
			confirmBody: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", margin: "10px 0" }
		};
		//#endregion

		//#region 纯逻辑（自测直接跑这些）
		/** 一个 localStorage 键属于哪一类：本插件自己的 / 会话草稿 / 可同步状态。 */
		function scopeOf(key) {
			if (typeof key !== "string" || key === "") return "own";
			if (key.startsWith(OWN_KEY_PREFIX)) return "own";
			if (SESSION_KEY.test(key)) return "session";
			return "state";
		}

		/** 上一次读 localStorage 是否整个失败（隐私模式等）；界面据此换一句话，而不是假装「本机什么都没有」。 */
		let localReadFailed = false;
		function localReadFailedFlag() {
			return localReadFailed;
		}

		/** 读 localStorage：读不到的键跳过；隐私模式抛异常时返回空表而不是炸掉界面。 */
		function readLocalEntries() {
			const out = [];
			try {
				localReadFailed = false;
				const keys = [];
				for (let i = 0; i < localStorage.length; i += 1) {
					const key = localStorage.key(i);
					if (typeof key === "string") keys.push(key);
				}
				keys.sort();
				for (const key of keys) {
					if (out.length >= MAX_KEYS) break;
					const scope = scopeOf(key);
					if (scope === "own") continue;
					const value = localStorage.getItem(key);
					if (typeof value !== "string") continue;
					if (value.length > MAX_TEXT) continue;
					out.push({ key, value, bytes: value.length, scope });
				}
			} catch (error) {
				localReadFailed = true;
				console.warn("[settings-sync] 读本地存储失败:", error);
			}
			return out;
		}

		/** 组装导出文件（纯函数，方便自测比较形状）。 */
		function buildExport({ home, origin, files, storage, exportedAt, profile, market }) {
			const profileFiles = (profile ?? []).map((file) => ({
				path: String(file.path),
				secret: file.secret === true,
				sha256: typeof file.sha256 === "string" ? file.sha256 : null,
				text: String(file.text ?? "")
			}));
			return {
				format: FORMAT,
				version: FORMAT_VERSION,
				exportedAt: typeof exportedAt === "string" ? exportedAt : new Date().toISOString(),
				app: "dsh-desktop",
				home: typeof home === "string" ? home : null,
				origin: typeof origin === "string" ? origin : null,
				files: (files ?? []).map((file) => ({
					id: String(file.id),
					rel: typeof file.rel === "string" ? file.rel : null,
					label: typeof file.label === "string" ? file.label : null,
					secret: file.secret === true,
					sha256: typeof file.sha256 === "string" ? file.sha256 : null,
					text: String(file.text ?? "")
				})),
				browser: {
					storage: (storage ?? []).map((item) => ({ key: String(item.key), value: String(item.value), scope: scopeOf(item.key) }))
				},
				profile: profileFiles,
				// 同一份 profile 配置再给一份市场格式，方便直接喂给「插件市场 → 备份与恢复」。
				market: market && typeof market === "object" ? market : null
			};
		}

		/**
		 * 市场备份（`dsh-profile-backup` 0.2）→ profile 条目。
		 * 不是市场格式返回 null；是但内容不合法返回 `{ error }`——宁可整份拒绝，也不写半份。
		 */
		function marketProfileEntries(raw) {
			if (!raw || typeof raw !== "object") return null;
			if (raw.format !== MARKET_FORMAT || Number(raw.version) !== MARKET_VERSION || !Array.isArray(raw.files)) return null;
			if (raw.files.length > MAX_PROFILE) return { error: { code: "TOO_MANY", message: "市场备份里的条目太多" } };
			const entries = [];
			for (const file of raw.files) {
				if (!file || typeof file.path !== "string" || file.path === "") {
					return { error: { code: "BAD_ITEM", message: "市场备份里有条目缺少 path" } };
				}
				if (file.path === "package.json") {
					const json = file.json;
					if (!json || typeof json !== "object" || Array.isArray(json)) {
						return { error: { code: "BAD_ITEM", message: "市场备份里的 package.json 不是一个对象" } };
					}
					entries.push({ path: "package.json", text: `${JSON.stringify(json, null, 2)}\n`, secret: false });
					continue;
				}
				if (!Array.isArray(file.lines) || !file.lines.every((line) => typeof line === "string")) {
					return { error: { code: "BAD_ITEM", message: `市场备份里的 ${file.path} 内容不合法` } };
				}
				entries.push({ path: file.path, text: file.lines.join("\n"), secret: PROFILE_SECRET_HINTS.test(file.path) });
			}
			return { entries, createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null };
		}

		/** profile 配置里的固定排除项（与市场备份一致，也是宿主半区的口径）。 */
		const PROFILE_EXCLUDED = new Set(["node_modules", ".dsh-market", ".git", "pnpm-lock.yaml"]);

		/** 文件名看着就含密钥的 profile 配置（与宿主半区 `PROFILE_SECRET_HINTS` 同一条）。 */
		const PROFILE_SECRET_HINTS = /(^|\/)(config\.toml|\.env(\.\w+)?|secrets?\.\w+t?j?s?o?n|pnpm-workspace\.yaml)$/i;

		/** 校验一条 profile 条目（路径不能跑出 profile，文本必须是字符串且不超限）。 */
		function profileEntryProblem(path, text) {
			if (typeof path !== "string" || path === "") return "路径是空的";
			if (path.length > 300) return "路径太长";
			if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path)) return "不能是绝对路径";
			const parts = path.split("/");
			if (parts.some((part) => part === "" || part === "." || part === "..")) return "路径里不能有 . / .. / 空段";
			if (parts.some((part) => PROFILE_EXCLUDED.has(part))) return "这个路径属于排除范围";
			if (typeof text !== "string") return "内容必须是字符串";
			if (text.length > MAX_TEXT) return "内容超过 1 MB";
			return null;
		}

		/** 解析并校验导入文件；不认识的东西一律拒绝，绝不半信半疑地写盘。 */
		function parsePayload(text) {
			if (typeof text !== "string" || text.length > MAX_TOTAL) return { ok: false, code: "TOO_LARGE", message: "文件太大" };
			let raw;
			try {
				raw = JSON.parse(text);
			} catch {
				return { ok: false, code: "BAD_JSON", message: "不是有效的 JSON 文件" };
			}
			if (!raw || typeof raw !== "object") return { ok: false, code: "BAD_FORMAT", message: "内容不是一个对象" };
			// 整份市场备份也能直接导入：它只描述 profile 配置，`$DSH_HOME` 与浏览器数据不在里面。
			const market = marketProfileEntries(raw);
			if (market !== null) {
				if (market.error) return { ok: false, ...market.error };
				if (market.entries.length === 0) return { ok: false, code: "EMPTY", message: "市场备份里没有任何文件" };
				return {
					ok: true,
					payload: {
						market: true,
						exportedAt: market.createdAt,
						home: null,
						version: FORMAT_VERSION,
						files: [],
						storage: [],
						profile: market.entries.map((entry) => ({ path: entry.path, secret: entry.secret === true, text: entry.text }))
					}
				};
			}
			if (raw.format !== FORMAT) return { ok: false, code: "BAD_FORMAT", message: `不是本插件导出的文件（format=${String(raw.format)}）` };
			const version = Number(raw.version);
			if (!Number.isInteger(version) || version < 1 || version > FORMAT_VERSION) {
				return { ok: false, code: "BAD_VERSION", message: `版本不认识：${String(raw.version)}` };
			}
			const rawFiles = Array.isArray(raw.files) ? raw.files : [];
			if (rawFiles.length > MAX_FILES) return { ok: false, code: "TOO_MANY", message: "文件条目太多" };
			const files = [];
			for (const item of rawFiles) {
				if (!item || typeof item.id !== "string" || item.id === "" || typeof item.text !== "string") {
					return { ok: false, code: "BAD_ITEM", message: "文件条目缺少 id / text" };
				}
				if (item.text.length > MAX_TEXT) return { ok: false, code: "TOO_LARGE", message: `文件内容超过 1 MB：${item.id}` };
				files.push({
					id: item.id,
					rel: typeof item.rel === "string" ? item.rel : null,
					label: typeof item.label === "string" ? item.label : null,
					secret: item.secret === true,
					text: item.text
				});
			}
			const rawStorage = raw.browser && Array.isArray(raw.browser.storage) ? raw.browser.storage : [];
			if (rawStorage.length > MAX_KEYS) return { ok: false, code: "TOO_MANY", message: "浏览器数据条目太多" };
			const storage = [];
			for (const item of rawStorage) {
				if (!item || typeof item.key !== "string" || item.key === "" || typeof item.value !== "string") {
					return { ok: false, code: "BAD_ITEM", message: "浏览器数据条目缺少 key / value" };
				}
				if (item.value.length > MAX_TEXT) return { ok: false, code: "TOO_LARGE", message: `值超过 1 MB：${item.key}` };
				if (scopeOf(item.key) === "own") continue;
				storage.push({ key: item.key, value: item.value, scope: scopeOf(item.key) });
			}
			const rawProfile = Array.isArray(raw.profile) ? raw.profile : raw.profile && typeof raw.profile === "object" && Array.isArray(raw.profile.files) ? raw.profile.files : [];
			if (rawProfile.length > MAX_PROFILE) return { ok: false, code: "TOO_MANY", message: "profile 条目太多" };
			const profile = [];
			const seenProfile = new Set();
			for (const item of rawProfile) {
				const path = item && typeof item.path === "string" ? item.path.replaceAll("\\", "/").trim() : "";
				const problem = profileEntryProblem(path, item?.text);
				if (problem !== null) return { ok: false, code: "BAD_ITEM", message: `${problem}：${path || String(item?.path)}` };
				if (seenProfile.has(path)) return { ok: false, code: "BAD_ITEM", message: `重复的 profile 路径：${path}` };
				seenProfile.add(path);
				profile.push({ path, secret: item.secret === true, text: item.text });
			}
			if (files.length === 0 && storage.length === 0 && profile.length === 0) return { ok: false, code: "EMPTY", message: "文件里没有任何可导入的内容" };
			return {
				ok: true,
				payload: {
					market: false,
					exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : null,
					home: typeof raw.home === "string" ? raw.home : null,
					version,
					files,
					storage,
					profile
				}
			};
		}

		/**
		 * 逐项对比「导入文件里的内容」和「本机现状」，给预览用。
		 * `currentFiles` / `currentProfile` 是本机同名文件的当前内容（宿主给），拿不到就按「覆盖」显示。
		 * profile 里的 `package.json` 走合并（不覆盖本机原有插件），所以单独给一个动作。
		 */
		function previewRows(payload, manifest, currentFiles, localEntries, currentProfile) {
			const byId = new Map((manifest?.files ?? []).map((file) => [file.id, file]));
			const textById = new Map((currentFiles ?? []).map((file) => [file.id, file.text]));
			const localByKey = new Map((localEntries ?? []).map((item) => [item.key, item.value]));
			const profileByPath = new Map((manifest?.profile?.files ?? []).map((file) => [file.path, file]));
			const currentProfileText = new Map((currentProfile ?? []).map((file) => [file.path, file.text]));
			const rows = [];
			for (const item of payload.files) {
				const meta = byId.get(item.id);
				if (meta === undefined) {
					rows.push({ section: "file", id: item.id, label: item.rel ?? item.id, detail: "本插件不认识这个文件", action: "unknown", bytes: item.text.length });
					continue;
				}
				const known = textById.has(item.id);
				const same = textById.get(item.id) === item.text;
				rows.push({
					section: "file",
					id: item.id,
					label: meta.label ?? meta.rel,
					detail: meta.rel,
					secret: meta.secret === true || item.secret === true,
					action: same ? "same" : meta.exists ? (known ? "update" : "update?") : "add",
					bytes: item.text.length
				});
			}
			for (const item of payload.profile ?? []) {
				const meta = profileByPath.get(item.path);
				const same = currentProfileText.get(item.path) === item.text;
				const merge = item.path === "package.json" && !same;
				rows.push({
					section: "profile",
					id: item.path,
					label: item.path,
					detail: merge ? "插件清单合并" : meta && meta.exists ? "" : "本机没有这个文件",
					secret: item.secret === true || meta?.secret === true || PROFILE_SECRET_HINTS.test(item.path),
					action: same ? "same" : merge ? "merge" : meta && meta.exists === false ? "add" : meta ? "update" : "update?",
					bytes: item.text.length
				});
			}
			for (const item of payload.storage) {
				const known = localByKey.has(item.key);
				const same = localByKey.get(item.key) === item.value;
				rows.push({
					section: "browser",
					id: item.key,
					label: item.key,
					detail: item.scope === "session" ? "会话草稿" : "",
					action: same ? "same" : known ? "update" : "add",
					bytes: item.value.length
				});
			}
			return rows;
		}

		/** 写 localStorage；单个键失败不影响其余。 */
		function applyStorage(storage) {
			let written = 0;
			let skipped = 0;
			for (const item of storage ?? []) {
				try {
					localStorage.setItem(item.key, item.value);
					written += 1;
				} catch (error) {
					skipped += 1;
					console.warn(`[settings-sync] 写本地存储失败：${item.key}`, error);
				}
			}
			return { written, skipped };
		}

		/** 人类可读的字节数。 */
		function formatBytes(bytes) {
			const value = Number(bytes);
			if (!Number.isFinite(value) || value < 0) return "—";
			if (value < 1024) return `${value} B`;
			if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
			return `${(value / 1024 / 1024).toFixed(1)} MB`;
		}

		/** 导出文件名（本地时间）。 */
		function exportFileName(date = new Date()) {
			const pad = (n) => String(n).padStart(2, "0");
			return `dsh-settings-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
		}

		/** 市场格式备份的文件名（插件市场默认认这个形状的文件）。 */
		function marketFileName(date = new Date()) {
			const pad = (n) => String(n).padStart(2, "0");
			return `dsh-profile-backup-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
		}

		/** 一个 ISO 时间戳 → 本地可读时间。 */
		function readableTime(iso) {
			if (typeof iso !== "string" || iso === "") return null;
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return null;
			return date.toLocaleString("zh-CN", { hour12: false });
		}

		/** 上次导出 / 导入的记录（只存在本机，不参与同步）。 */
		function readLastRun() {
			try {
				const raw = localStorage.getItem(LAST_KEY);
				if (typeof raw !== "string") return null;
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") return null;
				return { kind: typeof parsed.kind === "string" ? parsed.kind : null, at: typeof parsed.at === "string" ? parsed.at : null };
			} catch {
				return null;
			}
		}

		function rememberRun(kind, payloadExportedAt) {
			try {
				localStorage.setItem(LAST_KEY, JSON.stringify({ kind, at: new Date().toISOString(), payloadExportedAt: payloadExportedAt ?? null }));
			} catch {
				/* 记不住也不影响功能 */
			}
		}
		//#endregion

		//#region 宿主接口
		/** 发一个 JSON 请求给宿主半区，返回解析后的 body（非 2xx 抛错）。 */
		async function hostJson(path, init) {
			const response = await fetch(path, init);
			let payload = null;
			try {
				const text = await response.text();
				payload = text === "" ? null : JSON.parse(text);
			} catch {
				payload = null;
			}
			if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
			if (payload && payload.ok === false) throw new Error(payload.message ?? payload.code ?? "宿主返回失败");
			return payload;
		}

		/** 拉清单（哪些文件存在、多大）。 */
		async function fetchManifest() {
			return await hostJson(`${API}/manifest`, { method: "GET" });
		}

		/** 一次导出请求（可带 profile 配置与市场格式）。 */
		async function exportRequest(body) {
			return await hostJson(`${API}/export`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
		}

		/** 取回本机某些文件的当前内容（用于导出，也用于导入前的对比）。 */
		async function fetchFiles(ids, allowSecrets) {
			if (!Array.isArray(ids) || ids.length === 0) return [];
			const payload = await exportRequest({ ids, allowSecrets: allowSecrets === true });
			return Array.isArray(payload?.files) ? payload.files : [];
		}

		/** 取回 profile 配置的当前内容（用于导出，也用于导入前的对比）。 */
		async function fetchProfile(paths) {
			if (!Array.isArray(paths) || paths.length === 0) return { files: [], market: null, name: null, dir: null };
			const payload = await exportRequest({ ids: [], includeProfile: true, profilePaths: paths });
			return {
				files: Array.isArray(payload?.profile?.files) ? payload.profile.files : [],
				market: payload?.market ?? null,
				name: typeof payload?.profile?.name === "string" ? payload.profile.name : null,
				dir: typeof payload?.profile?.dir === "string" ? payload.profile.dir : null
			};
		}

		/** 写回文件与 profile 配置；宿主会先把 profile 清单落地，再写 `$DSH_HOME`。 */
		async function postImport(files, profile) {
			const body = { files: (files ?? []).map((file) => ({ id: file.id, text: file.text })) };
			if (Array.isArray(profile) && profile.length > 0) {
				body.profile = { files: profile.map((item) => ({ path: item.path, text: item.text })) };
			}
			const payload = await hostJson(`${API}/import`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			return {
				results: Array.isArray(payload?.results) ? payload.results : [],
				profileResults: Array.isArray(payload?.profileResults) ? payload.profileResults : []
			};
		}

		/** 让宿主按刚恢复的清单重装插件（等价于在 profile 目录跑 pnpm install）。 */
		async function postInstall() {
			return await hostJson(`${API}/install`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({})
			});
		}

		/** 下载一个 JSON 文件。 */
		function downloadJson(payload, filename) {
			const text = JSON.stringify(payload, null, 2);
			const blob = new Blob([text], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = filename;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			setTimeout(() => {
				try {
					URL.revokeObjectURL(url);
				} catch {
					/* 释放失败无所谓 */
				}
			}, 2000);
		}
		//#endregion

		//#region 界面
		/** 勾选行。 */
		function ItemRow({ checked, onToggle, label, detail, meta, disabled }) {
			return e(
				"label",
				{ style: { ...S.row, opacity: disabled ? 0.5 : 1, cursor: disabled ? "default" : "pointer" } },
				e("input", {
					type: "checkbox",
					checked: checked === true,
					disabled: disabled === true,
					onChange: () => {
						if (!disabled) onToggle();
					}
				}),
				e("span", { style: S.rowLabel }, label),
				detail ? e("span", { style: S.rowDetail }, detail) : null,
				e("span", { style: S.rowMeta }, meta)
			);
		}

		/** 卡片。 */
		function Card({ title, note, children }) {
			return e(
				"section",
				{ style: S.card },
				e("div", { style: S.cardTitle }, e("span", null, title), note ? e("span", { style: S.cardNote }, note) : null),
				children
			);
		}

		/** 预览里的动作徽标。 */
		function ActionBadge({ action }) {
			const table = {
				add: { text: "新增", color: T.ok },
				update: { text: "覆盖", color: T.info },
				"update?": { text: "覆盖（无法对比）", color: T.warn },
				merge: { text: "合并", color: T.brand },
				same: { text: "相同", color: T.caption },
				unknown: { text: "跳过", color: T.warn }
			};
			const entry = table[action] ?? table.same;
			return e("span", { style: { ...S.badge, color: entry.color, borderColor: entry.color } }, entry.text);
		}

		/** 导入预览 + 确认（危险操作先问一句）。 */
		function PreviewDialog({ preview, busy, onCancel, onConfirm }) {
			const rows = preview.rows;
			const changed = rows.filter((row) => row.action !== "same");
			const secrets = changed.filter((row) => row.secret === true);
			const files = changed.filter((row) => row.section === "file");
			const browser = changed.filter((row) => row.section === "browser");
			const profile = changed.filter((row) => row.section === "profile");
			const groups = [
				{ title: "配置文件", rows: files },
				{ title: "profile 配置（插件清单等）", rows: profile },
				{ title: "浏览器本地数据", rows: browser }
			].filter((group) => group.rows.length > 0);
			return e(
				"div",
				{ style: S.confirmLayer },
				e("div", { style: S.confirmBackdrop, onClick: busy ? undefined : onCancel }),
				e(
					"div",
					{ style: S.confirmCard },
					e("div", { style: { fontWeight: 600, fontSize: 14 } }, "导入这份设置？"),
					e(
						"div",
						{ style: S.hint },
						`导出于 ${readableTime(preview.payload.exportedAt) ?? "未知时间"}${preview.payload.home ? ` · 来自 ${preview.payload.home}` : ""}${preview.payload.market ? " · 插件市场备份" : ""}`
					),
					e(
						"div",
						{ style: S.confirmBody },
						groups.length === 0
							? e("div", { style: S.hint }, "本机内容和它完全一致，导入不会改变任何东西。")
							: groups.map((group) =>
									e(
										"div",
										{ key: group.title, style: { marginBottom: 10 } },
										e("div", { style: { ...S.cardNote, marginBottom: 4 } }, `${group.title}（${group.rows.length}）`),
										group.rows.map((row) =>
											e(
												"div",
												{ key: `${group.title}:${row.id}`, style: S.row },
												e("span", { style: { ...S.rowLabel, flex: "1 1 auto" } }, row.label),
												row.secret === true ? e("span", { style: S.secretBadge }, "含凭据") : null,
												row.detail ? e("span", { style: S.rowDetail }, row.detail) : null,
												e("span", { style: S.rowMeta }, formatBytes(row.bytes)),
												e(ActionBadge, { action: row.action })
											)
										)
									)
								),
						secrets.length > 0
							? e(
									"div",
									{ style: S.secretNote },
									`这份文件里有 ${secrets.length} 个标着「含凭据」的条目：${secrets
										.slice(0, 3)
										.map((row) => row.label)
										.join("、")}${secrets.length > 3 ? " 等" : ""}。确认后它们的内容会覆盖本机同名文件，请只导入自己导出的文件。`
								)
							: null,
						rows.some((row) => row.action === "unknown")
							? e("div", { style: { ...S.hint, color: T.warn } }, "标着「跳过」的条目本插件不认识，不会写入。")
							: null
					),
					e(
						"div",
						{ style: { ...S.actions, justifyContent: "flex-end" } },
						e("button", { type: "button", style: S.btnSoft, disabled: busy, onClick: onCancel }, "取消"),
						e("button", { type: "button", style: S.btnDanger, disabled: busy, onClick: onConfirm }, busy ? "导入中…" : "确认导入")
					)
				)
			);
		}

		/** 设置里的「设置同步」一页。 */
		function SettingsSyncPage() {
			const [manifest, setManifest] = useState(null);
			const [localEntries, setLocalEntries] = useState(() => readLocalEntries());
			const [filePick, setFilePick] = useState(() => new Set());
			const [keyPick, setKeyPick] = useState(() => new Set());
			const [profilePick, setProfilePick] = useState(() => new Set());
			const [status, setStatus] = useState(null);
			const [busy, setBusy] = useState(false);
			const [preview, setPreview] = useState(null);
			const [error, setError] = useState(null);
			const [lastRun, setLastRun] = useState(() => readLastRun());
			const [installLog, setInstallLog] = useState(null);
			const inputRef = useRef(null);
			const pickedRef = useRef(false);

			/** 拉清单，并在第一次拉到时给出默认勾选：存在的文件 + 非会话的本地数据 + 非敏感的 profile 配置。 */
			const refreshManifest = async () => {
				if (typeof fetch !== "function") return null;
				const payload = await fetchManifest();
				setManifest(payload);
				if (!pickedRef.current) {
					pickedRef.current = true;
					// 默认勾上「本机存在且不敏感」的文件、以及非会话的浏览器数据。
					setFilePick(new Set((payload?.files ?? []).filter((file) => file.exists && !file.secret).map((file) => file.id)));
					const entries = readLocalEntries();
					setKeyPick(new Set(entries.filter((entry) => entry.scope !== "session").map((entry) => entry.key)));
					// profile 配置：package.json / cordis.patch.yml 这些默认都带上（敏感的除外）。
					setProfilePick(new Set((payload?.profile?.files ?? []).filter((file) => !file.secret).map((file) => file.path)));
				}
				return payload;
			};

			useEffect(() => {
				let alive = true;
				refreshManifest()
					.then(() => {
						if (alive) setError(null);
					})
					.catch((cause) => {
						if (alive) setError(String(cause?.message ?? cause));
					});
				return () => {
					alive = false;
				};
				// 只在挂载时拉一次
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, []);

			const fileList = manifest?.files ?? [];
			const profileList = manifest?.profile?.files ?? [];
			// 本机不存在的固定表文件没什么可导出的（宿主也会把它们从结果里省掉），所以不让勾。
			const pickableFiles = fileList.filter((file) => file.exists === true);
			const secretPicked = fileList.some((file) => file.secret === true && filePick.has(file.id));
			const profileSecretPicked = profileList.some((file) => file.secret === true && profilePick.has(file.path));
			const stateEntries = localEntries.filter((entry) => entry.scope !== "session");
			const sessionEntries = localEntries.filter((entry) => entry.scope === "session");
			const profilePaths = profileList.filter((file) => profilePick.has(file.path)).map((file) => file.path);

			const toggleFile = (id) => {
				const next = new Set(filePick);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				setFilePick(next);
			};
			const toggleKey = (key) => {
				const next = new Set(keyPick);
				if (next.has(key)) next.delete(key);
				else next.add(key);
				setKeyPick(next);
			};
			const toggleProfile = (path) => {
				const next = new Set(profilePick);
				if (next.has(path)) next.delete(path);
				else next.add(path);
				setProfilePick(next);
			};
			const setAllFiles = (on) => setFilePick(new Set(on ? pickableFiles.map((file) => file.id) : []));
			const setAllKeys = (on) => setKeyPick(new Set(on ? localEntries.map((entry) => entry.key) : []));
			const setAllProfile = (on) => setProfilePick(new Set(on ? profileList.map((file) => file.path) : []));

			/** 取当前勾选的 profile 配置（导出、市场格式、导入对比共用）。 */
			const currentProfileFiles = async () => {
				if (profilePaths.length === 0) return { files: [], market: null };
				return await fetchProfile(profilePaths);
			};

			const onExport = async () => {
				setBusy(true);
				setStatus(null);
				try {
					const selected = fileList.filter((file) => filePick.has(file.id));
					const missing = selected.filter((file) => file.exists !== true);
					const ids = selected.filter((file) => file.exists === true).map((file) => file.id);
					const files = await fetchFiles(ids, secretPicked);
					const storage = readLocalEntries().filter((entry) => keyPick.has(entry.key));
					const profile = await currentProfileFiles();
					if (files.length === 0 && storage.length === 0 && profile.files.length === 0) {
						setStatus({ kind: "error", text: "没有勾选任何可导出的内容（「本机没有这个文件」的条目导不出东西）。" });
						return;
					}
					const payload = buildExport({
						home: manifest?.home ?? null,
						origin: typeof location !== "undefined" ? location.origin : null,
						files,
						storage,
						exportedAt: new Date().toISOString(),
						profile: profile.files,
						market: profile.market
					});
					downloadJson(payload, exportFileName());
					rememberRun("export", payload.exportedAt);
					setLastRun(readLastRun());
					const parts = [`${payload.files.length} 个文件`, `${payload.browser.storage.length} 项浏览器本地数据`];
					if (payload.profile.length > 0) parts.push(`${payload.profile.length} 个 profile 配置`);
					if (missing.length > 0) parts.push(`${missing.length} 项本机不存在、没有导出（${missing.map((file) => file.label).join("、")}）`);
					setStatus({ kind: "ok", text: `已导出 ${parts.join("、")}` });
				} catch (cause) {
					setStatus({ kind: "error", text: `导出失败：${String(cause?.message ?? cause)}` });
				} finally {
					setBusy(false);
				}
			};

			/** 只导出 profile 那一份，格式就是插件市场能导入的备份。 */
			const onExportMarket = async () => {
				setBusy(true);
				setStatus(null);
				try {
					const profile = await currentProfileFiles();
					if (!profile.files.some((file) => file.path === "package.json")) {
						setStatus({ kind: "error", text: "市场备份必须带上 package.json（插件清单），请先勾上它再导出" });
						return;
					}
					if (!profile.market) {
						setStatus({ kind: "error", text: "宿主半区没有生成市场格式的备份" });
						return;
					}
					downloadJson(profile.market, marketFileName());
					setStatus({ kind: "ok", text: `已导出市场格式备份（${profile.market.files.length} 个文件），可在「插件市场 → 备份与恢复」里导入` });
				} catch (cause) {
					setStatus({ kind: "error", text: `导出失败：${String(cause?.message ?? cause)}` });
				} finally {
					setBusy(false);
				}
			};

			/** 按当前 profile 清单重装插件（等价于 pnpm install）。 */
			const onInstall = async () => {
				setBusy(true);
				setStatus(null);
				setInstallLog(null);
				try {
					const result = await postInstall();
					setInstallLog(result);
					if (result?.ok === true) {
						setStatus({ kind: "ok", text: `插件已按当前清单装好（${String(result.source ?? "pnpm")}），重启 DSH 生效。` });
					} else if (result?.code === "NO_PACKAGE_MANAGER") {
						setStatus({ kind: "error", text: String(result.message ?? "没找到 pnpm") });
					} else {
						setStatus({ kind: "error", text: `重装失败：${String(result?.code ?? "未知错误")}${result?.exitCode === undefined ? "" : `（exit ${result.exitCode}）`}` });
					}
				} catch (cause) {
					setStatus({ kind: "error", text: `重装失败：${String(cause?.message ?? cause)}` });
				} finally {
					setBusy(false);
				}
			};

			const onPickFile = async (event) => {
				const input = event?.target;
				const file = input?.files?.[0];
				if (input) input.value = "";
				if (!file) return;
				setBusy(true);
				setStatus(null);
				try {
					const text = await file.text();
					const parsed = parsePayload(text);
					if (!parsed.ok) {
						setStatus({ kind: "error", text: `这个文件不能导入：${parsed.message}` });
						return;
					}
					let current = [];
					let compareFailed = false;
					try {
						current = await fetchFiles(
							parsed.payload.files.map((item) => item.id),
							parsed.payload.files.some((item) => item.secret === true)
						);
					} catch (cause) {
						compareFailed = true;
						console.warn("[settings-sync] 读取本机文件内容失败，预览按「覆盖」显示:", cause);
						current = [];
					}
					// profile 配置也要拿本机现状来对比，否则分不清「新增」和「覆盖」。
					let currentProfile = [];
					const incomingProfile = parsed.payload.profile ?? [];
					if (incomingProfile.length > 0) {
						try {
							const fetched = await fetchProfile(incomingProfile.map((item) => item.path));
							currentProfile = Array.isArray(fetched?.files) ? fetched.files : [];
						} catch (cause) {
							compareFailed = true;
							console.warn("[settings-sync] 读取本机 profile 配置失败，预览按「覆盖」显示:", cause);
							currentProfile = [];
						}
					}
					// 清单还没到就现拉一次；拉不到就不能开预览——否则所有条目都会被标成「跳过」，等于给了一份假对比。
					let activeManifest = manifest;
					if (!activeManifest) activeManifest = await refreshManifest().catch(() => null);
					if (!activeManifest || !Array.isArray(activeManifest.files)) {
						setStatus({ kind: "error", text: "读不到本机文件清单（宿主半区可能没连上），没法做逐条对比，已取消这次导入。请先重启 DeepSeek Harness 再试。" });
						return;
					}
					setPreview({ payload: parsed.payload, rows: previewRows(parsed.payload, activeManifest, current, readLocalEntries(), currentProfile) });
					if (compareFailed) {
						setStatus({ kind: "warn", text: "读不到部分本机文件的内容，预览里的「覆盖 / 新增」是按缺省情况写的，可能不完全准；写之前的样子仍会各自留一份 .bak。" });
					}
				} catch (cause) {
					setStatus({ kind: "error", text: `读取文件失败：${String(cause?.message ?? cause)}` });
				} finally {
					setBusy(false);
				}
			};

			const onConfirmImport = async () => {
				if (!preview) return;
				setBusy(true);
				try {
					const payload = preview.payload;
					// 清单拿不到时不能把文件条目当成「不认识」静默跳过，更不该先动本地数据。
					let known = new Set(fileList.map((file) => file.id));
					if (known.size === 0 && payload.files.length > 0) {
						const fresh = await refreshManifest().catch(() => null);
						known = new Set((fresh?.files ?? []).map((file) => file.id));
						if (known.size === 0) {
							setStatus({ kind: "error", text: "宿主半区没有给出文件清单，已取消导入" });
							return;
						}
					}
					const files = payload.files.filter((item) => known.has(item.id));
					const skipped = payload.files.length - files.length;
					const profileEntries = (payload.profile ?? []).map((item) => ({ path: item.path, text: item.text }));
					// 先写文件（有备份，失败可回退），再动浏览器本地数据；宿主内部会先落 profile 清单。
					let written = { results: [], profileResults: [] };
					if (files.length > 0 || profileEntries.length > 0) written = await postImport(files, profileEntries);
					const storageResult = applyStorage(payload.storage);
					const parts = [];
					if (storageResult.written > 0) parts.push(`浏览器本地数据写入 ${storageResult.written} 项（刷新页面生效）`);
					if (storageResult.skipped > 0) parts.push(`浏览器本地数据有 ${storageResult.skipped} 项没写进去（浏览器可能禁用了本地存储）`);
					const changed = written.results.filter((row) => row.action !== "unchanged").length;
					if (written.results.length > 0) parts.push(`配置文件写入 ${changed} 项${changed === 0 ? "（内容相同）" : "（重启 DSH 生效）"}`);
					const profileChanged = written.profileResults.filter((row) => row.action !== "unchanged").length;
					if (written.profileResults.length > 0) parts.push(`profile 配置写入 ${profileChanged} 项${profileChanged === 0 ? "（内容相同）" : "（重启 DSH 生效）"}`);
					const added = written.profileResults.reduce((sum, row) => sum + (Array.isArray(row?.merged?.addedDependencies) ? row.merged.addedDependencies.length : 0), 0);
					if (added > 0) parts.push(`清单里新增 ${added} 个插件，可点「重装插件」安装`);
					if (skipped > 0) parts.push(`跳过 ${skipped} 项不认识的条目`);
					setStatus({ kind: "ok", text: parts.length > 0 ? `已导入：${parts.join("；")}` : "没有需要改动的内容" });
					rememberRun("import", payload.exportedAt);
					setLastRun(readLastRun());
					setPreview(null);
					setLocalEntries(readLocalEntries());
					await refreshManifest();
				} catch (cause) {
					setStatus({ kind: "error", text: `导入失败：${String(cause?.message ?? cause)}` });
				} finally {
					setBusy(false);
				}
			};

			const statusColor = status?.kind === "error" || status?.kind === "warn" ? T.warn : status?.kind === "ok" ? T.ok : T.fg2;

			return e(
				"div",
				{ style: S.page },
				e(
					"header",
					{ style: S.header },
					e("h2", { style: S.title }, "设置同步"),
					e("span", { style: S.subtitle }, "一个页面管三样：$DSH_HOME 文件、profile 配置（插件清单）、浏览器本地数据；也认插件市场的备份格式")
				),
				e(
					"div",
					{ style: { ...S.hint, marginBottom: 12 } },
					manifest?.home ? e("span", { style: S.mono }, manifest.home) : error ? e("span", { style: { color: T.warn } }, `宿主半区不可用：${error}`) : "正在读取本机目录…",
					lastRun ? e("span", null, ` · 上次${lastRun.kind === "import" ? "导入" : "导出"}：${readableTime(lastRun.at) ?? "—"}`) : null
				),
				e(
					Card,
					{ title: "配置文件", note: `${filePick.size} / ${fileList.length}` },
					fileList.length === 0
						? e("div", { style: S.hint }, "没有可同步的文件")
						: fileList.map((file) =>
								e(ItemRow, {
									key: file.id,
									checked: filePick.has(file.id),
									disabled: file.exists !== true,
									onToggle: () => toggleFile(file.id),
									label: `${file.label}${file.secret ? "（敏感）" : ""}`,
									detail: file.exists ? file.rel : "本机没有这个文件（导不出）",
									meta: file.exists ? formatBytes(file.bytes) : "—"
								})
							),
					fileList.length > 0
						? e(
								"div",
								{ style: { ...S.actions, marginTop: 8 } },
								e("button", { type: "button", style: S.btnGhost, onClick: () => setAllFiles(true) }, "全选"),
								e("button", { type: "button", style: S.btnGhost, onClick: () => setAllFiles(false) }, "全不选")
							)
						: null,
					secretPicked ? e("div", { style: { ...S.hint, color: T.warn, marginTop: 6 } }, "勾了账号凭据：导出的 JSON 会带上登录信息，别放到公开位置。") : null
				),
				e(
					Card,
					{ title: "浏览器本地数据", note: `${keyPick.size} / ${localEntries.length}` },
					localEntries.length === 0
						? e(
								"div",
								{ style: S.hint },
								localReadFailedFlag()
									? "读不到浏览器本地数据（浏览器可能禁用了本地存储或处于隐私模式）——这次同步里没有这部分"
									: "本机没有可同步的浏览器数据"
							)
						: null,
					stateEntries.map((entry) =>
						e(ItemRow, {
							key: entry.key,
							checked: keyPick.has(entry.key),
							onToggle: () => toggleKey(entry.key),
							label: entry.key,
							detail: null,
							meta: formatBytes(entry.bytes)
						})
					),
					sessionEntries.length > 0
						? e(
								"div",
								{ style: { marginTop: 8 } },
								e("div", { style: S.cardNote }, `会话草稿（${sessionEntries.length}，默认不同步）`),
								sessionEntries.map((entry) =>
									e(ItemRow, {
										key: entry.key,
										checked: keyPick.has(entry.key),
										onToggle: () => toggleKey(entry.key),
										label: entry.key,
										detail: null,
										meta: formatBytes(entry.bytes)
									})
								)
							)
						: null,
					localEntries.length > 0
						? e(
								"div",
								{ style: { ...S.actions, marginTop: 8 } },
								e("button", { type: "button", style: S.btnGhost, onClick: () => setAllKeys(true) }, "全选"),
								e("button", { type: "button", style: S.btnGhost, onClick: () => setAllKeys(false) }, "全不选")
							)
						: null
				),
				e(
					Card,
					{ title: "profile 配置（插件清单）", note: `${profilePick.size} / ${profileList.length}` },
					profileList.length === 0
						? e("div", { style: S.hint }, manifest?.profile?.dir ? "这个 profile 目录里没有可同步的配置文件" : "宿主半区没能确定当前 profile，profile 配置暂不可用")
						: profileList.map((file) =>
								e(ItemRow, {
									key: file.path,
									checked: profilePick.has(file.path),
									onToggle: () => toggleProfile(file.path),
									label: `${file.path}${file.secret ? "（敏感）" : ""}`,
									detail: file.path === "package.json" ? "插件清单，导入时按合并处理" : null,
									meta: file.exists ? formatBytes(file.bytes) : "—"
								})
							),
					profileList.length > 0
						? e(
								"div",
								{ style: { ...S.actions, marginTop: 8 } },
								e("button", { type: "button", style: S.btnGhost, onClick: () => setAllProfile(true) }, "全选"),
								e("button", { type: "button", style: S.btnGhost, onClick: () => setAllProfile(false) }, "全不选"),
								manifest?.profile?.dir ? e("span", { style: S.cardNote }, manifest.profile.dir) : null
							)
						: null,
					profileSecretPicked ? e("div", { style: { ...S.hint, color: T.warn, marginTop: 6 } }, "勾了 profile 里的敏感配置（如 .env / config.toml）：导出的 JSON 会带上它们，别放到公开位置。") : null
				),
				e(
					"div",
					{ style: S.actions },
					e("button", { type: "button", style: S.btnPrimary, disabled: busy, onClick: onExport }, busy ? "处理中…" : "导出 JSON"),
					e("button", { type: "button", style: S.btnSoft, disabled: busy, onClick: onExportMarket }, "导出市场格式"),
					e("button", { type: "button", style: S.btnSoft, disabled: busy, onClick: () => inputRef.current?.click() }, "导入…"),
					e("input", { ref: inputRef, type: "file", accept: "application/json,.json", style: { display: "none" }, onChange: onPickFile }),
					e("button", { type: "button", style: S.btnSoft, disabled: busy, onClick: onInstall, title: "在 profile 目录跑 pnpm install" }, busy ? "处理中…" : "重装插件")
				),
				installLog
					? e(
							"div",
							{ style: { ...S.card, marginTop: 12 } },
							e(
								"div",
								{ style: S.cardTitle },
								e("span", null, "重装输出"),
								e("span", { style: S.cardNote }, `${String(installLog.source ?? "—")} · exit ${String(installLog.exitCode ?? "—")}`)
							),
							e(
								"pre",
								{ style: { ...S.mono, maxHeight: 220, overflow: "auto", margin: 0, whiteSpace: "pre-wrap" } },
								installLog.output || installLog.message || "（没有输出）"
							)
						)
					: null,
				status ? e("div", { style: { ...S.status, color: statusColor } }, status.text) : null,
				preview ? e(PreviewDialog, { preview, busy, onCancel: () => setPreview(null), onConfirm: onConfirmImport }) : null
			);
		}
		//#endregion

		//#region 插件装配
		/** 客户端半区依赖的服务（只等真正用到的两个）。 */
		const inject = ["slots", "layout"];

		/** 装配出错要走 error 级日志（宿主日志里看得见），不能只 console.warn 就算了。 */
		function reportMountError(ctx, message, error) {
			try {
				const logger = ctx?.logger;
				if (logger && typeof logger.error === "function") logger.error(`[settings-sync] ${message}`, error);
				else console.error(`[settings-sync] ${message}`, error);
			} catch {
				console.error(`[settings-sync] ${message}`, error);
			}
		}

		/** 正常席位注册失败时，退而求其次挂一个只剩错误信息的席位，别让插件看起来像没装。 */
		function registerErrorSeat(ctx, slots, disposers, error) {
			try {
				disposers.push(
					slots.inject("settings.section", () =>
						slots.register({ name: "settings.section", id: SECTION_ID, order: SECTION_ORDER, label: "设置同步（加载失败）" }, () =>
							e(
								"div",
								{ style: S.page },
								e("div", { style: { color: T.warn } }, `设置同步没能加载：${String(error?.message ?? error)}`),
								e("div", { style: S.hint }, "重启 DeepSeek Harness 再试；如果一直这样，把这条信息反馈给插件作者。")
							)
						)
					)
				);
			} catch (fallbackError) {
				reportMountError(ctx, "连「加载失败」席位也没注册上:", fallbackError);
			}
		}

		/**
		 * 挂载：向「设置」注册一页。
		 *
		 * @param ctx - 客户端插件上下文。
		 */
		function apply(ctx) {
			try {
				const slots = ctx?.slots;
				if (!slots || typeof slots.inject !== "function") {
					reportMountError(ctx, "没有 slots 服务，设置页未注册:", new Error("slots service is missing"));
					return;
				}
				const disposers = [];
				const seat = () => {
					try {
						disposers.push(slots.inject("settings.section", () => slots.register({ name: "settings.section", id: SECTION_ID, order: SECTION_ORDER, label: "设置同步" }, SettingsSyncPage)));
					} catch (error) {
						reportMountError(ctx, "注册设置页失败:", error);
						registerErrorSeat(ctx, slots, disposers, error);
					}
				};
				seat();
				ctx.effect(
					() => () => {
						for (const dispose of disposers.splice(0)) {
							try {
								dispose();
							} catch (error) {
								console.warn("[settings-sync] 释放席位失败:", error);
							}
						}
					},
					"settings-sync: ui mounts"
				);
			} catch (error) {
				reportMountError(ctx, "挂载失败:", error);
			}
		}

		exports.name = PLUGIN_ID;
		exports.inject = inject;
		exports.apply = apply;
		exports.__test = {
			PLUGIN_ID,
			SECTION_ID,
			SECTION_ORDER,
			FORMAT,
			FORMAT_VERSION,
			MARKET_FORMAT,
			MARKET_VERSION,
			MAX_TEXT,
			MAX_KEYS,
			MAX_FILES,
			MAX_PROFILE,
			PROFILE_EXCLUDED,
			PROFILE_SECRET_HINTS,
			LAST_KEY,
			scopeOf,
			readLocalEntries,
			localReadFailedFlag,
			apply,
			reportMountError,
			buildExport,
			parsePayload,
			marketProfileEntries,
			profileEntryProblem,
			previewRows,
			applyStorage,
			formatBytes,
			exportFileName,
			marketFileName,
			readableTime,
			readLastRun,
			rememberRun,
			SettingsSyncPage,
			PreviewDialog,
			ActionBadge
		};
		//#endregion

		return module.exports;
	}
});
