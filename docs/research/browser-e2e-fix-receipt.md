# Browser DOM rendering fix receipt

日期：2026-09-01
工作树：`/Users/cz/code/code/codex/codex-with-chatgpt-loop`
基线：`f2dcef4`
范围：内容脚本 DOM 兼容与离线 fixture 验证；未 push、未发布、未执行真实浏览器或真实 Codex provider。

## 修复结论

- 内容脚本现在扫描所有 `code` 节点，因此同时兼容 ChatGPT 的 `pre > code` 和
  独立 `code` 渲染结果。
- 每个候选节点仍必须通过完整、顺序固定的 `c2c-task` 解析；普通 inline code、
  不完整 fence、未知字段和不匹配的批准摘要哈希不会注入按钮。
- 注入与发送边界未放宽：按钮仍需显式可信点击，service worker 仍负责固定端口
  自动配对和一次性 nonce，bridge 仍执行 origin、workspace、arm、attempt、幂等键、
  指令及批准摘要哈希绑定。

## 机械证据

- `pnpm exec vitest run tests/content-dom.test.ts`：PASS，1 file / 1 test；fixture
  覆盖 `pre > code`、独立 fenced `code`、普通 inline code、不完整 fence，以及点击前
  不发送和可信点击后的结构化消息。
- `pnpm typecheck`：PASS。
- `pnpm build`：PASS。
- `node --check extension/content.js`：PASS。
- `git diff --check`：PASS。
- `pnpm test`：BLOCKED；命令已启动并有 18 个 test files / 152 tests 通过，6 个
  `extension-bridge` 测试因固定 `127.0.0.1:62141` 被 PID `41440` 占用而失败。
  `lsof` 显示该进程工作目录为 Idea2Paper 主树；本批未停止或改动该进程。释放端口后
  必须重跑完整 `pnpm test`。

## 变更文件

- `extension/content.js`
- `tests/content-dom.test.ts`
- `docs/protocol.md`
- `docs/research/browser-e2e-fix-receipt.md`

## 未关闭项

真实浏览器安装/ChatGPT 页面 E2E、provider、计费、部署和商业 sign-off：NOT_RUN。
完整测试套件唯一阻塞为外部固定端口占用，不是本次 DOM fixture 失败。

提交 SHA 与本回执 SHA-256 在释放端口并完成最终验收后，以 `git rev-parse HEAD` 和
`shasum -a 256 docs/research/browser-e2e-fix-receipt.md` 为准；未 push。此次未发生付费，
实际费用为 `$0`。
