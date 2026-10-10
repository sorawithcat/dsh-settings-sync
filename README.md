# dsh-settings-sync

把「换电脑后不用重搞」这件事一次做完：**一份 JSON 带走插件清单、profile 配置、`$DSH_HOME` 文件、浏览器本地设置**，到新机器导入后还能直接**重装插件**。

它是插件市场「备份与恢复」的超集，并且和它**格式互通**：

| 范围 | 插件市场 | 本插件 |
| --- | --- | --- |
| 插件清单 + profile 配置（`package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml` 等） | ✅ | ✅（同一份 `dsh-profile-backup` 0.2 格式） |
| 导入后自动 `pnpm install` | ✅（恢复时自动跑） | ❌（导入后在页面点一次「重装插件」，失败可手动重试） |
| `$DSH_HOME` 根目录文件：`AGENTS.md`、`pet.json`、`skin-center-active.json` | ❌ | ✅ |
| `$DSH_HOME/storages/workspace.json`（工作区列表） | ❌ | ✅ |
| 浏览器 localStorage（主题外的界面偏好等） | ❌ | ✅ |
| 账号凭据 `.credentials.yaml` | ❌ | ✅（默认不导出，需显式勾选） |
| WebDAV / GitHub Gist 传输 | ✅ | ❌（这两个是传输通道，不是功能；用本地 JSON 文件即可） |

## 用法

设置 → **设置同步**（侧边栏「插件」分组里，插件市场下面）。

1. **老机器**：勾选要带走的项 → **导出 JSON** → 得到 `dsh-settings-<日期>-<时分>.json`。本机没有的项勾不上（标着「本机没有这个文件（导不出）」），浏览器本地数据读不到时（隐私模式）会明说，不会假装没有。
2. **新机器**：装好本插件 → **导入…** 选这个文件 → 看预览 → 确认导入。宿主半区读不到文件清单（例如没重启 DSH）时不会硬开一份全是「跳过」的假预览，而是直接取消并说明；个别本机文件内容读不到时也会在预览上方标一句「这次对比可能不完全准」。
3. **新机器**：点 **重装插件**，或按导入后的提示手动 `pnpm install`；然后**完整重启 DSH**。
4. 只想搬插件清单和 profile 配置时，可以点 **导出市场格式**，得到的 `dsh-profile-backup-<日期>-<时分>.json` 能直接丢给市场的「备份与恢复」（反之，市场导出的备份也能整份丢进本插件的 **导入…**）。

预览里的动作：

| 动作 | 含义 |
| --- | --- |
| 新增 | 本机没有这一项 |
| 覆盖 | 本机有，内容不同 |
| 覆盖（无法对比） | 本机有这一项，但内容没拉到手（例如没勾选它就没读本机内容） |
| 合并 | `package.json`：清单按市场同款规则合并，不是整份覆盖 |
| 相同 | 内容一致，导入时会跳过 |
| 跳过 | 本机不认识这一项（id 不在固定表里）；所以它只会出现在配置文件那一组 |

## 导入的行为

- **路径只来自固定表**：`$DSH_HOME` 文件只传 id，路径由宿主半区的表决定；profile 文件走市场同款校验（拒绝绝对路径、盘符、`..`、`node_modules` 等），协议层不可能写到别处。
- **先写 profile，再写 `$DSH_HOME`**：清单先落地，即使接下来重装失败，也还有一份可重试的清单。
- **先备份再覆盖**：覆盖已有文件前先写 `<文件名>.bak-settings-sync-<时间戳>`；老文件读不出内容（超过 1 MB / 不是 UTF-8）时改用整份复制，同样留一份备份。
- **原子替换**：先写同目录临时文件再 `rename`，中途失败不会留下半截文件。
- **`package.json` 是合并，不是覆盖**（依赖与 bundles 的规则与市场 `mergeRestoreManifest` 一致）：
  - `dependencies` 取并集，同名以**导入文件**为准；
  - `dsh.profile.bundles` 取并集，本机在前、去重；
  - 其它顶层字段以**导入文件**为准，导入文件里没有的字段保持本机原样（比市场那一版保守：本机独有的 `scripts` / `devDependencies` 不会被合并动作丢掉）；
  - `dsh` 里同名的子键以**本机**为准。
- **内容相同就跳过**：重复导入不会产生多余的备份。
- **不认识的 id 跳过，非法路径整份拒绝**：id 不在固定表里的条目不会写入（预览里标「跳过」），也不会让整次导入失败；而 profile 里出现绝对路径 / 盘符 / `..` / `node_modules` 这类路径时是**刻意整体拒绝**（400，一个字节都不写），因为那种文件多半是被改过的。

## 接口（宿主半区）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-settings-sync/manifest` | 本机有哪些可导出的项（含 profile 配置文件清单） |
| POST | `/dsh-settings-sync/export` | `{ids, allowSecrets?, includeProfile?, profilePaths?}` → `$DSH_HOME` 文件内容；`includeProfile` 时附 `profile` 与市场格式 `market` |
| POST | `/dsh-settings-sync/import` | `{files:[{id,text}], profile:{files:[{path,text}]}}`；也接受整份市场备份 |
| POST | `/dsh-settings-sync/install` | 在 profile 目录跑 `pnpm install`，返回退出码与输出尾部 |

