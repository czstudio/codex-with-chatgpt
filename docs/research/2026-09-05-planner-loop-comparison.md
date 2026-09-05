# ChatGPT Web 与本地 Codex 循环：检索与落地

2026-09-05。以下项目能力来自本轮读取的项目原始 README/文档，是候选设计依据，
不是本机端到端实测。既有本地代码另行核对，不因 README 宣称而认定接入成功。

| 项目 | 原始资料描述的机制 | 本次采用与取舍 |
| --- | --- | --- |
| [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) | 网页规划，本地执行；只读工作区 MCP | 保留当前数据通道、session、execution/checkpoint |
| [AegisLoop](https://github.com/MHW888888/aegisloop) | 本地 bridge、扩展及有界 run/loop 控制 | 借鉴明确循环边界、收发确认和恢复；没有安装新扩展或移植后台服务 |
| [AgentLoop](https://github.com/aiedwardyi/AgentLoop) | 本地 worker/critic 循环、文件记忆、ChatGPT MCP 控制 | 借鉴执行和审查交替；它的本地审查不能直接证明用户要求的网页审查往返 |
| [codex-bridge-chatgpt](https://github.com/anightmonarch/codex-bridge-chatgpt) | 有界上下文包、结构化推理结果、本地逐项采纳 | 增加严格回合绑定和 proposal-only 校验；不传递原始代码日志 |
| [PlanBridge](https://github.com/jbelnick/planbridge) | 只读允许范围、批准的 handoff、隔离 Codex 执行、diff 返回 | 保留工作树和本地权限边界，不新增普通改动逐轮人工批准 |

工程选择：优先让已有 Codex desktop 任务主持循环。另起 daemon 或使用 ephemeral
CLI 不等于继续原 desktop task；现有浏览器扩展还只有手动派发，不是全自动 loop。

[OpenAI App Server 官方文档](https://developers.openai.com/codex/app-server/) 提供
thread/turn 生命周期及完成通知，可作为未来明确端点的执行适配依据；不能由此
推导网页 ChatGPT 自动唤醒或该任务一定出现在当前桌面。

[OpenAI Deep Research 官方说明](https://help.openai.com/en/articles/10500283-deep-research)
明确连接 app 只用读取动作，最终报告带来源。采用“研究报告 → 普通 PLAN → 本地
执行 → 普通 REVIEW”，不依赖 Deep Research 调用写动作。

## 本机核验与本次变更

- 原 audit checkout 为 `e298a1c`；后续 loop checkout 为 `7f190d0`，其中扩展仍需
  trusted user click，只把回执写到页面，不自动送回 ChatGPT composer。
- 新工作树 `codex-with-chatgpt-planner-loop` 从 `7f190d0` 建立独立分支。
- 重写 Skill 入口：明确 brainstorm/research/plan/review、实际浏览器 API、单 owner、
  发送意图/送达/采纳恢复流程、用户停止和循环预算。不改既有扩展的授权规则。
- 新增 validate-reply：拒绝错 task/request/iteration/conversation/mode、半截回答、
  无来源研究结果、不完整计划和仍有未完成项的 DONE。输出仅为提案状态。
- 补齐既有 gate：不能拿旧轮次 DONE、执行前 DONE、带 knownIssues 的 DONE 完成。
- 没有新增自动启动服务、安装扩展、修改生产连接器或调用远端执行 provider。

## 未完成的真实验收

本轮内置浏览器打开 ChatGPT 时 Page.navigate 超时；复用同一 tab 时
Emulation.setFocusEmulationEnabled 再次超时。标签存在但未获得可交互页面。
未读取登录存储，未重发请求，未将网页往返或 Deep Research 标为通过。

后续从已保存的新 Skill 和本工作树继续：恢复可交互的 ChatGPT 浏览器后，在无
私有数据的示例项目执行一次真实两轮“PLAN→执行→修改意见→执行→DONE”，再验证
发送不明不重发与用户停止。无需重复本轮项目检索或安装另一套编排器。
