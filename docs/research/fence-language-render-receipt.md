# Fence-language render compatibility receipt

日期：2026-09-01

工作树：`/Users/cz/code/code/codex/codex-with-chatgpt-loop`

基线：`7f1132a`
范围：兼容 ChatGPT 将 `c2c-task` 围栏渲染为 `<code>` 首行语言、去掉反引号的 DOM 形态；未 push、未发布、未执行真实浏览器或 provider。

## 结论

- `parseTaskBlock` 和扩展内容脚本现在接受严格的 `c2c-task\n[C2C_TASK]...[/C2C_TASK]` 形态，首行语言必须精确匹配，任务标记和字段仍按原有完整、顺序固定规则校验。
- 裸 `[C2C_TASK]...[/C2C_TASK]` 块与完整 `c2c-task` 反引号围栏保持兼容；普通 inline code、错误语言、缺少标记和重复字段均继续拒绝。
- DOM fixture 覆盖 `pre > code`、完整 fenced `code`、去反引号语言行 `code`，以及上述负例；仅合法节点注入按钮，只有可信点击发送结构化消息。

## 机械证据

- `pnpm exec vitest run tests/task-block.test.ts tests/content-dom.test.ts`：PASS，2 files / 5 tests。
- `pnpm typecheck`：PASS。
- `pnpm build`：PASS。
- `node --check extension/content.js`：PASS。
- `git diff --check`：PASS。
- `pnpm test`：BLOCKED；18 files / 153 tests 通过，`tests/extension-bridge.test.ts` 的 6 个测试因固定 `127.0.0.1:62141` 被 PID `48979` 占用而失败。只读 `lsof` 显示该监听进程工作目录为 Idea2Paper 主树；本批未停止或修改该进程。释放端口后需重跑完整套件。

## 变更文件

- `src/extension/task-block.ts`
- `extension/content.js`
- `tests/task-block.test.ts`
- `tests/content-dom.test.ts`
- `docs/research/fence-language-render-receipt.md`

## 未关闭项

真实浏览器安装/ChatGPT 页面 E2E、provider、计费、部署和商业 sign-off：NOT_RUN。
本批没有付费，实际费用为 `$0`；未 push。

提交 SHA 与本回执 SHA-256 在提交后以 `git rev-parse HEAD` 和
`shasum -a 256 docs/research/fence-language-render-receipt.md` 为准。
