# 开发约定

这是参考 DeepSeek Harness 思路、逐个 PR 实现的独立学习项目。当前能力见 [README](README.md)，后续范围见 [开发路线](docs/roadmap.md)。

- 每次只完成一个可审阅的 PR，同时更新中文技术文档。
- 模型协议转换属于 provider，任务逻辑依赖 `ModelProvider` 接口。
- 模拟响应必须明确标注；未接入的模型 API 不得宣称已验证。
- API Key 只从本地环境读取，不提交到 Git，不打印到日志。
- 不默认访问网络、修改用户文件或执行模型生成的命令；这些能力在各自 PR 中定义规则。
- 文档区分当前功能与开发计划；不要提前实现后续 PR 的功能。
- 提交前运行 `pnpm check` 和 `git diff --check`，构建后验证 `pnpm start`。
- 不自动合并 PR。每个 PR 提供改动说明、验证证据和阅读顺序。