都是本机 loopback 接口，先过 DSH 的跨站 / 未登录栅栏，只收 `application/json`，且拒绝时返回 403 / 405 / 415 / 400。

## 重装插件

「重装插件」在 profile 目录执行 `pnpm install --prefer-offline`，pnpm 的来源按优先级探测：

1. 启动器发布的 `profileContext.packageManager`；
2. 环境变量 `DSH_SETTINGS_SYNC_PNPM`（指向 `pnpm.mjs`；它会被当前 Node 当脚本执行）；
3. `$DSH_HOME/dsh-runtimes/<runtime>/dependencies/` 里自带的 `pnpm/bin/pnpm.mjs` + `node/bin/node`。

超时 5 分钟，输出只保留尾部 32 KB；结束返回 `INSTALLED` / `INSTALL_FAILED` / `INSTALL_TIMEOUT` / `NO_PACKAGE_MANAGER`（最后一种会给出可照抄的命令和目录）。

## 安全与隐私

- 所有接口都是本机 loopback（`/dsh-settings-sync/*`），插件不联网、不上传。
- 上限：单次请求 8 MB、单文件 1 MB、profile 文件最多 256 个、localStorage 最多 500 个键、旧格式文件表最多 64 个。
- `.credentials.yaml`（账号凭据）**默认不进导出**；要显式勾选才会写入，文件里带 `secret: true` 标记，导入预览里这些条目会挂上「含凭据」标记并在确认框里单独提醒。
- profile 里命中 `config.toml` / `.env*` / `secrets*.json` / `pnpm-workspace.yaml` 的文件标为敏感，默认不勾选。
- 会话草稿（`dsh.conversation.*`、`dsh.sidebar-right.*`、`dsh.user-questions.drafts.*`）会列出来但**默认不勾**，它们跟着会话走，跨机搬过去没有意义。

## 导出的 JSON 结构

```json
{
  "format": "dsh-settings-sync",
  "version": 1,
  "exportedAt": "2026-10-09T07:00:00.000Z",
  "app": "dsh-desktop",
  "home": "C:\\Users\\<你>\\.dsh",
  "origin": "http://127.0.0.1:19387",
  "files": [{ "id": "agents", "rel": "AGENTS.md", "label": "全局工作规则", "secret": false, "sha256": "…", "text": "…" }],
  "profile": [{ "path": "package.json", "secret": false, "sha256": "…", "text": "…" }],
  "market": { "format": "dsh-profile-backup", "version": 0.2, "createdAt": "…", "profile": "desktop", "files": [] },
  "browser": { "storage": [{ "key": "dsh.workspace.view.v5", "value": "{}", "scope": "state" }] }
}
```

`profile` 数组里的每个条目都必须是 `{ path, text }`（外加可选的 `secret` / `sha256`）；`{ "path": "package.json", "json": { … } }` 这种写法只在**顶层整份市场备份**（`format: "dsh-profile-backup"`、`version: 0.2`）里被接受，导入时按市场备份整体解析。

## 自测

```bash
node test/run-tests.mjs
```

68 项，不需要 DSH、不需要浏览器：伪造 localStorage / React / fetch 后加载 `client.js` 测纯逻辑与界面装配，宿主半区在临时目录里跑真实的文件读写，覆盖四条路由的边界（405 / 415 / 400 / 未知 id / 敏感文件 / 栅栏拒绝 / 路径穿越 / 非普通文件与读不出内容的老文件也先备份 / 不产生多余备份 / profile 文件数严格卡在 256 / 清单合并 / 市场格式互通 / 上限整份拒绝 / 装配失败仍留可见席位 / 无包管理器与真实跑一次假 pnpm）。

## 出问题时

- 设置里出现「**设置同步（加载失败）**」这一页：客户端半区装配出错（例如 `slots` 服务坏了），卡片上写着具体错误，宿主日志里也有一条 error 级记录——插件不会静默变成「好像没装」。
- 页面顶上说「宿主半区不可用」：宿主那半边没加载（通常是没完整重启 DSH），导出/导入/重装都用不了。
- 导出/导入/重装失败都会在页面下方给出原文错误；重装失败还会附上 pnpm 输出的尾部。

## 已知限制

- 插件文件本身（`node_modules`）不导出，新机器靠 pnpm 按清单重装；`link:` 这类本机绝对路径依赖不可移植，需要改成可发布的 spec。
- 不做 WebDAV / Gist 传输（市场那份已经能用），也没有做成 dshmarket 那样的定时快照。
- 会话历史（`$DSH_HOME/sessions`、附件）不在范围内。
- 导入是覆盖式写入，没有逐字段 diff；本机有改动而导出文件较旧时，导入会用旧内容覆盖（有 `.bak-settings-sync-*` 备份可回退）。
- 重装插件不改 `cordis.patch.yml`；清单里新增的 bundle 若需要额外 patch 条目，仍需手工确认。
