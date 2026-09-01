# Reverse wake inbox / local browser handoff implementation receipt

> 历史记录：本文记录 2026-08-30 的手工 nonce 原始流程。当前固定端口与自动配对流程以
> [`auto-pair-fixed-port-receipt.md`](auto-pair-fixed-port-receipt.md)、`docs/protocol.md`
> 和 `docs/security.md` 为准。

日期：2026-08-30
工作树：`/private/tmp/c2c-reverse-wake-inbox`
分支：`codex/reverse-wake-inbox`
发布状态：仅本地实现与测试；未 push、未发布、未声称商用验收。

## 已实现边界

- 本地 CLI 才能 arm；任务信封持久化到 owner-only state，并由 dispatcher 以
  `workspace_id`、`arm_id`、`attempt=1` 和 `idempotency_key` 做围栏。
- 恢复只发现 durable pending task，不在重启后盲目重跑；每次显式 arm 最多一次
  dispatch。MCP 仅提供 `task_status` / `task_result` 只读观察。
- 可选 Chromium 扩展仅在 ChatGPT HTTPS 页面识别严格的 `c2c-task` block；页面
  必须由用户点击注入按钮。bridge 只绑定 loopback，要求 extension origin 与一次性
  nonce，nonce 在请求体校验前消费，失败或网络结果不明确时扩展清除本地 nonce。
- 执行器只调用固定的 `codex exec --ephemeral --json --color never --sandbox
  workspace-write --cd <workspace> -`，使用固定 stdin prompt、`shell: false`、超时和
  输出上限；不支持任意 shell、`resume`、session 访问或 approval bypass。
- 提供 macOS launchd 与 Windows Task Scheduler 的 per-user 安装/卸载脚本；脚本
  只注册固定 `c2c extension start`，不会自行 arm 或 dispatch。

## 变更文件

实现与测试：

- `src/inbox/codex-invoker.ts`
- `src/extension/task-block.ts`
- `src/extension/runtime.ts`
- `src/extension/bridge.ts`
- `src/cli/index.ts`
- `extension/manifest.json`, `extension/content.js`, `extension/service-worker.js`,
  `extension/popup.html`, `extension/popup.js`
- `scripts/install-extension-bridge-macos.sh`,
  `scripts/uninstall-extension-bridge-macos.sh`,
  `scripts/install-extension-bridge.ps1`,
  `scripts/uninstall-extension-bridge.ps1`
- `tests/task-block.test.ts`, `tests/codex-invoker.test.ts`,
  `tests/extension-bridge.test.ts`, `tests/extension-assets.test.ts`

协议、安全与回执：

- `docs/protocol.md`
- `docs/security.md`
- `docs/research/implementation-receipt.md`

## 验证记录

下列命令均已在本 worktree 执行：

- `pnpm typecheck`：通过。
- focused Vitest（task block、固定 invoker、bridge、extension assets）：4 个文件、
  10 个测试通过。
- `pnpm test`：17 个文件、148 个测试通过。
- `pnpm build`：通过；`git diff --check`：通过。
- macOS shell 与 extension JavaScript 语法检查：通过。Windows PowerShell 安装脚本未
  执行系统安装；本机没有 `pwsh`，因此 PowerShell 解析检查未运行。

## AegisLoop 对照审计（独立目录）

固定 SHA：`e3bd295f7995751a1bb9747a963a7ab7a269e36f`
目录：`/private/tmp/source-audit-aegisloop`
仓库：`https://github.com/MHW888888/aegisloop.git`
状态：固定 SHA、clean checkout；未修改、未提交、未 push，也未覆盖 c2c worktree。

执行结果：

- `npm run check`：通过（静态检查、unit、bridge、fixture 全部通过；退出码 0）。
- `npm run doctor`：0 fail、9 warn。WARN 为本机未配置的 `config.json` / API token、
  示例占位符、Codex 路径/能力检查限制，以及 localhost host permission 覆盖动态
  端口等配置提示；未启用任何秘密或浏览器状态。
- checkout 没有 `node_modules`；check 脚本仍完成其离线静态与 fixture 检查。没有启动
  浏览器，没有读取 cookies、profile、会话正文或索引。

仅采纳并在 c2c 中独立实现、且已由审计/测试验证的安全思路：显式 arm 与 fence、一次性
turn nonce、loopback/origin 检查、durable recovery 与 ambiguous result 不盲重跑、结构化
有界结果。未复制 AegisLoop 的 session-resume adapter、API token 体系、leader lease/ACK
协议、`fullAuto`/auto-approval 配置或通用 configured spawn；这些与本项目禁止会话访问、
禁止自动批准、禁止通用 shell 的边界冲突或超出本批范围。

## 仍需人工步骤 / 限制

实际浏览器安装未在本批执行，仍需人工：构建 c2c；运行
`c2c extension start --workspace <path>`；另一个本地终端运行
`c2c extension nonce --workspace <path>`；在 `chrome://extensions` 开启 Developer
mode，Load unpacked `extension/`，在 popup 输入端口与一次性 nonce；在 ChatGPT 页面
粘贴严格 block 并点击注入按钮。此流程不自动读取登录状态、cookies 或 profile。

本批未对真实 Codex provider 做执行型 smoke run；invoker 使用受控 runner seam 测试。
因此本回执是本地实现/离线验证证据，不是在线、生产或商业验收证据。
