# Web instruction payload fix receipt

日期：2026-08-31
工作树：`/Users/cz/code/code/codex/codex-with-chatgpt-loop`
基线：`54427e91b00a96f91c5fa2289c8aa4f7c974af9c`
范围：仅本地实现与自动化验证；未 push、未发布、未执行真实浏览器或真实 Codex provider。

## 修复结论

- 网页 `c2c-task` block 现在必须携带有界的 `TASK_SUMMARY`、`INSTRUCTION` 和
  64 位小写 SHA-256 `APPROVAL_SUMMARY_HASH`。
- 本地 arm 校验并持久化批准摘要、指令和哈希；同一 task 的重复 arm 也比较这三项。
  bridge 在 dispatch 前把 block 与 owner-only durable envelope 逐项比较，篡改或错配
  fail-closed。
- `TaskDispatcher` 将 durable 批准字段传给真实 `CodexCliInvoker`。invoker 只把经过
  相同安全校验的批准字段和固定安全后缀写入 stdin；可执行文件、argv、cwd、sandbox、
  shell 和 approval policy 仍是固定值，不接受任意 shell、URL、凭据或 bypass 参数。
- 浏览器仍只在用户显式点击按钮后发送一次请求；MCP 路径保持只读。

安全边界：`TASK_SUMMARY` ≤ 256 UTF-8 bytes，`INSTRUCTION` ≤ 1,024 UTF-8 bytes；空值、
首尾空白、换行/控制字符、URL、凭据特征、shell 控制符、危险命令、prompt/approval
bypass 词样和不匹配哈希均拒绝。

## 机械证据

修复前先运行的回归测试在旧实现上失败：`tests/codex-invoker.test.ts` 捕获到固定旧
prompt，未包含批准的 instruction。修复后新增/更新负例覆盖：危险 `rm -rf`、URL、
Bearer 凭据、换行注入、缺失摘要、哈希不匹配、浏览器 block 与本地 arm 错配，以及
危险指令在 Codex spawn 前被阻断。

最终命令（均在上述 worktree 执行）：

- `pnpm test`：PASS，18 test files / 154 tests。
- `pnpm typecheck`：PASS。
- `pnpm build`：PASS。
- `git diff --check`：PASS。

## 变更文件

- `src/inbox/approval.ts`
- `src/inbox/task-inbox.ts`
- `src/inbox/task-dispatcher.ts`
- `src/inbox/codex-invoker.ts`
- `src/extension/task-block.ts`
- `src/extension/bridge.ts`
- `extension/content.js`
- `src/cli/index.ts`
- `tests/task-block.test.ts`
- `tests/task-inbox.test.ts`
- `tests/task-dispatcher.test.ts`
- `tests/codex-invoker.test.ts`
- `tests/extension-bridge.test.ts`
- `docs/protocol.md`
- `docs/security.md`

提交 SHA 与本回执 SHA-256 在最终 handoff 中以 `git rev-parse HEAD` 和
`shasum -a 256 docs/research/web-instruction-fix-receipt.md` 为准。

## 未关闭项

本批未安装或操作浏览器扩展，未读取浏览器登录态/cookies/会话索引，未调用真实 Codex
provider。因此以上是本地 contract/静态安全边界与自动化测试 PASS，不是线上或商用验收。
