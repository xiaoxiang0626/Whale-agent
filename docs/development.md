# 开发与配置

本项目使用 TypeScript 和 Node.js 内置测试工具；终端界面使用 Ink、React、wrap-ansi 和 string-width。源码保持 `.ts`，通过 `React.createElement` 组合组件，无需 JSX 转换。Node.js 直接运行源码时不会检查类型，因此提交前需要执行类型检查。参见 [Node.js TypeScript 文档](https://nodejs.org/api/typescript.html)和 [TypeScript 导入扩展名配置](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html)。

## 常用命令

在项目根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm dev --help
pnpm dev "解释这个项目"
pnpm dev --provider mock --model mock-v1 "检查调用流程"
pnpm check
pnpm test:tui:pty
pnpm start "解释这个项目"
```

`pnpm dev` 运行 `src/cli.ts`。`pnpm check` 顺序执行类型检查、测试和构建。`pnpm test:tui:pty` 验证最新构建的终端界面，必须先构建；默认使用离线模拟。`pnpm start` 运行构建结果，首次运行前需要构建。

## 安装命令行入口

在项目根目录构建并注册命令：

```sh
pnpm build
npm link
my-coding-agent --help
my-coding-agent "解释这个项目"
```

`package.json` 的 `bin` 将 `my-coding-agent` 指向 `dist/cli.js`，构建后的入口保留 Node.js shebang。`npm link` 在本机注册该命令，不发布到 npm；参见 [npm link 文档](https://docs.npmjs.com/cli/v11/commands/npm-link/)。注册后可以从其他目录调用，默认将启动目录作为可读取工作区；可通过 `--workspace` 更改目录，或使用 `--no-tools` 关闭工具。

终端中不提供任务参数会进入全屏交互界面，也可通过 `--interactive` 或 `-i` 显式进入。加 `--plain` 使用逐行会话；非终端交互自动使用逐行模式。通过参数提供任务时仍是单次调用。非终端输入且没有参数时显示帮助；带配置选项的非交互调用需要提供任务。连续输入、命令与取消行为见[交互会话](interactive.md)。

修改源码后运行 `pnpm build`，本地链接的命令会使用最新构建。若终端提示找不到命令，请检查 npm 的全局命令目录是否位于 `PATH`；在 Windows 上可运行 `npm config get prefix` 查询该目录。

打包文件通过 `files` 限定为 `dist/` 和第三方素材许可说明，此外 npm 会包含包元数据和 README。`npm pack --dry-run --json --ignore-scripts` 可查看文件清单，当前清单不包含 `.env`、开发依赖、测试源码或 `.local-assets/` 本地归档。

## 配置

优先级：CLI 参数高于已有环境变量，已有环境变量高于显式环境文件，最后使用适配器默认值。显式空值会报错。

| CLI 参数 | 环境变量 | 默认值 | 当前含义 |
| --- | --- | --- | --- |
| `--provider` | `CODING_AGENT_PROVIDER` | `mock` | `mock` 或 `openai-compatible` |
| `--model` | `CODING_AGENT_MODEL` | 模拟模式为 `mock-v1` | 真实接口须显式提供模型名 |
| `--base-url` | `CODING_AGENT_BASE_URL` | 无 | 真实接口基础地址，保留其路径 |
| 无 | `CODING_AGENT_API_KEY` | 无 | 真实接口的 Bearer 密钥，只从本地环境读取 |
| 无 | `CODING_AGENT_TIMEOUT_MS` | `30000` | 真实请求超时，单位毫秒 |
| 无 | `CODING_AGENT_MAX_RESPONSE_BYTES` | `1048576` | 真实接口响应正文的字节上限 |
| `--workspace` | `CODING_AGENT_WORKSPACE` | 当前目录 | 只读工具可访问的目录 |
| `--max-steps` | `CODING_AGENT_MAX_STEPS` | `12` | 每轮 1–100 次模型请求上限 |
| `--read-only` | 无 | 交互默认可提案 | 交互也仅提供只读工具 |
| `--no-tools` | 无 | 单次只读、交互可提案 | 关闭模型工具，仅进行文本对话 |

超时和响应字节上限均须为 1 至 2147483647 的整数。基础地址只接受 HTTP 或 HTTPS，不能携带凭据、查询参数或片段。

命令不自动加载 `.env`。使用示例文件验证离线配置：

```sh
my-coding-agent --env .env.example "检查环境文件"
```

自己的配置文件通过 `--env .env` 指定，也可继续使用 Node.js 自带的 `node --env-file=.env src/cli.ts "任务"`。`.env` 被 Git 忽略；已有本地配置文件无需覆盖。真实服务的配置示例、协议与限制见[模型 API](model-api.md)。

## 错误与取消

| 情况 | 结果 |
| --- | --- |
| 使用 `--help`，或非终端环境中无参数启动 | 显示帮助，退出码 0 |
| 显式空白任务，或带配置选项但未提供任务 | `EMPTY_PROMPT`，退出码 1 |
| 参数未知或缺少参数值 | `INVALID_ARGUMENTS`，退出码 1 |
| provider 未支持或模型名为空 | `INVALID_CONFIG`，退出码 1 |
| 单次任务期间收到 Ctrl+C | 传递取消信号，退出码 130 |
| 交互请求期间收到 Ctrl+C | 取消本轮，保留原上下文并继续等待输入 |
| 交互空闲时收到 Ctrl+C 或使用 `/exit` | 退出会话，退出码 0 |
| 未分类异常 | CLI 展示通用失败提示，退出码 1 |
| 认证失败或限流 | `AUTHENTICATION_FAILED` 或 `RATE_LIMITED`，退出码 1 |
| 服务端错误或网络失败 | `API_ERROR` 或 `NETWORK_ERROR`，退出码 1 |
| 模型 API 超时 | `REQUEST_TIMEOUT`，退出码 1 |
| 无效、不完整或过大的响应 | `INVALID_RESPONSE`，退出码 1 |
| 模型请求或工具调用超过循环上限 | `AGENT_LIMIT`，本轮不提交历史 |
| 未提供工具时模型请求工具 | `TOOL_UNAVAILABLE` |

CLI 不打印任意异常的完整内容。模拟调用立即完成；HTTP 适配器的超时和取消通过本地服务验证，不依赖外部网络。

## 接入真实 API 时修改哪里

新增协议时在 `src/providers/` 实现 `ModelProvider`，由它把 `ModelRequest` 转成服务商请求，并验证外部响应后返回 `ModelResponse`。同时扩展配置解析和适配器工厂。`runTask()` 继续接收同一接口。

接入前先确定协议、认证方式、Base URL 和模型名。接入 PR 需要测试请求转换、响应解析、超时、取消和服务端错误；日志不得包含 API Key。现有 OpenAI 兼容实现可作为参考，当前没有自动重试。

## 验证范围

测试覆盖适配器调用、配置、HTTP 失败、工具协议、循环、目录与文件限制，以及会话上下文、清空、并发拒绝、取消、输入结束和 CLI 子进程。TUI 测试另外验证工具摘要、中文与 emoji 编辑、缩放、历史翻页、取消和卸载。默认自动化测试仅访问本地模拟 HTTP 服务，不需要 API Key，也不修改测试进程的全局环境变量。

真实伪终端检查使用开发依赖 `node-pty`、`@xterm/headless` 与其 Unicode 11 插件，直接启动 Node，不依赖 PowerShell 或其他 shell。仓库使用 node-pty 自带预编译模块，`pnpm-workspace.yaml` 显式禁止它的安装脚本；不支持的系统或架构会报错，需先解决安装问题。该检查验证构建产物、备用屏幕恢复和 130×34、80×24、40×12 缩放，不计入单元测试用例数。

只有显式运行 `pnpm test:tui:pty --live` 才加载本地 `.env` 并发起一次真实文本请求，会消耗接口额度。验证结果只输出成功状态，不保存真实屏幕内容或密钥。`--capture` 仅在离线模式将模拟屏幕单元格写入 `.git/tui-captures.json`，供生成预览使用。

`pnpm test:editing:live` 使用真实模型读取临时文件、提出修改，显式确认后检查实际写入；不修改真实项目文件。

`pnpm test:agent:live` 为独立的真实工具检查：读取临时夹具，验证工具结果回传，并比较有无工具定义的首条消息 prompt token。它显式使用本地 `.env`，不读取真实项目代码，只输出计数和通过状态。

构建使用独立的 `tsconfig.build.json`，只输出 `src/`，并将相对导入的 `.ts` 扩展名改为 `.js`。`tests/` 与 `scripts/` 参与类型检查，不进入 `dist/`。

## 提交与合入

每个需求使用中文分支和 PR。提交前自审最终差异，检查需求行为、错误处理、测试和文档是否一致，并执行 `pnpm check`、构建后的命令行验证和差异格式检查。PR 说明记录实际执行的验证与已知限制。

相关检查通过后，可自行合入 `主分支`。如果远端提交变化，需重新确认待合并提交与验证记录一致；存在失败检查或未解决冲突时先修复。合入后同步本地主分支，再开始下一个需求。

开发中发现的问题、根因、解决方案与已验证的指标变化统一记录到[开发日志](development-log.md)。记录实际执行的命令和结果，区分功能变化、测试数量与性能测量，不用单次测试耗时推断性能提升。
