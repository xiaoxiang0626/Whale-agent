# 命令行入口

## 解决的问题

用户可以把本地项目注册为 `my-coding-agent` 命令，在终端中直接提交任务。将任务作为参数提供时，一次运行处理一个任务；持续输入见[交互会话](../interactive.md)。

## 使用

在项目根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm build
npm link
my-coding-agent --help
my-coding-agent "解释这个项目"
```

注册后可从其他目录执行命令。`--help` 显示帮助；空白任务、无效参数和未支持的适配器仍以非零状态结束。配置和错误码见[开发文档](../development.md)。

## 设计

`package.json` 的 `bin` 指向构建产物 `dist/cli.js`，入口通过 Node.js shebang 启动。命令行解析和终端输出仍由同一份源码负责，源码开发命令与安装后的命令使用相同的任务逻辑。

本地链接只注册命令，不向 npm 发布。打包文件限定为构建产物、包元数据和 README。

## 阅读顺序

1. [安装与使用](../development.md#安装命令行入口)。
2. [命令声明](../../package.json)中的 `bin` 和 `files`。
3. [命令行入口](../../src/cli.ts)中的帮助和无参数行为。
4. [命令行测试](../../tests/cli.test.ts)中的输出和退出码。

## 验证

Windows、Node.js 24.15.0、pnpm 11.28.5：`pnpm check` 的 9 项测试、类型检查和构建通过；已执行 `npm link`，验证全局命令的帮助与模拟任务输出，并运行构建后的 `pnpm start`。`npm pack --dry-run --json --ignore-scripts` 的文件清单不包含 `.env`、开发依赖或测试源码。

本页介绍命令行交付方式。模型配置见[模型 API](../model-api.md)，连续输入见[交互会话](../interactive.md)，后续能力见[开发路线](../roadmap.md)。
