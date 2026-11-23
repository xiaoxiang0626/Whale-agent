# 接入模型 API

当前支持非流式 OpenAI Chat Completions 文本与函数调用。你可以配置自己的服务地址、模型名和 API Key；默认仍使用无网络调用的 `mock`。接口已经通过本地模拟 HTTP 服务、命令行子进程和 DeepSeek 工具循环验证；其他服务需按实际配置验证。

## 本地配置

编辑本地 `.env`，按自己的服务填写下列字段。`.env.example` 也提供了注释模板；已有配置文件无需覆盖。

```dotenv
CODING_AGENT_PROVIDER=openai-compatible
CODING_AGENT_BASE_URL=https://your-api.example/v1
CODING_AGENT_MODEL=你的模型名
CODING_AGENT_API_KEY=在本地填写自己的密钥
CODING_AGENT_TIMEOUT_MS=30000
CODING_AGENT_MAX_RESPONSE_BYTES=1048576
```

上面的域名和密钥均为占位值，需要替换后才能连接实际服务。命令行读取本地文件：

```sh
my-coding-agent --env .env "请回复一句测试文字"
```

持续对话使用 `my-coding-agent --env .env --interactive`。每轮会发送当前成功问答历史，因此模型能够引用前文；上下文和取消规则见[交互会话](interactive.md)。

也可以通过 `--provider`、`--model` 和 `--base-url` 覆盖对应配置。密钥只从环境读取。配置优先级、取值范围和错误码见[开发与配置](development.md#配置)。

## 协议

适配器每次向基础地址下的 `chat/completions` 发送 POST 请求，携带 `Authorization: Bearer …`，JSON 正文包含 `model`、`messages` 和 `stream: false`，启用工具时还包含 `tools`。例如基础地址 `/v1` 或 `/v1/` 都会请求 `/v1/chat/completions`。协议参见 [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。

适配器读取第一个 choice，`stop` 要求有效的完整助手文本，`tool_calls` 要求 1–8 个有效函数调用。参数 JSON 由工具执行前校验，失败作为工具结果回传。调用 ID 连接助手调用与 `role: tool` 的结果；循环规则见[只读 Agent](agent-tools.md)。当前不支持流式、图像、Responses API、自定义认证头或带查询参数的基础地址。

DeepSeek 默认思考模式下，工具请求需要回传此前助手消息的 `reasoning_content`。适配器保留并转换该字段，终端只显示最终回答和工具摘要。相关规则见 [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。不自动加入仅某一厂商支持的请求开关。

## 失败处理

超时覆盖连接、响应头与正文读取。正文超过配置的字节上限时停止读取。用户取消会传递给 HTTP 请求，CLI 返回退出码 130；其他失败返回退出码 1。

认证失败、限流、服务端错误、网络故障及无效响应分别给出固定诊断。服务端错误正文和底层异常不会直接显示，避免回显请求与凭据。请求不自动重试，也不跟随重定向。

## 费用与订阅

ChatGPT Plus 与 OpenAI API 使用独立计费系统，Plus 订阅不等同于普通模型 API 额度；参见[官方计费说明](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform)。使用 ChatGPT 账号登录 Codex 属于订阅支持的另一种接入方式，不能用本适配器的 API Key 配置替代；参见 [Codex 认证](https://learn.chatgpt.com/docs/auth?surface=cli)。

## 验证范围

测试覆盖配置校验、请求路径和认证头、非流式消息转换、固定错误诊断、无效响应、响应大小限制，以及真实本地 HTTP 传输。命令行子进程通过本地服务完成文本调用；超时测试让服务保留未完成的正文，取消测试在服务收到请求后发出取消信号。

默认自动化测试不消耗用户模型额度。`pnpm test:agent:live` 显式使用本地配置，验证临时文件的真实工具调用，并测量有无工具定义的首条请求 prompt token；会发起真实请求。检查不保存密钥或推理正文。其他真实服务的协议、认证、模型可用性和返回内容，需要配置后单独验证。
