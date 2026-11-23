# 架构与 Harness 对照

本文解释当前实现。计划中的功能与验收条件见[开发路线](roadmap.md)。

## 一次任务怎样运行

1. `my-coding-agent` 启动构建后的 `dist/cli.js`，对应源码为 `src/cli.ts`；入口解析参数，真实终端无任务时进入交互，非终端无参数时显示帮助。
2. 显式传入 `--env` 时加载环境文件，`resolveConfig()` 合并 CLI 参数、环境变量和默认值，拒绝无效配置。
3. 单次任务通过 `runTask()` 创建一个会话；交互模式复用同一个 `Conversation`。输入和输出都是终端时延迟加载 TUI，`--plain` 或非终端交互使用 readline。
4. `runAgent()` 调用注入的 `ModelProvider.complete()`；模型请求工具时，串行执行已授权工具，将结果带入下一次请求。
5. 最终回答成功后，把本轮用户输入、工具调用、结果与助手回复一起加入历史，再输出文本；单次失败时设置非零退出码，交互失败时保留原上下文。

CLI 通过适配器工厂选择 `mock` 或 `openai-compatible`，单次默认创建当前工作区只读工具，交互默认增加待确认文件提案。模拟响应通常回显输入，显式“演示读取/列出”请求可执行本地工具；真实适配器按配置发送 Chat Completions 请求。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| [cli.ts](../src/cli.ts) | 参数、终端输出和退出状态；将 Ctrl+C 转换为取消信号 |
| [config.ts](../src/config.ts) | 一次性解析启动配置 |
| [task.ts](../src/task.ts) | 把用户任务转换为模型请求，调用注入的适配器 |
| [conversation.ts](../src/conversation.ts) | 管理成功问答历史、串行调用与清空 |
| [agent-loop.ts](../src/agent-loop.ts) | 模型与工具循环、次数限制和进度事件 |
| [agent-config.ts](../src/agent-config.ts) | 工作区与循环限制解析 |
| [tools/workspace.ts](../src/tools/workspace.ts) | 路径授权、忽略规则、有限文本读取 |
| [tools/editing.ts](../src/tools/editing.ts) | 提案、diff 与显式确认写入 |
| [display.ts](../src/display.ts) | 移除终端控制符，仅作用于显示 |
| [tools/read-only.ts](../src/tools/read-only.ts) | 工具定义、JSON 参数校验与预期失败结果 |
| [providers/wire.ts](../src/providers/wire.ts) | 消息字段转换、工具调用与推理字段校验 |
| [interactive.ts](../src/interactive.ts) | 逐行输入、会话命令、取消与终端清理 |
| [tui.ts](../src/tui.ts) | 全屏会话状态、命令、请求取消与卸载清理 |
| [tui-view.ts](../src/tui-view.ts) | 响应终端尺寸、消息折行与翻页、输入和侧栏布局 |
| [tui-input.ts](../src/tui-input.ts) | 按 Unicode 字素编辑输入、水平视口与真实光标位置 |
| [mascot.ts](../src/mascot.ts) | 按空间和颜色能力绘制 DeepSeek 蓝鲸字符图标 |
| [providers/types.ts](../src/providers/types.ts) | 定义协议无关的消息、请求、响应和适配器接口 |
| [providers/mock.ts](../src/providers/mock.ts) | 无网络、无凭据的演示适配器 |
| [providers/index.ts](../src/providers/index.ts) | 按已解析配置创建适配器 |
| [providers/openai-compatible.ts](../src/providers/openai-compatible.ts) | HTTP 协议转换、响应校验、超时和错误分类 |
| [errors.ts](../src/errors.ts) | 定义可以直接展示给用户的错误码与说明 |

`runTask()` 接收适配器实例，不读取环境变量，也不依赖 HTTP、厂商 SDK 或 API 地址。测试中可以注入不同实现而不修改任务逻辑。

HTTP 请求超时覆盖响应正文读取，响应字节上限限制内存使用。适配器不自动重试，也不跟随重定向；错误诊断不包含服务端错误正文。具体配置和协议见[模型 API](model-api.md)。

## 请求与响应

`ModelRequest` 包含 `model`、只读 `messages` 和可选工具定义。消息区分普通文本、助手工具调用和带调用 ID 的工具结果。`ModelResponse` 包含 `text`、可选 `toolCalls` 与 `reasoningContent`；推理字段仅按服务协议回传，不展示在 CLI。当前不提供流式输出。

适配器收到 `AbortSignal` 后负责终止自身进行中的工作。`runTask()` 在调用前和调用返回后都检查取消状态，因此取消后返回的结果不会被发布。适配器失败会向调用方传播，任务逻辑不把错误转换为成功响应。

交互模式将成功模型消息和用户确认操作结果随新输入发送。实际文件写入立即记录，后续模型失败不会丢弃操作结果，详情见[文件修改](editing.md)。同一会话拒绝并发发送或在请求期间清空；普通模型请求失败、取消和迟到结果不改变此前历史。消息仅在本次进程内使用，没有持久化会话或历史恢复。工作区限制与协议细节见[只读 Agent](agent-tools.md)。

TUI 的显示记录包含失败输入与提示，独立于 `Conversation` 的成功模型历史。折行和去除终端控制符只作用于显示，不改写发送给模型的消息。Ink 管理备用屏幕、原始输入模式和退出恢复；组件卸载时取消当前请求，迟到结果不更新显示。界面机制见[终端界面](tui.md)。

## 从 DeepSeek Harness 参考了什么

| Harness 的设计 | 本项目的落点 |
| --- | --- |
| 模型适配器隔离供应商协议 | `ModelProvider` 接口和 `providers/` 目录 |
| 执行逻辑依赖服务接口 | `runTask()` 接收适配器实例 |
| 启动时明确配置 | `resolveConfig()` 先解析，任务只接收具体参数 |
| 能力逐步组合 | 每个 PR 增加一种可验证的能力 |

Harness 的 Cordis 插件树、Agent 循环和事件持久化有各自的职责。本项目通过显式依赖注入组织模块，已经提供有界工具循环；会话保存将在对应 PR 中实现。

参考源码位于原工作区的 `docs/architecture.md`、`packages/llm/llm/` 和 `packages/core/agent-loop/`。公开入口为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。本项目尚未复制 Harness 的实现代码或引入其运行时依赖。
