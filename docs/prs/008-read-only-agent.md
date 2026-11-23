# 只读工具与 Agent 循环

## 交付

模型可以通过 `list_files` 和 `read_file` 检查指定工作区，工具结果进入后续请求，模型根据结果继续或返回最终答案。CLI、逐行模式和全屏界面共用循环，终端显示工具摘要与当前步骤。

## 阅读顺序

1. [消息与工具类型](../../src/providers/types.ts)和[协议转换](../../src/providers/wire.ts)。
2. [模型与工具循环](../../src/agent-loop.ts)、[成功历史提交](../../src/conversation.ts)。
3. [工作区检查](../../src/tools/workspace.ts)和[工具定义](../../src/tools/read-only.ts)。
4. [启动配置](../../src/agent-config.ts)与[CLI](../../src/cli.ts)。
5. [循环测试](../../tests/agent-loop.test.ts)、[工作区测试](../../tests/read-only-tools.test.ts)、[真实服务检查](../../scripts/test-agent-live.ts)。

## 验证与范围

`pnpm check`、`pnpm test:tui:pty --capture`、构建后的离线读取与 `pnpm test:agent:live` 分别检查静态和行为、真实终端、打包代码路径以及真实模型工具调用。测量与问题记录见[开发日志](../development-log.md)。

默认提供只读工具，`--no-tools` 仅文本；当前不提供修改文件或执行命令。路径规则、分页、循环上限与上下文行为见[只读 Agent](../agent-tools.md)。
