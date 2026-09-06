# Web planner ↔ local Codex loop

2026-09-05。默认采用当前 Codex desktop task 主持的循环；网页不是本地 shell。
本协议复用 execution/checkpoint/session。新增 validate-reply 只做回合关联校验，
不提供网页消息传输、后台调度或执行授权。

## 回合与验收

`brainstorm → research（按需）→ plan → local execution → review → plan / DONE`

- brainstorm 返回 IDEAS，research 返回 RESEARCH，然后由独立 plan 请求产生 PLAN。
- plan 返回 PLAN；review 返回 PLAN（有修改）或 DONE；各阶段可返回 BLOCKED。
- taskId 固定；iteration 是本地执行轮次；requestId 每个网页请求唯一。
- 首次 planning 使用 iteration 0；执行其计划记 iteration 1，并请求 review 1。
  review 1 返回的修改在 iteration 2 执行，以此类推。
- conversationUrl 必须是实际已观察到的 `https://chatgpt.com/c/<id>`。新对话先发
  不含私有信息的启动说明，地址落定后才创建 request。不能猜 id 或覆盖别的聊天。
- 新 request 的 task/round/url/mode 由本地确定，不能从网页回答反推 expected。
- 当前工具只接受标准 /c/ 地址；若实际 UI 使用项目或其他路由，先显式适配并测试，
  不随意改 URL 或把别的会话当成同一会话。

保存 `request.json`（本机受限目录、不提交用户对话正文）：

```json
{
  "taskId": "demo",
  "requestId": "demo-review-1",
  "iteration": 1,
  "conversationUrl": "https://chatgpt.com/c/demo-123",
  "mode": "review"
}
```

对网页发送以下简短请求，五个绑定字段必须逐项回显；示例地址必须换成真实地址：

> 你负责规划与独立审查，本地 Codex 执行。继续原目标，不能扩大授权范围。
> 本次 request 为上述 JSON。请读取已连接工作区的执行记录与当前差异，指出未完成项。
> 只在目标的验收标准全部满足时建议 DONE，否则给具体 PLAN 或 BLOCKED。
> 最终只返回一个 json 代码围栏，里面是合法 JSON：version=1，回显全部 request 字段，
> state，summary，rationale[]，actions[]，tests[]，successCriteria[]，issues[]，
> sources[{url,claim}]。actions 是自然语言修改建议，不是可直接执行的 shell。
> 字符串内的引号与换行必须按 JSON 转义；测试案例也可用自然语言描述，避免嵌套引号。

```json
{
  "version": 1,
  "taskId": "demo",
  "requestId": "demo-review-1",
  "iteration": 1,
  "conversationUrl": "https://chatgpt.com/c/demo-123",
  "mode": "review",
  "state": "PLAN",
  "summary": "补齐空输入处理",
  "rationale": ["空输入仍然访问第一个元素"],
  "actions": ["在解析函数中处理空输入并返回空列表"],
  "tests": ["运行空输入回归用例和已有解析测试"],
  "successCriteria": ["空输入返回空列表，已有解析行为不变"],
  "issues": ["缺少空输入处理"],
  "sources": []
}
```

把已完成的单条网页回答保存成 reply.txt，然后：

```sh
node bin/c2c.js validate-reply --request request.json --reply reply.txt --json
```

成功只产生 `authority: proposal-only`，不回显或执行网页 actions。返回 DONE 时
下一步是 verify-local-evidence。失败 exit 2；网页内容不得拼入 shell/命令替换。
失败仍保留 `error: PLANNER_REPLY_REJECTED`，另返回固定枚举 `reason` 与 `next`，
不输出解析器错误原文、网页正文、用户字段名或文件路径。常见恢复方向如下：

