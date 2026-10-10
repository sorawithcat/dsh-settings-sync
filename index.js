/**
 * 设置同步插件 · 宿主半区
 *
 * 一份 JSON 覆盖换电脑时真正要搬的全部东西：
 * - `$DSH_HOME` 根目录下的文件，以及 `storages/` 里那几个不属于任何 profile 的文件；
 * - **profile 配置**（`package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml` …）——
 *   也就是市场（dshmarket）「备份与恢复」里那一半，本插件按同一份口径重新实现，
 *   并保持格式互通：市场导出的备份能直接导入，本插件也能额外产出一份市场能导入的文件；
 * - 浏览器本地数据（localStorage）由 `./client.js` 自己读写——宿主碰不到它。
 *
 * 四条路由（都需要 `webServer` + `connection`）：
 * - `GET  /dsh-settings-sync/manifest` 列出可同步的文件与 profile 配置的状态（不含内容）。
 * - `POST /dsh-settings-sync/export`   取回选中内容（`includeProfile` 时带上 profile 配置文件）。
 * - `POST /dsh-settings-sync/import`   写回选中内容（先留 `.bak`，再原子替换；package.json 走合并）。
 * - `POST /dsh-settings-sync/install`  在 profile 目录跑一次 `pnpm install`，把插件清单变成真的插件。
 *
 * 写入路径永远来自「固定表 + profile 目录内的相对路径白名单」：请求只能挑 `id` 或给相对路径，
 * 路径穿越在协议层就被 `..` / 绝对路径 / 盘符 / 符号链接检查挡住。
 * 对照 `dsh-host-open-in-app` 与市场路由的先例，走裸 webServer 路由（本插件是 `link:` 直装的纯 JS，
 * 没有 Typert Remote 的构建管线），每个 handler 第一句都要一次 `connection.requestRejection(req)`
 * ——那道栅栏同时挡住跨站与未登录请求。
 *
 * @module dsh-settings-sync
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { lstat, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** 插件名，也是 profile 组合层里那一行的 name。 */
export const name = "dsh-settings-sync";

/** 需要 Web 服务器（注册路由）与 connection（每条路由的信任栅栏）。 */
export const inject = ["webServer", "connection"];

const MANIFEST_PATH = "/dsh-settings-sync/manifest";
const EXPORT_PATH = "/dsh-settings-sync/export";
const IMPORT_PATH = "/dsh-settings-sync/import";
const INSTALL_PATH = "/dsh-settings-sync/install";

/** 请求体上限：最坏情况是若干 KB 的配置文件，8 MB 已经宽松到不可能被正常用满。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** 单个文件上限，读写两侧都按这个卡。 */
const MAX_FILE_BYTES = 1024 * 1024;
/** 覆盖前的备份后缀（后面接时间戳）。 */
const BACKUP_SUFFIX = ".bak-settings-sync";

/** 市场（dshmarket）备份格式：能直接读入，也能产出一份市场能导入的文件。 */
export const MARKET_FORMAT = "dsh-profile-backup";
export const MARKET_VERSION = 0.2;
/** profile 配置文件的排除表（与市场一致）：依赖目录、市场缓存、git、锁文件都不进备份。 */
export const PROFILE_SKIP_NAMES = ["node_modules", ".dsh-market", ".git", "pnpm-lock.yaml"];
const SKIP_SET = new Set(PROFILE_SKIP_NAMES);
/** 一次最多同步多少个 profile 配置文件（与市场同上限）。 */
export const MAX_PROFILE_FILES = 256;
/** 文件名看起来就含密钥的 profile 配置（与市场同一张表，外加它们的同义词）。 */
const PROFILE_SECRET_HINTS = /(^|\/)(config\.toml|\.env(\.\w+)?|secrets?\.\w+t?j?s?o?n|pnpm-workspace\.yaml)$/i;
/** `pnpm install` 的墙钟上限与回传输出上限。 */
const MAX_INSTALL_MS = 5 * 60 * 1000;
const MAX_INSTALL_OUTPUT = 32 * 1024;

/**
 * 可同步文件的固定表：`id` 是协议里唯一能出现的标识，`rel` 是相对 `$DSH_HOME` 的路径。
 * `secret: true` 的文件默认不导出，必须由界面显式勾选（并在请求里带 `allowSecrets`）。
 */
export const FILES = [
	{ id: "agents", rel: "AGENTS.md", label: "全局工作规则" },
	{ id: "pet", rel: "pet.json", label: "桌面宠物" },
	{ id: "skin", rel: "skin-center-active.json", label: "皮肤" },
	{ id: "workspaces", rel: "storages/workspace.json", label: "工作区列表" },
	{ id: "credentials", rel: ".credentials.yaml", label: "账号凭据", secret: true }
];

