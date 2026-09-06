# 谨慎更新 C2C Skill

范围仅是本机 Skill 和其引用的 C2C 发布目录；不包含运行中的 extension bridge、
工作区 connector、全局配置、Codex 会话数据库或第三方浏览器扩展。这些组件需要
分别验收，不能因为 Skill 测试通过就一起重启替换。

## 验证后切换

1. 在隔离工作树修改。已安装 Skill 若指向该工作树，候选编译使用
   `tsc -p tsconfig.json --outDir .tooling/candidate-dist`，不要覆盖运行中的 dist。
2. 运行必要测试、完整 suite 和 `tsx scripts/compare-loop-behavior.ts`。此对比
   使用原实现 `7f190d0` 与上一版 `88ff25b` 的实际代码，对相同固定输入比较；
   它是已知缺陷回归测试，不是网页模型质量/速度/总体成功率的统计实验。
3. 对本次用户要求的自动网页循环，必须保留真实两轮网页往返证据。未登录、能力
   不可用或测试缺失时，候选版本保持待验收，不能宣称全量部署就绪。
4. 将验收后的提交导出到新的、带版本名的本地 release 目录，在其中按 lockfile
   准备依赖和构建。不要覆盖旧 release；不要使依赖链接指回会继续修改的开发目录。
   发布目录中必须包含 `skill/SKILL.md`、引用文档、`bin/c2c.js`、dist 和依赖。
5. 对该 release 先 dry-run。下面路径是模板，需要换成真实路径：

```sh
node scripts/update-skill.mjs --release /absolute/release --skill /absolute/skills/codex-with-chatgpt/SKILL.md --backups /absolute/restricted-backups
```

脚本核验 Skill 名称、引用文档、CLI 是否具有 validate-reply 参数，然后输出
`dry-run`；不会替换现有内容。不要用 `install.sh` / `install.ps1` 原地升级。

6. 已授权且所需测试通过后，在同一命令末尾加 `--apply`。脚本锁定更新目标、
   备份旧版与即将安装的内容、同步临时文件，再原子 rename。锁冲突不抢锁，
   前后检测到现有文件变化则拒绝覆盖。输出 backup 路径留作恢复依据。
7. 检查安装文件与展开路径后的 release Skill 一致，运行 CLI smoke，并在下一次
   实际任务确认加载了对应版本。旧 release 留在原处供在途任务和回滚使用。

## 回滚

```sh
node scripts/update-skill.mjs --restore /absolute/restricted-backups/update-ID --skill /absolute/skills/codex-with-chatgpt/SKILL.md --backups /absolute/restricted-backups
```

默认仍是 dry-run；核对后加 `--apply`。目标内容必须仍等于当时安装的版本，
否则报 INSTALLED_SKILL_CHANGED，保留现状供人工/协调者核对，不强行覆盖。
回滚也产生新备份；不会修改旧 release、服务配置或用户会话。

本地更新锁只协调使用此脚本的更新者；普通编辑器若无视锁仍可能在最后一次检查
之后写入。更新时应停止对该 Skill 的其他写入者。进程被强制终止可能留下锁或
临时文件；先核对文件和更新进程，不自动清理或重试。原子替换不等于跨进程事务。

## 已覆盖的故障行为

测试用临时 Skill 验证：旧版备份、正常切换与回滚、rename 前失败保留旧版、
并发修改拒绝覆盖、同内容无写入、另一 updater 锁保留、符号链接目标拒绝。
macOS 首次安装入口在发现已有安装时，在调用 Git/包管理器之前返回；Windows
入口有对应保护，本机未运行 PowerShell，不能标记 Windows 部署验证通过。