| reason | next 的含义 |
| --- | --- |
| INVALID_REQUEST | 修正本地 request，不消耗网页回合 |
| INPUT_UNREADABLE / INPUT_NOT_BOUNDED_FILE | 检查本地输入文件与大小 |
| INVALID_REPLY_JSON / INVALID_REPLY_FENCE | 确认完整回复后请求格式修正 |
| INVALID_REPLY_JSON_DUPLICATE_KEY / REPLY_MISMATCH_* | 核对含糊或串轮回复，不能直接重发 |
| DONE_HAS_UNRESOLVED_WORK | 处理实际未完成项，不能靠改格式完成 |

`next` 只是诊断提示，不授权执行或自动重发；发送与恢复仍按原检查点协议。
文件读取检查同一个已打开的普通文件，最多读取 64 KiB 加一个超限检测字节；
文件在大小检查后增长也不会产生无界读取。输入超过上限仍拒绝，不静默截断。

格式失败时保留原回复和拒绝结果，不在本地替网页修复后冒充原始通过。确认上一轮
已结束后，可用新 requestId 请求格式修正；仍绑定原 task、iteration、URL 和 mode，
不增加执行轮次。修正请求同样记录发送与采纳检查点。优先读取代码块，避免普通
Markdown 渲染改变转义字符；只有 AX 文本时注明提取方式，不能宣称是原始传输字节。
研究报告不一定输出 JSON：读完完整报告后，用一个独立新 request 请普通对话整理
成 RESEARCH JSON（保留来源），再发 PLAN。不能把两次请求混成同一回执。

## 发送与恢复

单 owner 串行维护现有 checkpoint：发送前 `WEB_SEND_INTENT_<requestId>`；看到
同一 user turn 出现该 id 后 `WEB_SENT_<requestId>`；完成回答通过 validate-reply
并且本地检查后 `WEB_ADOPTED_<requestId>`。summary 只放简短事实，next 放原
request/reply 路径和下一步。相同 request 的检查点重放不能再次发送或执行。

中断在 SEND_INTENT：先核对同一聊天是否已出现请求；不确定则保留待核验状态，
不静默重发。中断在 ADOPTED/EXECUTING：检查本地进程与现有改动，不能二次执行。
requestId 防串轮，不能证明网页模型身份、传输成功或形成分布式 exactly-once。

本地执行轮次记录后再请求审查。gate 拒绝带 knownIssues、先 DONE 后 execution、
或已有更高轮次记录的旧 DONE。它仍只验证调用者提供的记录：测试摘要非空不能
证明测试通过。主持者必须核验实际命令退出结果及产物，不能仅听取模型自述。

## Deep Research

核验真实功能入口、选中状态、报告终态和来源。等待研究不增加执行次数。
以事实来源、候选方案、取舍和未知项为研究产物，普通 PLAN 回合负责转为工程动作。
目前官方说明 Deep Research 只使用连接 app 的读取操作，不通过它派发本地写入。
参考：[OpenAI Deep Research](https://help.openai.com/en/articles/10500283-deep-research)。

## 能力边界

| 通道 | 实际职责 | 不能推导出的能力 |
| --- | --- | --- |
| C2C read-only MCP | 提供工作区、diff、执行记录 | 自动触发 ChatGPT 下一轮 |
| Codex desktop 主持 + browser | 活跃任务内发送、收取、执行和复查 | App 关闭后仍自动运行 |
| 当前 extension | 已 arm 任务的用户点击派发及页面结果 | 自动回填 composer 或无人值守多轮 |
| Codex app-server | 官方 thread/turn 执行协议 | 任意桌面任务自动可见或网页版自动醒来 |
| validate-reply + gate | 拒绝错轮回复和不完整完成记录 | 真实浏览器、provider、业务验收 |

真实闭环最低证据：同一会话 PLAN → 本地实际修改+测试 → 网页指出一项修改 →
第二次实际执行+测试 → 网页 DONE → 本地验收通过。还应验证发送超时不重发、
用户停止后无后续派发。离线 fixture 不算这条证据。
