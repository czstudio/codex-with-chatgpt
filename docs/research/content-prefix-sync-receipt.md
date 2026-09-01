# Content-script c2c-task prefix sync receipt

日期：2026-09-01
工作树：`/Users/cz/code/code/codex/codex-with-chatgpt-loop`
基线：`1c2d768`
范围：复核已同步到实际 `extension/content.js` 的去围栏 `c2c-task` 首行语言兼容逻辑，并用 DOM fixture 验证按钮注入；未 push、未安装浏览器扩展、未执行真实 ChatGPT/provider 流程。

## 结论

- `extension/content.js` 的 `parseTaskBlock` 仅在文本首行精确为 `c2c-task`、下一段以完整 `[C2C_TASK]` 开始并通过原有闭合标记、字段顺序/唯一性和安全字段校验时去掉前缀；该逻辑已在基线 `1c2d768` 落地。
- 裸任务块和完整 `c2c-task` 围栏保持兼容；普通 inline code、错误语言、首行带后缀或前导空格、缺少任务标记、重复字段和不完整围栏均不注入按钮。
- DOM fixture 直接读取并执行实际 `extension/content.js`，确认 `pre > code`、完整 fenced code 和去围栏语言行各出现一个按钮，负例均不出现；只有可信点击发送结构化消息。

## 机械证据

- `pnpm exec vitest run tests/task-block.test.ts tests/content-dom.test.ts`：PASS，2 files / 5 tests。
- `pnpm typecheck`：PASS。
- `pnpm build`：PASS。
- `node --check extension/content.js`：PASS。
- `git diff --check`：PASS。
- `pnpm test`：BLOCKED；固定 `127.0.0.1:62141` 被 PID `55208` 占用，19 个 test files 中 18 个通过、153 个 tests 通过，`tests/extension-bridge.test.ts` 的 6 个测试无法监听端口。只读 `lsof` 显示该进程 cwd 为 Idea2Paper 主树；本批未停止或修改该进程。

## 变更文件

- `tests/content-dom.test.ts`
- `docs/research/content-prefix-sync-receipt.md`

`extension/content.js` 的前缀解析分支已存在于基线 `1c2d768`，本批没有重复改写该实现，通过实际内容脚本 fixture 补强其边界复核。

## 未关闭项

真实浏览器安装/ChatGPT 页面 E2E、provider、计费、部署和商业 sign-off：NOT_RUN。
本批未发生付费，实际费用为 `$0`；未 push。

提交 SHA 与本回执 SHA-256 在提交后以 `git rev-parse HEAD` 和
`shasum -a 256 docs/research/content-prefix-sync-receipt.md` 为准。
