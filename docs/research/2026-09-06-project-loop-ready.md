# 项目 loop 直接使用验收

2026-09-06，在原项目已保存的 Work 对话完成实际连接核验，无需重新配对。

## 直接使用

在本地 Codex 项目任务中说：

> 用 loop 优化当前项目：<具体目标>。测试通过后让网页版复审，直到验收。

主持任务恢复该工作区已有 conversation，自动处理请求、执行回执和后续 review。
新目标使用新 taskId；继续已有目标沿用原 owner。用户无需填写 JSON 或复制日志。
网页承担只读规划与审查，本地 owner 执行。桌面任务保持活跃；后台反向唤醒尚未验证。

## 本次实际证据

- 已保存对话标题 Workspace info request，URL 为
  https://chatgpt.com/c/6a940663-8a8c-83ea-a1cc-f443791df95a 。
- 页面显示 Work，Sources 包含原有 Codex with ChatGPT 项目连接器。
- requestId project_metadata_0：网页实际调用 workspace_info，展开工作记录可见
  Inspected workspace information；返回 workspaceId 454f5be9a3c4、项目
  idea2paper_product-dev-v4.0、分支 kimi/figure-studio-overhaul、HEAD 0739d735。
- 本地 git rev-parse --short=8 HEAD 返回同一 0739d735。
- 本地 c2c record 为新 taskId c2c_project_ready_20260906、iteration 0 写入回执，
  changed-files=0，tests 为 No project tests run; read-only connectivity check。
- requestId project_receipt_1 未包含回执标记值。网页实际调用 execution_summary，
  展开工作记录可见 Summarized code execution results；正确返回仅写入本地回执的
  PROJECT_LOOP_READY_0739D735 和原样 tests 字段，证明回传并非复述提示中的标记。

本次是实际项目的只读连接及回执往返验收，不是 Idea2Paper 功能修改或业务测试。
此前样例的 PLAN→执行→REVIEW→补测→DONE、Deep Research 和测试改进证据仍见
2026-09-06-planner-loop-live-receipt.md。本次确认原有 Work 通道可用；不意味着此前
普通 Pro Chat 的 developer MCP 限制消失。隔离工作树审查仍需核对连接器读取版本。

## 使用入口改动

Skill 增加一句话入口、优先恢复已绑定 Work 对话、不同目标 taskId 隔离、通过
execution_summary 核验回传，以及主树/隔离树版本匹配要求。没有新增状态机或服务。
完整回归为 22 files / 199 tests；工作树 diff 检查通过。更新仅作用本机 Skill，
独立版本目录及旧版备份保留，不修改 Idea2Paper 源码、不重启连接器、不远程部署。
