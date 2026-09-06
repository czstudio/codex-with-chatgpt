# C2C loop 可靠性对比与更新演练

本地日期 2026-09-05；验证时间 2026-09-06 06:19 UTC。
状态：候选实现与本地发布演练通过；真实网页验收等待登录；尚未激活候选版本。

工作树：`/Users/cz/code/code/codex/codex-with-chatgpt-planner-loop`
分支：`codex/c2c-planner-loop-20260905`；本轮从 `88ff25b` 继续。

## 新旧行为比较

运行 `node_modules/.bin/tsx scripts/compare-loop-behavior.ts`，载入仓库历史版本的
实际代码，对相同输入运行。表中的“原版”指 7f190d0，“上一版”指 88ff25b。

| 固定场景 | 比较版本的行为 | 候选行为 |
| --- | --- | --- |
| 有未解决项却 DONE | 原版误通过 | 拒绝完成 |
| 执行前先写 DONE | 原版误通过 | 拒绝完成 |
| 新轮次已失败，却引用旧轮次 DONE | 原版误通过 | 拒绝完成 |
| 恢复记录仅改变 JSON 字段顺序 | 上一版误判冲突 | 幂等接受，不重复记录 |
| 完整 CRLF fenced 回答 | 上一版误拒绝 | 接受，不需要修正回合 |
| 同条回答有矛盾的重复 requestId | 上一版取最后一个值 | 拒绝含糊回答 |
| 正常完成、缺少测试证据、标准完整回答 | 原版或上一版已正确 | 保持正确 |

9 个选定场景中修复 6 个已知错误，3 个原有正确行为保留；候选 9/9 符合预期，
所选场景回归数 0。这是针对已知缺陷的回归比较，不能换算为实际用户成功率，
也不证明网页模型的方案质量、速度、Deep Research 效果或后台唤醒能力。

此外：过大审计文件在读取正文之前拒绝，避免恢复过程中无界读取；重复 JSON
键检查也覆盖转义字段名和嵌套来源对象，不把字符串内容误识别为字段。

## 测试与真实部署副本

- Typecheck、候选 dist build、源码 Skill 验证、脚本语法、diff check：PASS。
- 完整发布副本测试：21 files / 184 tests PASS。
- 更新器最新独立测试：7/7 PASS。
- 编译 CLI：正常 JSON exit 0；完整 CRLF exit 0；重复 requestId exit 2。
- 比较原始产物：`.tooling/loop-comparison-Lb9eDv/report.json`。
- 发布副本：`.tooling/release-rehearsal-1cz485ok`，含独立复制的依赖；依赖符号链接
  指向副本之外的数量为 0。日志 `.tooling/packaged-release-validation-final.log`。
- 之前占用 62141 的现有 node PID 67525 保持运行。6 项 bridge 测试通过临时
  监听端口运行真实 HTTP 请求；测试同时断言生产 listener 请求固定 62141，
  生产端口限制、身份检查、一次 nonce 和已有授权范围没有放宽。

发布副本的第一次完整测试抓到本次打包漏带 extension 静态文件。补齐后重新完整
测试通过，并为更新器增加发布文件完整性检查。不能用只测源码代替测实际发布副本。

## 更新与回滚演练

新脚本 `scripts/update-skill.mjs` 默认 dry-run，仅在 --apply 时原子替换指定
Skill。已在独立临时 Skill 上执行真实 CLI：dry-run 无修改、切换内容逐字一致、
回滚内容逐字恢复。对真实安装仅执行 dry-run，没有 --apply。

覆盖：备份权限 0600、激活前 rename 失败保留原版、安装或回滚遇并发改动拒绝
覆盖、相同内容无写入、更新锁冲突、符号链接拒绝、缺文件发布包拒绝。首次安装
脚本发现已有安装/checkout 时，在拉代码或安装依赖前停止，避免原地更新活跃代码。
PowerShell 入口有同类防护，本机未执行 Windows 运行时验证。

本轮候选 build 只写 `.tooling/candidate-dist`；已安装 Skill 与原 dist 保持上一版
行为。已安装 Skill 指向可变工作树仍是旧安装留下的风险；下一次实际切换必须
指向独立 release 目录。升级方法见 `docs/safe-skill-update.md`。
没有重启服务、修改 connector、更新全局配置、接触会话数据库或安装浏览器扩展；
没有 push、merge 或生产部署。

## 网页验收阻塞与续接

内置浏览器本轮已恢复可交互，ChatGPT 显示登录弹窗；截至最后一次读取仍未登录。
已保留该标签并请求用户登录。没有用普通联网检索冒充 Deep Research。

登录后复用该页面，在无私有数据的示例项目跑真实两轮 PLAN→本地执行/测试→网页
提出修正→本地执行/测试→网页 DONE，核对停止与发送不明不重发。所需网页验收
未完成之前，候选保持待激活，不自动替换当前安装。已有比较与本地测试无需重做。
