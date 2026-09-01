# Auto-pair / fixed-port bridge implementation receipt

日期：2026-08-31  
工作树：`/Users/cz/code/code/codex/codex-with-chatgpt-loop`  
基线：`a9dc269`  
范围：本地实现与离线验证；未 push、未部署、未进行 provider 或商用验收。

## 结论

**PASS（本地合同、编译与测试）**；浏览器真实安装、ChatGPT 页面 E2E、provider 和商用验收为 **NOT_RUN**。

- 扩展 bridge 固定监听 loopback `127.0.0.1:62141`。端口被占用时直接失败并保留
  `EADDRINUSE`，不自动漂移；CLI、自启动脚本和 manifest 均不再接受端口输入。
- 用户第一次在 ChatGPT 严格 `c2c-task` 块上点击 `Send to local Codex` 时，由内容脚本
  传递可信用户激活信号；service worker 先调用 `/v1/task/pair`，再用返回的一次性 nonce
  dispatch。nonce 仅驻留 bridge 内存，不写 storage、不重试、不由 popup 手工填写。
- 保留 loopback、请求代理头、ChatGPT/extension origin、extension ID 与 user-activation
  校验，以及 workspace、arm、instruction hash、operation、attempt 和幂等绑定。MCP
  仍为只读；执行器不开放任意 shell、resume 或 approval bypass。
- 自动配对的最小新增安全代价是：具有本机 loopback 访问能力的恶意扩展理论上可竞争首次
  配对。风险由显式可信点击、`event.isTrusted`/`navigator.userActivation`、严格任务块、
  extension-origin/ID 一致性和单次配对共同收敛；详细残余风险见 `docs/security.md`。

## 变更文件

- `src/config/paths.ts`, `src/extension/bridge.ts`, `src/cli/index.ts`
- `extension/manifest.json`, `extension/content.js`, `extension/service-worker.js`,
  `extension/popup.html`, `extension/popup.js`
- `scripts/install-extension-bridge-macos.sh`, `scripts/install-extension-bridge.ps1`
- `tests/extension-bridge.test.ts`, `tests/extension-assets.test.ts`,
  `tests/install-extension-path.test.ts`
- `docs/protocol.md`, `docs/security.md`, `docs/architecture.md`,
  `docs/troubleshooting.md`

## 验证

- `pnpm test`：PASS — 18 test files，157 tests。
- `pnpm typecheck`：PASS。
- `pnpm build`：PASS。
- `git diff --check`：PASS。
- `node --check`（扩展 3 个 JavaScript 文件）及 `sh -n`（macOS 安装脚本）：PASS。
- Windows PowerShell 语法检查：本机未执行；需 Windows runner 或安装 `pwsh` 后补跑。
- 浏览器真实安装/ChatGPT E2E、provider receipt、计费、部署和商业 sign-off：NOT_RUN。

## 提交与费用

提交 SHA 以本回执对应的最终 `git rev-parse HEAD` 为准；未 push。此次未发生付费，实际费用为 `$0`。