/** 按 id 取固定表里的一条；未知 id 返回 null。 */
export function fileById(id) {
	if (typeof id !== "string") return null;
	return FILES.find((entry) => entry.id === id) ?? null;
}

/** 默认的 Harness home（单根布局）。 */
export function defaultDshHome() {
	return join(homedir(), ".dsh");
}

/** 展开 DSH 配置支持的波浪号写法。 */
export function expandHomePath(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

/**
 * 解析 Harness home：`DSH_HOME`（空白视为未设置）优先，否则 `~/.dsh`。
 * 与 `@deepseek-ai/dsh-home-paths` 的语义一致，这里自带一份以免依赖宿主内部包。
 */
export function resolveDshHome(env = process.env) {
	const fromEnv = typeof env?.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
	return resolve(expandHomePath(fromEnv.length > 0 ? fromEnv : defaultDshHome()));
}

/** SHA-256（十六进制），用于给导出内容留指纹。 */
export function sha256(text) {
	return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** JSON 响应（no-store：这些都是即时事实）。 */
function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(payload));
}

/** 405 并声明该路由唯一支持的方法。 */
function sendMethodNotAllowed(res, allow) {
	res.statusCode = 405;
	res.setHeader("allow", allow);
	res.end();
}

/** 读取有上限的请求体（UTF-8 文本）；超限返回 null（并把流排干）。 */
async function readBoundedBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.byteLength;
		if (size > MAX_BODY_BYTES) {
			req.resume();
			return null;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size).toString("utf8");
}

/** connection 服务（类型在别的包里，这里只按用到的形状取）。 */
function connectionOf(ctx) {
	return Reflect.get(ctx, "connection");
}

/** 回复一个不可信 / 未认证的请求；被拒绝时返回 true。 */
function rejected(ctx, req, res) {
	const rejection = connectionOf(ctx)?.requestRejection?.(req);
	if (rejection === undefined) return false;
	res.statusCode = rejection;
	res.end();
	return true;
}

