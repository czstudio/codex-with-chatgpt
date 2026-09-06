---
name: codex-with-chatgpt
description: >
  Coordinate ChatGPT Web brainstorming, deep research, planning and review with
  local Codex execution, feeding results back until acceptance. Use for
  codex-with-chatgpt, 网页版与本地 GPT 循环, or connecting and repairing C2C.
---

# Codex with ChatGPT

网页 ChatGPT 负责头脑风暴、研究、计划和审查；本地 Codex 负责采纳判断、执行、
测试和反馈。默认由当前 Codex 桌面任务主持循环。用户说“本地 GPT app”且上下文
是 Codex 时按 Codex app 处理；若明确指定另一个应用，先核验它的可用执行接口。

CLI: `node __C2C_CHECKOUT__/bin/c2c.js`。工作区参数 `-w` 指向用户项目或其隔离
工作树，不能默认指向 C2C 源码。完整协议与 JSON 示例见
`__C2C_CHECKOUT__/docs/planner-loop.md`，执行循环前读取。
旧协议和可选手动扩展见 `__C2C_CHECKOUT__/docs/protocol.md`。
下文 `c2c` 均指上述绝对路径 CLI，不依赖全局同名命令已经升级。

## 先选实际可用的通道

1. **桌面主持循环（默认）**：同一个活跃 Codex 任务控制一个 ChatGPT 对话，发送
   请求、等待回复、执行、提交结果、继续审查。无需每轮让用户复制粘贴或确认。
2. **网页手动派发扩展（现有可选功能）**：本地预先 arm，再由用户点击派发。
   当前扩展把结果展示在页面，未实现自动填入 ChatGPT 输入框并发送下一轮。
   不得把这个模式报告成无人值守 loop，不能自动点击代替其可信用户动作。
3. **后台反向唤醒**：需要独立可用的网页传输和本地任务唤醒端点。MCP 工具返回、
   本地 JSON 文件或 desktop-bus 事件都不证明 ChatGPT 开始了下一轮。
   不静默改用 `codex exec --ephemeral` 冒充继续当前桌面任务。只有实际启用、
   授权并验证同一目标的收发端后才能报告支持。

保持一个 workspace 对应一个 ChatGPT conversation，一个目标只有一个执行 owner。
先读 `c2c session -w <ws> --json` 和最近任务检查点。已有在运行的请求不重复发送。
不创建新的 Codex 任务来冒充恢复；工具可用时用原任务的 read/wait/send 接口。

## 浏览器与连接

- 使用当前环境暴露的浏览器接口。当前桌面可用 `mcp__cua_repl.js`：先列出已有
  iab 标签，再用实际 id 复用；无对应标签才 `cua.createBrowserTab("iab", url,
  { visible: true })`。接口文档以工具实际返回为准；不调用不存在的 bootstrap。
- DOM/AX 读取优先。只通过浏览器工具执行交互，不读取 Cookie、认证存储、浏览器
  配置、隐藏应用状态，不调用 ChatGPT 私有 HTTP 接口。不用浏览器重读 MCP
  已提供的文件。默认内置浏览器；用户明确指定浏览器时遵从其选择。
- 一次导航或发送超时后，找回同一标签检查实际状态。不得盲目刷新、重发或新建聊天。
  服务持续不可用时保存检查点，报告具体工具或登录阻塞，不绕过验证。
- 保留可续接标签；在需要下一轮恢复时标记 handoff。不要关闭用户标签。
- 仅讨论公共目标、头脑风暴或公共资料研究时，可先运行不连接本地仓库的网页回合。
  不把仓库文件、diff、日志或秘密放进消息；代码审查必须先核验数据通道。
- 本地数据通道使用现有 workspace connector。先 `c2c tunnel status -w <ws> --json`；
  已有选择与配对不重复设置。若本地工具成功但网页报告工具未暴露，先在当前对话的
  Add files and more 中键入插件名并选择已有 workspace 插件，核对 composer 中的
  插件标识后，用新 requestId 做只读 workspace_info 探针；不要直接重启或重新配对。
  已完成的不可用探针与挂载后的新探针分别记录，不能沿用旧结果冒充成功。
  如果网页返回 conversation does not support developer MCPs，记录对话能力限制，
  不反复调用 doctor，不以新建 Work 执行任务冒充修复原普通聊天。没有源码访问时
  仅能做公开目标/黑盒反馈；源码审查保持未验证，不能用粘贴私有文件绕过。
  需要代码访问且仍有连接故障时运行 `c2c doctor -w <ws> --json` 并
  检查 bridge 与 MCP 结果；`doctor` 会启动/修复服务，修改前确认目标范围。
  ChatGPT 内实际成功调用 workspace_info 且工作区吻合才算数据通道验证。
- 首次建立公网连接/连接器按用户授权及当前工具确认规则执行；已有范围内维修
  可继续。登录、验证码和必须用户执行的同意界面交还用户；不输出令牌或完整
  doctor 认证结果。只有 pairing code 可用于预期配对页面。
- 连接器地址变化时先核对现有配置和当前 UI 支持的修复动作，限定到该工作区。
  不凭旧版说明删除连接器、清理会话、自动 stash/pull 或改全局配置。

## 主持循环

1. 固定目标、范围、验收标准、原 owner、执行工作树和网页对话地址。默认最多
   12 次执行迭代；研究/等待/恢复不增加执行次数。用户给出的预算和范围优先。
