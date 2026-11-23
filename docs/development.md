# 开发与配置

本项目使用 TypeScript 和 Node.js 内置测试工具；生产运行时没有第三方依赖。Node.js 直接运行源码时不会检查类型，因此提交前需要执行类型检查。参见 [Node.js TypeScript 文档](https://nodejs.org/api/typescript.html)和 [TypeScript 导入扩展名配置](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html)。

## 常用命令

在项目根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm dev --help
pnpm dev "解释这个项目"
pnpm dev --provider mock --model mock-v1 "检查调用流程"
pnpm check
pnpm start "解释这个项目"
```

`pnpm dev` 运行 `src/cli.ts`。`pnpm check` 顺序执行类型检查、测试和构建。`pnpm start` 运行构建结果，首次运行前需要构建。

## 安装命令行入口

在项目根目录构建并注册命令：

```sh
pnpm build
npm link
my-coding-agent --help
my-coding-agent "解释这个项目"
```

`package.json` 的 `bin` 将 `my-coding-agent` 指向 `dist/cli.js`，构建后的入口保留 Node.js shebang。`npm link` 在本机注册该命令，不发布到 npm；参见 [npm link 文档](https://docs.npmjs.com/cli/v11/commands/npm-link/)。注册后可以从其他目录调用，执行位置由终端当前目录确定，当前版本不会读取该目录的代码。

直接运行 `my-coding-agent` 与使用 `--help` 均显示帮助并以退出码 0 结束。带配置选项时仍需提供任务。当前一次进程处理一个任务；交互式会话按后续需求增加。

修改源码后运行 `pnpm build`，本地链接的命令会使用最新构建。若终端提示找不到命令，请检查 npm 的全局命令目录是否位于 `PATH`；在 Windows 上可运行 `npm config get prefix` 查询该目录。

打包文件通过 `files` 限定为 `dist/`，此外 npm 会包含包元数据和 README。`npm pack --dry-run --json --ignore-scripts` 可查看文件清单，当前清单不包含 `.env`、开发依赖或测试源码。

## 配置

优先级：CLI 参数高于环境变量，环境变量高于默认值。显式空值会报错。

| CLI 参数 | 环境变量 | 默认值 | 当前含义 |
| --- | --- | --- | --- |
| `--provider` | `CODING_AGENT_PROVIDER` | `mock` | 仅支持离线模拟适配器 |
| `--model` | `CODING_AGENT_MODEL` | `mock-v1` | 传给适配器；模拟适配器不运行该模型 |

`pnpm dev` 不自动加载 `.env`。需要文件配置时，可在 PowerShell 中运行：

```powershell
Copy-Item .env.example .env
node --env-file=.env src/cli.ts "测试配置"
```

`.env` 被 Git 忽略。示例文件当前只包含模拟适配器配置；真实 API 的字段在适配器接入时定义。

## 错误与取消

| 情况 | 结果 |
| --- | --- |
| 无参数启动或使用 `--help` | 显示帮助，退出码 0 |
| 显式空白任务，或带配置选项但未提供任务 | `EMPTY_PROMPT`，退出码 1 |
| 参数未知或缺少参数值 | `INVALID_ARGUMENTS`，退出码 1 |
| provider 未支持或模型名为空 | `INVALID_CONFIG`，退出码 1 |
| 运行期间收到 Ctrl+C | 传递取消信号，退出码 130 |
| 未分类异常 | CLI 展示通用失败提示，退出码 1 |

CLI 不打印任意异常的完整内容。当前模拟调用立即完成，取消行为主要通过任务层的确定性测试验证。

## 接入真实 API 时修改哪里

在 `src/providers/` 新增 `ModelProvider` 实现，由它把 `ModelRequest` 转成服务商请求，并验证外部响应后返回 `ModelResponse`。同时扩展配置解析和 CLI 中的适配器选择。`runTask()` 继续接收同一接口。

接入前先确定协议、认证方式、Base URL 和模型名。接入 PR 需要测试请求转换、响应解析、超时、取消和服务端错误；日志不得包含 API Key。当前未实现自动重试。

## 验证范围

测试覆盖自定义适配器注入、消息传递、模拟标记、配置优先级、无效配置、任务取消、适配器异常，以及真实 CLI 子进程的帮助、输出和退出状态。测试不访问网络，不需要 API Key，也不修改测试进程的全局环境变量。

构建使用独立的 `tsconfig.build.json`，只输出 `src/`，并将相对导入的 `.ts` 扩展名改为 `.js`。`tests/` 参与类型检查，不进入 `dist/`。