/** content-type 是不是 application/json（忽略 charset）。 */
function isJsonRequest(req) {
	const raw = String(req.headers?.["content-type"] ?? "");
	return raw.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/** 读一个文件为 UTF-8 文本；不存在 / 读不了 / 太大都返回 null。 */
async function readTextFile(path) {
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/** 取一个对象（数组与 null 不算），否则给空对象。 */
function objectOf(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** 取一个字符串数组（其余元素丢掉）。 */
function stringArrayOf(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/**
 * 列出固定表里每个文件在本机的状态。只返回元数据与指纹，不返回内容——
 * 界面用它画勾选列表，导出时再单独取内容。
 *
 * @param home - `$DSH_HOME`。
 * @param profileDir - 可选的当前 profile 目录；给了就一并返回 profile 配置的状态。
 */
export async function readManifest(home, profileDir) {
	const files = [];
	for (const entry of FILES) {
		const path = join(home, entry.rel);
		let size = 0;
		let mtime = null;
		let exists = false;
		try {
			const info = await stat(path);
			if (info.isFile()) {
				exists = true;
				size = info.size;
				mtime = info.mtimeMs;
			}
		} catch {
			exists = false;
		}
		const text = exists ? await readTextFile(path) : null;
		files.push({
			id: entry.id,
			rel: entry.rel,
			label: entry.label,
			secret: entry.secret === true,
			path,
			exists,
			bytes: size,
			mtime,
			readable: text !== null,
			sha256: text === null ? null : sha256(text)
		});
	}
	const manifest = { home, files };
	if (typeof profileDir === "string" && profileDir.length > 0) {
		manifest.profile = await readProfileManifest(profileDir);
	}
	return manifest;
}

/**
 * 校验导出请求：`{ ids: string[], allowSecrets?: boolean }`。
 * 未知 id 直接拒绝（而不是忽略），否则界面会以为自己导出了实际不存在的东西。
 */
export function validateExportRequest(raw) {
	if (!raw || typeof raw !== "object") return { ok: false, code: "BAD_BODY", message: "请求体必须是 { ids: string[] }" };
	if (!Array.isArray(raw.ids)) return { ok: false, code: "BAD_BODY", message: "请求体必须是 { ids: string[] }" };
	const seen = new Set();
	const entries = [];
	for (const id of raw.ids) {
		const entry = fileById(id);
		if (entry === null) return { ok: false, code: "UNKNOWN_FILE", message: `不认识的文件 id：${String(id)}` };
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		entries.push(entry);
	}
	const secrets = entries.filter((entry) => entry.secret === true);
	if (secrets.length > 0 && raw.allowSecrets !== true) {
		return { ok: false, code: "SECRET_NOT_ALLOWED", message: `${secrets[0].label} 属于敏感文件，需要显式允许才能导出` };
	}
	return { ok: true, entries };
}

/**
 * 校验导入请求：`{ files: [{ id, text }] }`。
 * 只认固定表里的 id、只认字符串、逐个限长；重复 id 与空请求都拒绝。
 */
export function validateImportRequest(raw, table = FILES) {
	if (!raw || typeof raw !== "object" || !Array.isArray(raw.files)) {
		return { ok: false, code: "BAD_BODY", message: "请求体必须是 { files: [{ id, text }] }" };
	}
	if (raw.files.length === 0) return { ok: false, code: "EMPTY", message: "没有要导入的文件" };
	if (raw.files.length > table.length) return { ok: false, code: "TOO_MANY", message: "文件条目比可同步文件还多" };
	const seen = new Set();
	const items = [];
	for (const item of raw.files) {
		const id = typeof item?.id === "string" ? item.id : null;
		const entry = id === null ? null : table.find((candidate) => candidate.id === id) ?? null;
		if (entry === null) return { ok: false, code: "UNKNOWN_FILE", message: `不认识的文件 id：${String(item?.id)}` };
		if (seen.has(entry.id)) return { ok: false, code: "DUPLICATE", message: `重复的文件 id：${entry.id}` };
		if (typeof item.text !== "string") return { ok: false, code: "BAD_BODY", message: `${entry.rel} 的内容必须是字符串` };
		if (Buffer.byteLength(item.text, "utf8") > MAX_FILE_BYTES) return { ok: false, code: "TOO_LARGE", message: `${entry.rel} 超过 1 MB` };
		seen.add(entry.id);
		items.push({ entry, text: item.text });
	}
	return { ok: true, items };
}

/** 备份文件名用的时间戳（可读、可排序、不含 Windows 非法字符）。 */
export function backupStamp(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * 把校验过的条目写到 `home` 下：内容相同就跳过，否则先留 `.bak` 再写临时文件 + 原子替换。
 * 路径只可能来自固定表，调用方无法注入。
 */
export async function applyWrites(home, items, stamp = backupStamp()) {
	const results = [];
	for (const { entry, text } of items) {
		const path = join(home, entry.rel);
		const current = await readTextFile(path);
		if (current === text) {
			results.push({ id: entry.id, rel: entry.rel, action: "unchanged", backup: null });
			continue;
		}
		const { backup, existed } = await writeWithBackup(path, text, current, stamp);
		results.push({ id: entry.id, rel: entry.rel, action: existed ? "written" : "created", backup });
	}
	return results;
}

/**
 * 写一个文件：先留 `.bak`（原来存在时），再写临时文件 + 原子替换。
 * 返回 `{ backup, existed }`；`existed` 决定调用方把动作记成 created 还是 written——
 * 读不出内容（超过 1 MB 或不是 UTF-8）的老文件也算 written，并且用复制文件的方式留备份，
 * 这样「覆盖前先留备份」对任何已存在的文件都成立。
 */
async function writeWithBackup(path, text, current, stamp) {
	let backup = null;
	let existed = true;
	if (current !== null) {
		backup = `${path}${BACKUP_SUFFIX}-${stamp}`;
		try {
			await writeFile(backup, current, "utf8");
		} catch {
			backup = null;
		}
	} else {
		existed = existsSync(path);
		if (existed) {
			backup = `${path}${BACKUP_SUFFIX}-${stamp}`;
			try {
				await copyFile(path, backup);
			} catch {
				backup = null;
			}
		}
	}
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-settings-sync-${randomBytes(4).toString("hex")}`;
	await writeFile(tmp, text, "utf8");
	await rename(tmp, path);
	return { backup, existed };
}

//#region profile 配置（与市场 dsh-profile-backup 同一份口径）

/**
 * 当前 profile 的目录。三个来源，按可信度排序：
 * 1. `DSH_PROFILE_DIR`（便于测试与多 profile）；
 * 2. 启动器自报的 `profileContext.dir`——官方桌面端就是这样把活动 profile 交给插件的
 *    （市场也用同一个服务，见 dshmarket 的 `launchedProfile`）；
 * 3. 兜底 `$DSH_HOME/profiles/<DSH_PROFILE|desktop>`。
 */
export function resolveProfileDir(ctx, env = process.env) {
	const fromEnv = typeof env?.DSH_PROFILE_DIR === "string" ? env.DSH_PROFILE_DIR.trim() : "";
	if (fromEnv.length > 0) return resolve(expandHomePath(fromEnv));
	const launched = ctx?.get?.("profileContext");
	const dir = typeof launched?.dir === "string" ? launched.dir.trim() : "";
	if (dir.length > 0) return resolve(expandHomePath(dir));
	const named = typeof env?.DSH_PROFILE === "string" ? env.DSH_PROFILE.trim() : "";
	const profileName = named.length > 0 ? named : "desktop";
	return join(resolveDshHome(env), "profiles", profileName);
}

/**
 * 递归列出 profile 里可同步的配置文件（相对路径，正斜杠）。
 * 规则对齐市场的备份：跳过依赖目录、市场缓存、git、锁文件、任何 `.bak` 与符号链接。
 */
export function listProfileFiles(root, dir = root, out = []) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (out.length >= MAX_PROFILE_FILES) return out;
		if (SKIP_SET.has(entry.name) || /\.bak\b/.test(entry.name)) continue;
		if (entry.isSymbolicLink()) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			listProfileFiles(root, path, out);
			// 子目录可能一口气填满额度，回来再看一眼，保证上限是按总数算的。
			if (out.length >= MAX_PROFILE_FILES) return out;
		} else if (entry.isFile()) out.push(relative(root, path).split(sep).join("/"));
	}
	return out;
}

/** 列出 profile 配置的状态（存在性 / 大小 / 指纹），与 `$DSH_HOME` 那一半同形。 */
export async function readProfileManifest(profileDir) {
	const paths = listProfileFiles(profileDir).sort();
	const files = [];
	for (const path of paths) {
		const full = join(profileDir, path);
		const text = await readTextFile(full);
		let bytes = 0;
		let mtime = null;
		try {
			const info = await stat(full);
			bytes = info.size;
			mtime = info.mtimeMs;
		} catch {
			bytes = 0;
		}
		files.push({
			path,
			exists: text !== null,
			bytes,
			mtime,
			readable: text !== null,
			secret: PROFILE_SECRET_HINTS.test(path),
			sha256: text === null ? null : sha256(text)
		});
	}
	return { dir: profileDir, files };
}

/** profile 文件路径的合法性：留在目录内、不在排除表里、不是绝对路径 / 盘符 / `..`。 */
function profilePathProblem(path) {
	if (path.length === 0) return "路径是空的";
	if (path.length > 300) return "路径太长";
	if (path.startsWith("/") || path.startsWith("\\") || isAbsolute(path) || /^[a-zA-Z]:/.test(path)) return "不能是绝对路径";
	const parts = path.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) return "路径里不能有 . / .. / 空段";
	if (parts.some((part) => SKIP_SET.has(part))) return "这个路径属于排除范围";
	return null;
}

/**
 * 校验 profile 导入条目：`{ profile: { files: [{ path, text }] } }`。
 * `profile` 缺省视为「不动 profile」，返回空清单。
 */
export function validateProfileFiles(raw, profileDir) {
	if (raw === undefined || raw === null) return { ok: true, items: [] };
	if (typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.files)) {
		return { ok: false, code: "BAD_PROFILE", message: "profile 必须是 { files: [{ path, text }] }" };
	}
	if (raw.files.length === 0) return { ok: true, items: [] };
	if (raw.files.length > MAX_PROFILE_FILES) return { ok: false, code: "TOO_MANY", message: `profile 文件条目超过 ${MAX_PROFILE_FILES} 个` };
	const seen = new Set();
	const items = [];
	let total = 0;
	for (const item of raw.files) {
		const path = typeof item?.path === "string" ? item.path.replaceAll("\\", "/").trim() : "";
		const problem = profilePathProblem(path);
		if (problem !== null) return { ok: false, code: "UNSAFE_PATH", message: `${problem}：${String(item?.path)}` };
		if (seen.has(path)) return { ok: false, code: "DUPLICATE", message: `重复的 profile 路径：${path}` };
		if (typeof item.text !== "string") return { ok: false, code: "BAD_PROFILE", message: `${path} 的内容必须是字符串` };
		const bytes = Buffer.byteLength(item.text, "utf8");
		if (bytes > MAX_FILE_BYTES) return { ok: false, code: "TOO_LARGE", message: `${path} 超过 1 MB` };
		total += bytes;
		if (total > MAX_BODY_BYTES) return { ok: false, code: "TOO_LARGE", message: "profile 配置总量超过 8 MB" };
		seen.add(path);
		items.push({ path, text: item.text });
	}
	// 目录必须可解析；给不出来就当场拒绝，别让它到写入阶段才炸。
	if (typeof profileDir !== "string" || profileDir.length === 0) {
		return { ok: false, code: "NO_PROFILE_DIR", message: "宿主没能确定当前 profile 目录" };
	}
	return { ok: true, items };
}

/** 解析成 JSON 对象；不是对象返回 null。 */
function parseJsonObject(text) {
	if (typeof text !== "string") return null;
	try {
		const value = JSON.parse(text);
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

/**
 * 合并 profile 的 `package.json`：
 * - `dependencies` 取并集，同名以导入文件为准；
 * - `dsh.profile.bundles` 取并集（保留本机顺序，新插件追加在后面）；
 * - 其余顶层字段以导入文件为准，**导入文件里没有的顶层字段保持本机原样**
 *   （本机独有的 `devDependencies` / `scripts` 之类不会被合并动作丢掉）；
 * - `dsh` 里同名的子键以本机为准，`dsh.profile` 里同名的键同样本机优先。
 * 前两条与市场的 `mergeRestoreManifest` 对齐（既不丢本机原有插件，也把备份里的补齐），
 * 第三条比它保守一点：市场版本的 `{ ...备份 }` 会丢掉本机独有的顶层字段。
 */
export function mergeProfileManifest(currentText, incomingText) {
	const incoming = parseJsonObject(incomingText);
	if (incoming === null) return { ok: false, code: "BAD_PACKAGE_JSON", message: "导入的 package.json 不是合法 JSON 对象" };
	const current = parseJsonObject(currentText) ?? {};
	const currentDeps = objectOf(current.dependencies);
	const incomingDeps = objectOf(incoming.dependencies);
	const currentDsh = objectOf(current.dsh);
	const incomingDsh = objectOf(incoming.dsh);
	const currentProfile = objectOf(currentDsh.profile);
	const incomingProfile = objectOf(incomingDsh.profile);
	const bundles = [];
	for (const name of [...stringArrayOf(currentProfile.bundles), ...stringArrayOf(incomingProfile.bundles)]) {
		if (name.length > 0 && !bundles.includes(name)) bundles.push(name);
	}
	const merged = { ...incoming };
	for (const [key, value] of Object.entries(current)) {
		if (!Object.prototype.hasOwnProperty.call(incoming, key)) merged[key] = value;
	}
	merged.dependencies = { ...currentDeps, ...incomingDeps };
	merged.dsh = { ...incomingDsh, ...currentDsh, profile: { ...incomingProfile, ...currentProfile, bundles } };
	const addedDependencies = Object.keys(incomingDeps).filter((name) => !(name in currentDeps));
	const addedBundles = bundles.filter((name) => !stringArrayOf(currentProfile.bundles).includes(name));
	return { ok: true, text: `${JSON.stringify(merged, null, 2)}\n`, addedDependencies, addedBundles };
}

/**
 * 写回 profile 配置：`package.json` 走合并，其余整文件覆盖；两者都先留 `.bak` 再原子替换。
 * 路径已在校验阶段收窄，这里再按 resolve 后的前缀复核一次（防符号链接逃逸）。
 */
export async function applyProfileWrites(profileDir, items, stamp = backupStamp()) {
	const root = resolve(profileDir);
	const results = [];
	for (const item of items) {
		const target = resolve(root, item.path);
		if (target !== root && !target.startsWith(root + sep)) {
			results.push({ path: item.path, action: "skipped", reason: "路径跑出了 profile 目录" });
			continue;
		}
		try {
			const info = await lstat(target);
			if (!info.isFile()) {
				results.push({ path: item.path, action: "skipped", reason: "目标不是普通文件" });
				continue;
			}
		} catch {
			/* 不存在就是要新建，正常 */
		}
		const current = await readTextFile(target);
		let text = item.text;
		let merged = null;
		if (item.path === "package.json") {
			const result = mergeProfileManifest(current, item.text);
			if (!result.ok) {
				results.push({ path: item.path, action: "skipped", reason: result.message });
				continue;
			}
			text = result.text;
			merged = { addedDependencies: result.addedDependencies, addedBundles: result.addedBundles };
		}
		if (current === text) {
			results.push({ path: item.path, action: "unchanged", backup: null, merged });
			continue;
		}
		const { backup, existed } = await writeWithBackup(target, text, current, stamp);
		results.push({ path: item.path, action: existed ? "written" : "created", backup, merged });
	}
	return results;
}

/**
 * 把一份市场备份（`dsh-profile-backup` 0.2）转成本插件认识的 profile 条目。
 * 不是市场格式就返回 null；格式对但内容不合法则抛错，避免把半份备份写进 profile。
 */
export function profileFilesFromMarketBackup(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	if (value.format !== MARKET_FORMAT || value.version !== MARKET_VERSION || !Array.isArray(value.files)) return null;
	const items = [];
	for (const file of value.files) {
		if (file === null || typeof file !== "object" || typeof file.path !== "string") {
			throw new Error("市场备份里有条目缺少 path");
		}
		if (file.path === "package.json") {
			const json = file.json;
			if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("市场备份里的 package.json 不是一个对象");
			items.push({ path: "package.json", text: `${JSON.stringify(json, null, 2)}\n` });
			continue;
		}
		if (!Array.isArray(file.lines) || !file.lines.every((line) => typeof line === "string")) {
			throw new Error(`市场备份里的 ${file.path} 内容不合法`);
		}
		items.push({ path: file.path, text: file.lines.join("\n") });
	}
	return { profile: typeof value.profile === "string" ? value.profile : null, createdAt: typeof value.createdAt === "string" ? value.createdAt : null, items };
}

/** 由 profile 条目造一份市场能导入的备份（`package.json` 走 json 字段，其余按行）。 */
export function marketBackupOf(profileName, entries, createdAt = new Date().toISOString()) {
	const files = entries.map(({ path, text }) => (path === "package.json" ? { path, json: JSON.parse(text) } : { path, lines: text.split(/\r?\n/) }));
	return { format: MARKET_FORMAT, version: MARKET_VERSION, createdAt, profile: profileName, files };
}

/** profile 的名字（目录名），市场备份的 `profile` 字段用它。 */
export function profileNameOf(profileDir) {
	try {
		return basename(resolve(profileDir));
	} catch {
		return "desktop";
	}
}

/**
 * 找 `pnpm install` 该用哪个包管理器：
 * 1. 启动器发布在 `profileContext.packageManager` 的 `{ command, args, env }`（官方桌面端的正规通道）；
 * 2. `DSH_SETTINGS_SYNC_PNPM` 指到某个 `pnpm.mjs`；
 * 3. `$DSH_HOME/dsh-runtimes/<runtime>/dependencies/` 里自带的 node + pnpm。
 * 三条都拿不到就返回 null，由界面告诉用户自己跑一条命令。
 */
export function packageManagerOf(ctx, env = process.env) {
	const published = ctx?.get?.("profileContext")?.packageManager;
	if (published !== null && typeof published === "object" && !Array.isArray(published)) {
		const command = typeof published.command === "string" ? published.command.trim() : "";
		const args = Array.isArray(published.args) ? published.args.filter((arg) => typeof arg === "string") : null;
		const envOk = published.env === undefined || (published.env !== null && typeof published.env === "object" && !Array.isArray(published.env));
		if (command.length > 0 && args !== null && args.length === published.args.length && envOk) {
			const extra = {};
			for (const [key, value] of Object.entries(published.env ?? {})) if (typeof value === "string") extra[key] = value;
			return { command, args, env: extra, source: "launcher" };
		}
	}
	const explicit = typeof env?.DSH_SETTINGS_SYNC_PNPM === "string" ? env.DSH_SETTINGS_SYNC_PNPM.trim() : "";
	if (explicit.length > 0 && existsSync(explicit)) {
		return { command: process.execPath, args: [explicit], env: {}, source: "env" };
	}
	const runtime = findRuntimePnpm(env);
	if (runtime !== null) return { command: runtime.node, args: [runtime.pnpm], env: {}, source: "runtime" };
	return null;
}

/** 在 `$DSH_HOME/dsh-runtimes/<runtime>/dependencies/` 里找一个 node + pnpm 组合。 */
export function findRuntimePnpm(env = process.env) {
	const base = join(resolveDshHome(env), "dsh-runtimes");
	let names;
	try {
		names = readdirSync(base);
	} catch {
		return null;
	}
	for (const name of names) {
		const pnpm = join(base, name, "dependencies", "pnpm", "bin", "pnpm.mjs");
		const node = join(base, name, "dependencies", "node", "bin", process.platform === "win32" ? "node.exe" : "node");
		if (existsSync(pnpm) && existsSync(node)) return { pnpm, node };
	}
	return null;
}

/**
 * 在 profile 目录跑一次 `pnpm install`，把插件清单变成真的插件。
 * 只回传输出尾部（32 KB）与退出码；超时先 kill 再报 timedOut。
 */
export function runProfileInstall(profileDir, manager, options = {}) {
	const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : MAX_INSTALL_MS;
	const args = [...manager.args, "install", "--prefer-offline"];
	return new Promise((settle) => {
		const env = { ...process.env, ...manager.env };
		const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(manager.command);
		const command = viaShell ? env.COMSPEC ?? "cmd.exe" : manager.command;
		const argv = viaShell ? ["/d", "/s", "/c", `"${[manager.command, ...args].join(" ")}"`] : args;
		let child;
		try {
			child = spawn(command, argv, { cwd: profileDir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			settle({ ok: false, code: null, output: String(error?.message ?? error), timedOut: false });
			return;
		}
		let output = "";
		const collect = (chunk) => {
			output += String(chunk);
			if (output.length > MAX_INSTALL_OUTPUT) output = output.slice(-MAX_INSTALL_OUTPUT);
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		let timedOut = false;
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			settle(result);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {
				/* 已经退了 */
			}
			if (process.platform === "win32" && typeof child.pid === "number") {
				try {
					spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
				} catch {
					/* taskkill 不在就算了 */
				}
			}
		}, timeoutMs);
		child.on("error", (error) => finish({ ok: false, code: null, output: `${output}${String(error?.message ?? error)}`.trim(), timedOut }));
		child.on("close", (code) => finish({ ok: code === 0 && !timedOut, code, output: output.trim(), timedOut }));
	});
}

//#endregion

/**
 * 挂载宿主半区：注册四条路由。
 *
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
	const home = resolveDshHome();
	const profileDir = resolveProfileDir(ctx);

	try {
		ctx?.logger?.info?.(`[settings-sync] 宿主半区已挂载（${home} + ${profileDir}）`);
	} catch {
		/* 日志失败不影响插件可用性 */
	}

	// GET /dsh-settings-sync/manifest —— 界面的勾选列表。
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "exact",
				path: MANIFEST_PATH,
				handler: (req, res) => {
					if (rejected(ctx, req, res)) return;
					if (req.method !== "GET") {
						sendMethodNotAllowed(res, "GET");
						return;
					}
					readManifest(home, profileDir)
						.then((manifest) => sendJson(res, 200, { ok: true, ...manifest }))
						.catch((error) => sendJson(res, 200, { ok: false, code: "MANIFEST_FAILED", message: String(error?.message ?? error) }));
				}
			}),
		`settings-sync: GET ${MANIFEST_PATH}`
	);

	// POST /dsh-settings-sync/export —— 取回选中内容（含 profile 配置）。
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "exact",
				path: EXPORT_PATH,
				handler: async (req, res) => {
					if (rejected(ctx, req, res)) return;
					if (req.method !== "POST") {
						sendMethodNotAllowed(res, "POST");
						return;
					}
					if (!isJsonRequest(req)) {
						sendJson(res, 415, { ok: false, code: "UNSUPPORTED_MEDIA_TYPE", message: "content-type must be application/json" });
						return;
					}
					let body;
					try {
						body = await readBoundedBody(req);
					} catch {
						sendJson(res, 400, { ok: false, code: "BAD_BODY", message: "请求体读不出来" });
						return;
					}
					if (body === null) {
						sendJson(res, 413, { ok: false, code: "PAYLOAD_TOO_LARGE", message: "请求体太大" });
						return;
					}
					let raw;
					try {
						raw = JSON.parse(body);
					} catch {
						sendJson(res, 400, { ok: false, code: "BAD_BODY", message: "请求体不是合法 JSON" });
						return;
					}
					const checked = validateExportRequest(raw);
					if (!checked.ok) {
						sendJson(res, 400, checked);
						return;
					}
					try {
						const files = [];
						for (const entry of checked.entries) {
							const path = join(home, entry.rel);
							const text = await readTextFile(path);
							if (text === null) continue;
							files.push({ id: entry.id, rel: entry.rel, label: entry.label, secret: entry.secret === true, text, sha256: sha256(text) });
						}
						const payload = { ok: true, home, profileDir, exportedAt: new Date().toISOString(), files };
						if (raw.includeProfile === true) {
							const paths = Array.isArray(raw.profilePaths) && raw.profilePaths.length > 0 ? raw.profilePaths : listProfileFiles(profileDir).sort();
							const profileFiles = [];
							for (const path of paths) {
								if (typeof path !== "string") continue;
								if (profilePathProblem(path.replaceAll("\\", "/").trim()) !== null) continue;
								const text = await readTextFile(join(profileDir, path));
								if (text === null) continue;
								profileFiles.push({ path, text, secret: PROFILE_SECRET_HINTS.test(path), sha256: sha256(text) });
							}
							payload.profile = { dir: profileDir, name: profileNameOf(profileDir), files: profileFiles };
							try {
								payload.market = marketBackupOf(profileNameOf(profileDir), profileFiles, payload.exportedAt);
							} catch {
								payload.market = null;
							}
						}
						sendJson(res, 200, payload);
					} catch (error) {
						sendJson(res, 200, { ok: false, code: "EXPORT_FAILED", message: String(error?.message ?? error) });
					}
				}
			}),
		`settings-sync: POST ${EXPORT_PATH}`
	);

	// POST /dsh-settings-sync/import —— 写回选中内容（`$DSH_HOME` 文件 + profile 配置）。
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "exact",
				path: IMPORT_PATH,
				handler: async (req, res) => {
					if (rejected(ctx, req, res)) return;
					if (req.method !== "POST") {
						sendMethodNotAllowed(res, "POST");
						return;
					}
					if (!isJsonRequest(req)) {
						sendJson(res, 415, { ok: false, code: "UNSUPPORTED_MEDIA_TYPE", message: "content-type must be application/json" });
						return;
					}
					let body;
					try {
						body = await readBoundedBody(req);
					} catch {
						sendJson(res, 400, { ok: false, code: "BAD_BODY", message: "请求体读不出来" });
						return;
					}
					if (body === null) {
						sendJson(res, 413, { ok: false, code: "PAYLOAD_TOO_LARGE", message: "请求体太大" });
						return;
					}
					let raw;
					try {
						raw = JSON.parse(body);
					} catch {
						sendJson(res, 400, { ok: false, code: "BAD_BODY", message: "请求体不是合法 JSON" });
						return;
					}
					let market = null;
					try {
						market = profileFilesFromMarketBackup(raw);
					} catch (error) {
						sendJson(res, 400, { ok: false, code: "BAD_PROFILE", message: String(error?.message ?? error) });
						return;
					}
					const hasFiles = market === null && Array.isArray(raw?.files) && raw.files.length > 0;
					let profileRaw = raw?.profile;
					// 市场备份可以直接丢进来：它的 `files` 是配置文件（不是 id 表），而 `profile` 只是 profile 名字。
					const profileIsObject = profileRaw !== null && typeof profileRaw === "object" && !Array.isArray(profileRaw);
					if (market !== null && !(profileIsObject && Array.isArray(profileRaw.files))) profileRaw = { files: market.items };
					const hasProfile = profileRaw !== undefined && profileRaw !== null && Array.isArray(profileRaw?.files) && profileRaw.files.length > 0;
					if (!hasFiles && !hasProfile) {
						sendJson(res, 400, { ok: false, code: "EMPTY", message: "请求里既没有 $DSH_HOME 文件，也没有 profile 配置" });
						return;
					}
					let checked = { ok: true, items: [] };
					if (hasFiles) {
						checked = validateImportRequest(raw);
						if (!checked.ok) {
							sendJson(res, 400, checked);
							return;
						}
					}
					const checkedProfile = validateProfileFiles(profileRaw, profileDir);
					if (!checkedProfile.ok) {
						sendJson(res, 400, checkedProfile);
						return;
					}
					try {
						// profile 先写：清单落地后，即使下一步重装失败，用户也还有一份可重试的清单。
						const profileResults = await applyProfileWrites(profileDir, checkedProfile.items);
						const results = await applyWrites(home, checked.items);
						sendJson(res, 200, { ok: true, home, profileDir, results, profileResults });
					} catch (error) {
						sendJson(res, 200, { ok: false, code: "IMPORT_FAILED", message: String(error?.message ?? error) });
					}
				}
			}),
		`settings-sync: POST ${IMPORT_PATH}`
	);

	// POST /dsh-settings-sync/install —— 按恢复后的清单重装插件。
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "exact",
				path: INSTALL_PATH,
				handler: async (req, res) => {
					if (rejected(ctx, req, res)) return;
					if (req.method !== "POST") {
						sendMethodNotAllowed(res, "POST");
						return;
					}
					if (!isJsonRequest(req)) {
						sendJson(res, 415, { ok: false, code: "UNSUPPORTED_MEDIA_TYPE", message: "content-type must be application/json" });
						return;
					}
					let body = "";
					try {
						body = await readBoundedBody(req);
					} catch {
						sendJson(res, 400, { ok: false, code: "BAD_BODY", message: "请求体读不出来" });
						return;
					}
					if (body === null) {
						sendJson(res, 413, { ok: false, code: "PAYLOAD_TOO_LARGE", message: "请求体太大" });
						return;
					}
					if (body.trim().length > 0) {
						try {
							JSON.parse(body);
						} catch {
							sendJson(res, 400, { ok: false, code: "BAD_BODY", message: "请求体不是合法 JSON" });
							return;
						}
					}
					const manager = packageManagerOf(ctx);
					if (manager === null) {
						sendJson(res, 200, {
							ok: false,
							code: "NO_PACKAGE_MANAGER",
							message: `没找到 pnpm。请在 profile 目录手动执行：pnpm install（目录：${profileDir}）`
						});
						return;
					}
					try {
						const result = await runProfileInstall(profileDir, manager);
						sendJson(res, 200, {
							ok: result.ok,
							code: result.ok ? "INSTALLED" : result.timedOut ? "INSTALL_TIMEOUT" : "INSTALL_FAILED",
							profileDir,
							source: manager.source,
							command: [manager.command, ...manager.args, "install", "--prefer-offline"].join(" "),
							exitCode: result.code,
							output: result.output
						});
					} catch (error) {
						sendJson(res, 200, { ok: false, code: "INSTALL_FAILED", message: String(error?.message ?? error) });
					}
				}
			}),
		`settings-sync: POST ${INSTALL_PATH}`
	);
}

/** 自测用：这些函数不依赖任何宿主服务。 */
export const internals = {
	FILES,
	fileById,
	resolveDshHome,
	defaultDshHome,
	expandHomePath,
	sha256,
	readManifest,
	validateExportRequest,
	validateImportRequest,
	applyWrites,
	backupStamp,
	resolveProfileDir,
	listProfileFiles,
	readProfileManifest,
	validateProfileFiles,
	profilePathProblem,
	mergeProfileManifest,
	applyProfileWrites,
	profileFilesFromMarketBackup,
	marketBackupOf,
	profileNameOf,
	packageManagerOf,
	findRuntimePnpm,
	runProfileInstall,
	MANIFEST_PATH,
	EXPORT_PATH,
	IMPORT_PATH,
	INSTALL_PATH,
	MARKET_FORMAT,
	MARKET_VERSION,
	MAX_PROFILE_FILES
};
