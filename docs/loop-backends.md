# 可选 MCP 后端与 loop 恢复

2026-09-09 核验官方仓库。此文是使用映射，不是新插件已安装或实际联调通过的声明。

## 来源与适用范围

- [Agent Helm Extensions](https://github.com/BeforeWave/agent-helm-extensions/tree/b825a1d6ffba933a1acba3b4de75a69c4ca1081f)：README 描述浏览器对话、本地 work/worktree、Agent session 和工作历史的关联。
  [后台实现](https://github.com/BeforeWave/agent-helm-extensions/blob/b825a1d6ffba933a1acba3b4de75a69c4ca1081f/chrome-extension/src/adapters/chrome/installBackgroundHandlers.ts)中通知点击打开侧栏，alarm 刷新连接图标；这些操作本身不能证明 ChatGPT 自动发送下一轮。
- [DevSpace 工作流](https://github.com/Waishnav/devspace/blob/67d4c8f8fce08c171eea6f820a0ee090ae81c1d0/docs/chatgpt-coding-workflow.md)：open_workspace 返回 workspaceId，后续复用；worktree 模式每次打开都会创建新工作树。长命令可返回 session ID，后续用 write_stdin；show_changes 可提供 reviewRef。
- [DevSpace 安全模型](https://github.com/Waishnav/devspace/blob/67d4c8f8fce08c171eea6f820a0ee090ae81c1d0/docs/security.md)：文件工具路径限制不等于 shell 隔离，shell 按本地用户权限运行；worktree 是工作流隔离。故不可将其直接当作我们现有只读 C2C 的等权限替换。

这里的 DevSpace 指 Waishnav/devspace。未运行第三方安装脚本、建立隧道或修改 OAuth。

## 实际使用映射

| 需求 | 当前 C2C 主持循环 | 用户明确选用其他后端时 |
| --- | --- | --- |
| 恢复原项目 | session URL + workspace_info + 原 owner | Helm 恢复原 work/session；DevSpace 复用返回的 workspaceId，不重复以 worktree 模式调用 open_workspace |
| 长测试 | 原本地 exec session + write_stdin/wait | 仅调用该后端实际提供的会话续接工具，不跨后端使用句柄 |
| 汇总审查 | 一轮 diff + tests + execution_summary | 如工具提供 reviewRef，复用它恢复对应差异；不把 review UI 当作审查通过 |
| 数据权限 | 网页只读、本地执行 | 先核对具体项目根目录、实际工具与权限；读写后端不是自动升级项 |
| 完成判定 | 同任务同轮真实结果 + 网页复审 + 本地验收 | 通知和 work 状态仅作定位，仍需上述证据 |

连接器只指向主树时，不得声称它审查了另一个隔离树。使用后端已支持且已授权的
版本化只读入口；没有该入口就保留源码审查缺口，不自动扩大文件根目录或复制私有源码。

## 对旧 Skill 的情景核对

这是人工指令走查，不是模型 A/B 或端到端插件测试。

| 场景 | 旧版 f5b3992 的缺口 | 本次明确的动作 |
| --- | --- | --- |
| 测试超过命令 yield 时间 | 要求核对原进程，但未规定返回句柄怎么保存 | 原 handle + cwd 入既有 checkpoint，续读原进程 |
| 每改一文件就发 review | 未明确集中审查时点 | 一轮结束汇总一次 |
| HEAD 没变但 dirty 内容又变 | 仅要求核对版本，未突出这个陷阱 | 新内容需重新审查 |
| diff 输出截断 | 没有定向补读规则 | 标出缺失文件并按需补读 |
| 后端通知显示完成 | 有一般性完成约束，缺少插件映射 | 通知只定位任务，核验执行终态与 review |
| DevSpace 重复打开 worktree | 未覆盖这个后端 | 复用 workspaceId，避免生成新树 |

这些改进降低重复执行和错误审查的操作歧义；不能据此声称任务成功率或性能提升。

本次完整回归 22 files / 199 tests 通过；历史代码行为对比 9/9、零回归。
后者复核既有修复，不是本次文案产生的新增性能收益。此前真实网页往返回执保留，
本次未重跑网页或第三方插件端到端测试；仅更新本机 Skill 与参考说明。
