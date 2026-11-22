# My Coding Agent

参考 DeepSeek Harness，逐个 PR 开发自己的编码 Agent，并用中文文档解释每一步。

当前可以运行 CLI、解析配置，通过可替换的模型适配接口完成一次离线演示。模拟响应会标明「未调用模型 API」。真实 API、读取代码、修改文件和执行命令属于[后续 PR](docs/roadmap.md)。

## 启动

需要 Node.js 24.12 或更高版本、pnpm 11.28.5。

```sh
pnpm install --frozen-lockfile
pnpm dev "解释这个项目"
```

预期输出：

```text
[模拟响应，未调用模型 API]
已收到任务：解释这个项目
当前仅演示调用流程，尚不能读取或修改代码。
```

```sh
pnpm dev --help
pnpm check
pnpm start "解释这个项目"
```

`pnpm check` 依次完成类型检查、测试和构建；`pnpm start` 使用已经构建的 `dist/cli.js`。

## 技术文档

- [架构与 Harness 对照](docs/architecture.md)：各模块的职责和调用过程。
- [开发与配置](docs/development.md)：运行命令、错误处理和适配器扩展方式。
- [逐个 PR 的开发路线](docs/roadmap.md)：各阶段的交付与验收条件。
- [第一份 PR 的说明](docs/prs/001-provider-foundation.md)：本次范围、验证证据和阅读顺序。

## 自己的 API

目前只启用 `mock`。确认你的 API 协议后，在 `src/providers/` 增加适配器，任务逻辑继续依赖 `ModelProvider`。接入所需的信息包括 API 协议、Base URL、模型名，以及一份脱敏的请求和响应示例。

API Key 后续从本地环境变量读取，不写入代码、文档或 Git。未知 provider 会报错，避免把未接通的 API 当作成功演示。

项目目前仅在本地开发，未发布 npm 包。
