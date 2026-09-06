# C2C 真实网页双轮验收

2026-09-06，当前 Codex desktop 任务主持，复用同一个内置浏览器 ChatGPT 对话。
候选代码基于 b0d836b；本轮补充 Skill/协议的 JSON 输出和格式恢复说明。

## 已完成的真实闭环

隔离示例 normalizeTags：字符串数组首尾 trim、空标签过滤、区分大小写稳定去重、
非法输入明确报错。不涉及 Idea2Paper 代码、私有仓库或其他任务执行。

1. 网页完成初始 PLAN；可见 AX 文本中的嵌套引号不合法，validate-reply exit 2，
   没有本地执行。以新 requestId 在原对话请求格式修正。
2. 网页返回 json 代码块，完整回答结束后提取并验证通过，再采纳执行。
3. 本地 Node v26.0.0 执行五组测试，5 passed / 0 failed / 0 skipped，exit 0。
4. 同一网页审查实际行为摘要，指出非 ASCII 空白、原型同名标签两个覆盖缺口。
   明确没有宣称源码缺陷，也未声称读取源码或独立运行测试。
5. 本地仅追加两组测试；7 passed / 0 failed / 0 skipped / 0 cancelled，exit 0。
   函数实现无需修改，无新增依赖；实际行为探针输出与网页预期一致。
6. 网页第二次审查返回 DONE。回复绑定校验 exit 0；本地核对当前文件与真实测试后
   记录 DONE，c2c gate 的八项检查通过。示例达到目标后停止执行。

网页回合 ID：live_plan_0、live_plan_format_0、live_review_1、live_review_2。
所有发送均先记意图，观察原对话出现对应请求后才记 SENT；没有盲目重发。
本轮没有人为注入浏览器发送超时或用户停止事件，不能宣称这两项真实故障测试已过。

## 改进效果的可复核比较

为了验证新增测试的价值，在独立副本分别植入两种错误：只清理 ASCII 空白、使用
普通对象按属性名去重。两者都通过原五组测试（exit 0），也都被追加后的七组测试
检出（exit 1）。正常实现保持 7/7 通过，未把错误副本用于实际示例或部署。
这是两个定向错误的检出比较，不是一般用户任务成功率或模型质量统计。

前一轮 C2C 实现本身的比较仍见 2026-09-05-planner-loop-v2-receipt.md：
9 个固定场景修复 6 个已知错误，保留 3 个正确行为，候选 9/9，所选场景无回归。
本次协议改进要求 json 围栏、正确转义、保留拒绝结果并用新请求修正，避免本地
重写网页提案后冒充原始通过。更新器针对新 Skill 的 7 项测试通过。

## 证据边界与本地产物

本次通过的是活跃桌面任务主持的真实黑盒功能往返；不等同源码审查、后台反向唤醒、
App 关闭后的持续运行或无人值守全生命周期。gate 仅检查本地审计完整性。
网页回复来自完成后的可见 AX 文本转录，保留内容和回合绑定；不是网络原始字节。

本机原始产物位于工作树 .tooling/live-loop-20260906，受限目录不进入 Git：
request/reply 文件、validate 结果、两轮测试日志、行为探针、mutation-check/results.json、
gate.json、隔离 C2C state 和示例 workspace。没有把用户对话正文或运行数据库提交。

本地 Codex 连接器实际 workspace_info 成功，工作区 ID 与本地 status 一致。
尚不能由此认定同一网页对话已调用连接器；本示例不需要私有源码通道。

## Deep Research 实际调用与来源复核

在同一网页通过 Add files and more → Deep research 选择实际工具，观察到
internal://deep-research 调用、研究计划和运行进度。最终卡片明确显示 Research
completed in 3m，15 citations / 185 searches；这些是界面计数，不代表主持者
独立逐条审查了 185 次搜索。完整报告保留在原网页，不复制用户历史正文到 Git。

报告遗漏了研究专属 app 写入限制，主持者直接核对官方文档后反馈补齐：

