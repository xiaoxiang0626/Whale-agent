# My Coding Agent

参考 DeepSeek Harness，逐个 PR 开发自己的命令行编码 Agent，并用中文文档解释每一步。

当前可以运行 CLI、解析配置，并选择离线模拟或自己的 OpenAI 兼容文本 API。默认模拟响应会标明「未调用模型 API」。读取代码、修改文件和执行命令属于[后续需求](docs/roadmap.md)。

## 启动

需要 Node.js 24.12 或更高版本、pnpm 11.28.5。

```sh
pnpm install --frozen-lockfile
pnpm build
npm link
my-coding-agent --help
my-coding-agent "解释这个项目"
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

`npm link` 将本地项目注册为 `my-coding-agent` 命令，之后可以在其他目录运行。直接输入 `my-coding-agent` 会显示帮助。当前每次调用处理一个任务，开发时也可使用 `pnpm dev "你的任务"`。

`pnpm check` 依次完成类型检查、测试和构建；`pnpm start` 使用已经构建的 `dist/cli.js`。修改源码后需要重新构建，本地命令才会使用最新代码。命令安装说明见[开发文档](docs/development.md#安装命令行入口)。

## 技术文档

- [架构与 Harness 对照](docs/architecture.md)：各模块的职责和调用过程。
- [开发与配置](docs/development.md)：运行命令、错误处理和适配器扩展方式。
- [逐个 PR 的开发路线](docs/roadmap.md)：各阶段的交付与验收条件。
- [第一份 PR 的说明](docs/prs/001-provider-foundation.md)：本次范围、验证证据和阅读顺序。
- [命令行入口](docs/prs/002-cli-entry.md)：命令安装、帮助行为和交付范围。
- [接入模型 API](docs/model-api.md)：本地配置、请求协议、错误与验证范围。

## 自己的 API

使用 `openai-compatible` 可连接支持非流式 Chat Completions 的模型服务。按[接入指南](docs/model-api.md)在本地配置地址、模型名和密钥，再运行：

```sh
my-coding-agent --env .env "你的任务"
```

API Key 从本地环境读取，不写入代码、文档或 Git。接口已通过本地模拟 HTTP 服务验证，用户实际服务尚未验证。ChatGPT Plus 与普通 API 独立计费，详见[接入指南](docs/model-api.md#费用与订阅)。

项目通过本地链接安装命令，未发布 npm 包。
