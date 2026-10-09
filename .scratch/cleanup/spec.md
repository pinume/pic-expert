# 审计简化

Status: complete

## 范围与方案

1. 删除结果记录中的重复图片路径转换。下载记录和运行日志继续保存路径。
2. 删除没有运行时读取方的 visitedBefore 断点字段及专属测试。
3. 内容脚本和接口适配复用 core.cleanText。
4. 删除未使用的 action.onClicked 测试桩。

karpathy-guidelines：只执行已授权的四项简化。成功标准是运行代码不再引用已删除接口，四列 CSV 和下载恢复仍使用原有记录。

engineering-suite-ponytail:ponytail 实施前审查：复用已有文本处理函数，不新增依赖或迁移逻辑。旧任务数据保留，不重写数据库。

## 检查

- 关联调用和差异人工审查完成，已修改路径相关断言，使其检查下载记录。
- npm run check、修改过的测试文件语法检查及 git diff --check 通过。运行代码无已删除字段或接口引用。代码和相关测试净减少 19 行。
- engineering-suite-ponytail:ponytail-review：无剩余复杂度发现。
- 用户此前要求停止测试。本轮不运行自动化测试或真实 Chrome 下载验证。
- 之前 116 项通过属于简化前版本，不作为本轮通过结果。