- [Deep Research 官方说明](https://help.openai.com/en/articles/10500283-deep-research)：
  研究使用连接 app 的可用读取操作，不使用 app 写入操作。
- [Codex app-server](https://developers.openai.com/codex/app-server)：thread/start、
  thread/resume、turn/start 和终态通知属于 Codex 执行协议；不将其标识当作网页
  conversation URL。官方页面当前重定向到 learn.chatgpt.com/docs/app-server。
- [Workspace Agents trigger](https://developers.openai.com/workspace-agents/trigger-runs)：
  已发布 API channel 有专用外部触发、conversation_key 和幂等请求机制；当前文档
  明确 API 不能返回 agent 回复正文。该专用接口不证明任意已有普通网页聊天可被写入。
- [连接和测试 MCP](https://developers.openai.com/plugins/deploy/connect-chatgpt)：
  官方支持 HTTPS 或 Secure MCP Tunnel 开发连接，要求实际验证工具选择与结果。

以上页面在本轮直接打开并核对相关段落。基于这些文档与本次 UI 验证，继续采用
活跃桌面任务主持；没有迁移到 API planner、发布 Workspace Agent 或扩大执行工具。


研究报告经普通对话整理为 RESEARCH，再由独立新 request 转为 PLAN，两次完整回复
均通过 validate-reply。采纳范围仅为本验收说明：Deep Research 对连接 app 只读；
网页 conversationUrl、Codex threadId/turnId、C2C taskId/requestId 各有用途，不可
混用；格式修复仅修正和重传回执，不重执行已完成的代码或测试。原两轮示例保持
验收关闭，不新增服务、API 或执行能力。静态核对这三项边界与范围声明通过。

## 网页源码通道的实际限制

普通 Pro Chat 首次元数据探针 live_metadata_0 返回 UNAVAILABLE。通过 composer
菜单键入 codex，找到并选中已连接插件后，live_metadata_1 返回 FORBIDDEN：
This conversation does not support developer MCPs。网页未取得 workspaceId/name。
插件详情的 Try in chat 跳到 surface=work；本次未发送或创建 Work 执行任务。
未重配连接器、重启服务或将私有源码粘贴进普通聊天。源码级网页审查仍未验证。

候选 Skill 据此补充：先核验插件是否挂载；明确对话能力限制不能靠 doctor 或
重试修复；保留黑盒已通过与源码通道未通过的独立状态。上述连接器结果不影响
先前无私有数据的真实双轮及 Deep Research 事实，但禁止据此宣称完整源码联动。

## 本机更新完成

实际激活提交：40c20ad1a707da9956dd38ef5b9af570434763d9。
独立 release：/Users/cz/.local/share/codex-with-chatgpt/releases/40c20ad1a707。
该发布副本 build、21 files / 184 tests、真实网页 DONE 的编译 CLI 校验均 PASS。
依赖符号链接指向 release 外的数量为 0；已安装 Skill 不再指向可变开发工作树。

更新器 dry-run 后执行 --apply，返回 updated；安装文件与 release 展开路径后的
Skill 内容逐字一致，CLI smoke 通过。旧版备份逐字一致，目录 0700、文件 0600；
回滚 dry-run 通过。实际备份入口保存在本机 .tooling/live-loop-20260906/activation.json，
不把备份正文放进 Git。之前的隔离更新/真实回滚演练仍有效，本次未把活跃安装
来回切换。当前会话不代表未来新任务已经加载新 Skill；下一次调用应读取安装文件。

服务仍是 PID 67525 监听 127.0.0.1:62141。没有重启或迁移连接器、修改凭据/全局
配置、更新扩展或触碰用户会话数据库；没有 push、merge 或远程生产部署。

最终状态：本机 Skill 更新 PASS；真实双轮黑盒循环 PASS；实际 Deep Research 与
研究转 PLAN PASS；源码级网页 MCP 当前会话 FORBIDDEN；后台反向唤醒 NOT VERIFIED。
后两项不能由本地测试或前两项通过推导为完成。