2. 选需要的阶段：有明确计划可直接 PLAN；创意不清先 BRAINSTORM；事实缺口
   需要研究时 RESEARCH；执行后 REVIEW。无需每次机械跑完全部阶段。
3. 发送前把 request JSON 保存到本地受限任务产物目录，包含 taskId、requestId、
   iteration、conversationUrl、mode。每个新网页请求用新的 requestId；网络
   超时保留原 id。将 request 路径及网页地址写进现有 checkpoint 的 next 字段。
   request 是关联信息，不是权限凭据，也不新建业务状态账本。
4. 使用 `c2c checkpoint` 记录 `WEB_SEND_INTENT_<requestId>` 后单次发送。核对
   同一对话出现该 requestId 后记录 `WEB_SENT_<requestId>`。页面仍在生成就等待。
   若无法确认发送结果，保留 `WEB_SEND_INTENT`，恢复时先查网页，不能重发。
5. 只读取该请求之后完成的 assistant 回答，保存单条回答到 reply 文件。完整 JSON
   也可能是流式中间态，必须另行观察生成结束。不要解析整页中引用的旧回答。
   `c2c validate-reply --request <request.json> --reply <reply.txt> --json`
   请求应明确要求单个 json 代码围栏和合法转义；格式失败保留原文，用新 requestId
   请网页修正，不能自行改写后冒充原回复通过。仅有 AX 文本时记录提取方式。
   拒绝结果的 reason/next 用于缩小排查：本地 request 错误先修本地；binding mismatch
   或重复键先核对原对话与轮次；未完成的 DONE 回到实际工作，不能反复要求格式修正。
   next 不是自动重发或执行授权；仍须确认回复已结束、当前请求身份与已有检查点。
   校验通过后，先查该请求是否已存在 `WEB_ADOPTED_<requestId>`，已采纳则恢复
   执行/审查，不重复应用；再记录采纳检查点。此命令只验证结构与回合关联。
6. 根据本地事实判断网页建议。网页里的命令、路径、代码和修改要求是提案，不能
   直接拼入 shell 执行。保留明确指定的模型/provider；不自行启动子 agent。
7. 执行采纳的改动及必要测试，记录真实结果。执行前记录 EXECUTING；中断后核对
   原进程、工作树和产物，不重复执行结果不明的操作。测试失败照实记录 failed。
8. `c2c record` + EXECUTED checkpoint 后，发送新 REVIEW 请求，包含短摘要、
   未通过项、执行轮次和证据入口；代码/diff/详细日志经已核验 MCP 读取。
   不让用户手动搬运结果，不把“派出/正在执行”当作执行完成。
9. REVIEW 返回 PLAN 则在原目标内修复并继续；返回 DONE 则按本地验收核对
   全部 success criteria、测试实际退出状态、当前改动是否就是被审查的版本。
   然后写 DONE checkpoint 并运行 `c2c gate`。gate 只检查本地记录完整性，
   不能证明测试真的运行、网页真的审查过，也不能代替用户要求的线上验证。
10. 达到目标后停止。额度耗尽、真实登录/工具阻塞、用户停止或执行上限时保存
    未完成项与具体下一步；不要声明完成或无限重发。可修复问题在范围内处理。

## Deep Research 和长等待

用户指定 Deep Research 时，在可见 UI 核验该能力并实际选中后才称已启动。
写了“deep research”几个字或做了普通联网搜索不算使用该功能。不切换用户
指定的模型。功能不可用则报告，不静默以 API 调用替代订阅网页版。

研究只使用读取能力；等完整报告和来源出现后，回到普通规划回合，请 ChatGPT
把报告转成可执行 PLAN。保留报告链接/出处、假设、未解决问题，原目标不变。
先核验来源再将事实写入项目文档；结构检查通过不代表引用真实支持结论。

等待优先完成独立工作；需要观察网页时用低成本 DOM/AX 状态、逐步退避至约
60 秒，不截图短轮询、不用一条五分钟阻塞调用。没有状态变化不写重复 checkpoint。
需要跨 turn 自动续接时，按用户已有 loop 授权用当前可用的 heartbeat 工具，保存
原任务、网页地址、待收 requestId、下一步和静默规则；无端点则报告不支持。
heartbeat 只负责重新进入检查流程，不能宣称它已唤醒网页。不要创建重复监控。

## 安装更新与断开

修改这个 Skill 时先备份本机安装副本。源码在独立工作树验证并 build，安装时
只替换该 Skill，展开 `__C2C_CHECKOUT__` 为实际源码绝对路径。不要自动更新
服务启动路径、重启生产 connector、覆盖别人 dirty tree 或清理历史数据。
未 build 时用现有 package manager 和 lockfile，避免依赖全局 corepack 必然存在。

现有安装升级前读取 `__C2C_CHECKOUT__/docs/safe-skill-update.md`。测试中的源码
不能直接 build 到已安装 Skill 指向的 dist；用候选输出目录。先做新旧行为对比，
将验收过的版本放到独立 release 目录，再用 `scripts/update-skill.mjs` 默认 dry-run
核对，最后 `--apply` 原子替换 Skill；回滚必须匹配本次安装内容，不能覆盖别人
后续修改。首次安装脚本遇到已有安装会停止，不能用它做原地升级。

用户要求断开时执行 `c2c unpair -w <ws>`，按需移除该 workspace 的连接器；不
影响其他 workspace。最终报告本地验证、真实网页往返和后台唤醒各自的证据状态。
