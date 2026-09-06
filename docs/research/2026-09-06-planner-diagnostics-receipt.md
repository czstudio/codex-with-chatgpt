# 网页回复恢复诊断优化

2026-09-06，从已安装发布 40c20ad1a707 继续。仅修改回复检查器、CLI 与相关操作说明，
不新增状态机、浏览器传输、执行工具或 API planner。

## 具体问题与行为

之前所有失败均输出 PLANNER_REPLY_REJECTED + inspect-local-request-and-reply。
上一轮真实网页的格式修正暴露出该提示缺乏恢复方向：本地 request 错误、错轮回复、
重复绑定和仍有未完成工作的 DONE，需要不同处理，不能都重发网页请求。

现在保留 error 字段与 exit 2，添加固定枚举 reason 和 next。明确区分本地输入、
格式、schema、绑定、阶段和内容完整性。提示不执行、不自动重发，也不授予权限；
采用 proposal-only 标记。拒绝输出不包含解析器原文、正文、用户字段名或文件路径。
成功响应保持上一版内容，不改变通过条件。重复 JSON 键仍拒绝，并保留与一般格式
错误不同的诊断；内部错误字符串增加后缀，调用者应按 CLI 固定 reason 判断恢复。

文件读取检查同一个已打开的普通文件，最多读取 65537 字节用于 64 KiB 限额检测，
然后关闭 fd；避免先 stat 路径再无界 readFile 的窗口。非普通文件与超限输入拒绝，
不截断后解析。macOS 实测 FIFO 无 writer 时可立即拒绝；未执行 Windows 运行验证。

## 验证与比较

- Typecheck 和候选编译通过。
- 新增 15 项诊断/读取边界测试；完整 22 files / 199 tests PASS。
- 实际调用已安装旧 CLI 和候选编译 CLI，8 类失败的接受/拒绝均不变；旧版没有
  细分类诊断，候选 8/8 reason 与预期一致，私有内容哨兵没有出现在输出中。
- 将上一轮实际网页提取的 6 条回复分别送入旧、新 CLI：原非法 JSON 仍拒绝，
  格式修正、两次 review、RESEARCH 和研究转 PLAN 仍通过；成功响应逐项一致。
- 原有历史实现比较仍是 9/9，零回归；保留此前 6 项修复。
- 原始比较产物：.tooling/diagnostic-comparison/report.json；完整 suite 日志：
  .tooling/diagnostic-suite.log；历史比较：.tooling/loop-comparison-TR43kg/report.json。

这里验证的是诊断准确性、兼容性与读取边界。没有测量用户任务成功率、模型延迟
或网页请求节省百分比，也没有重新启动已完成的网页任务。普通 Pro Chat 的 developer
MCP 限制和后台反向唤醒未验证状态仍见 planner-loop-live-receipt，不因本次测试关闭。
