#!/usr/bin/env node
/** 文本任务与交互会话 CLI；模型请求由会话和适配器处理。 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { AppError, formatError } from './errors.ts';
import { Conversation } from './conversation.ts';
import { runInteractive } from './interactive.ts';
import { resolveConfig } from './config.ts';
import { createProvider } from './providers/index.ts';
import { runTask } from './task.ts';
import { resolveAgentConfig } from './agent-config.ts';
import { createReadOnlyTools } from './tools/read-only.ts';
import { createCommandTools } from './tools/commands.ts';
import { displayText } from './display.ts';

const help = `my-coding-agent — 编码 Agent 学习项目

用法：my-coding-agent [选项] "你的任务"
交互：my-coding-agent --env .env

  --help, -h      显示帮助
  --provider      模型适配器（mock 或 openai-compatible）
  --model         模型名称
  --base-url      模型 API 的基础地址
  --env           显式加载本地环境文件
  --interactive, -i  显式进入交互会话，也可接受管道中的逐行输入
  --plain         使用逐行纯文本会话，不进入终端界面
  --workspace     可读取的工作区目录（默认当前目录）
  --max-steps     每轮模型请求上限（默认 12，最多 100）
  --no-tools      仅文本对话，不向模型提供文件工具
  --read-only     交互模式也只提供只读工具

示例：my-coding-agent "解释这个项目"
源码开发：pnpm dev "解释这个项目"
交互命令：/help、/clear、/exit、/apply 编号、/run 编号、/reject 编号

默认使用 mock 离线演示；openai-compatible 可连接自己的模型 API。
交互模式可预览文件修改和命令；/apply 编号 写入，/run 编号 执行。`;

function parseInput() {
  try {
    return parseArgs({
      options: {
        help: { type: 'boolean', short: 'h' },
        provider: { type: 'string' },
        model: { type: 'string' },
        'base-url': { type: 'string' },
        env: { type: 'string' },
        interactive: { type: 'boolean', short: 'i' },
        plain: { type: 'boolean' },
        workspace: { type: 'string' },
        'max-steps': { type: 'string' },
        'no-tools': { type: 'boolean' },
        'read-only': { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error
      && typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_')) {
      throw new AppError('INVALID_ARGUMENTS', '参数无效，请使用 --help 查看用法。');
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseInput();
  const interactive = values.interactive === true || (positionals.length === 0 && process.stdin.isTTY === true);
  if (values.help === true || (process.argv.length === 2 && !interactive)) {
    process.stdout.write(`${help}\n`);
    return;
  }
  if (values.interactive === true && positionals.length > 0) {
    throw new AppError('INVALID_ARGUMENTS', '交互模式请逐行输入任务，不要同时提供位置参数。');
  }
  if (values.env !== undefined) {
    try { process.loadEnvFile(values.env); } catch (error) {
      // 环境文件读取或解析失败时不回显文件内容。
      if (error instanceof Error) {
        throw new AppError('INVALID_CONFIG', '无法加载环境文件，请检查文件路径、格式和读取权限。');
      }
      throw error;
    }
  }
  const config = resolveConfig(process.env, {
    ...(values.provider === undefined ? {} : { provider: values.provider }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values['base-url'] === undefined ? {} : { baseUrl: values['base-url'] }),
  });
  const provider = createProvider(config);
  const agentConfig = resolveAgentConfig(process.env, {
    ...(values.workspace === undefined ? {} : { workspace: values.workspace }),
    ...(values['max-steps'] === undefined ? {} : { maxSteps: values['max-steps'] }),
  }, process.cwd());
  const options = { maxSteps: agentConfig.maxSteps,
    ...(values['no-tools'] === true ? {} : { tools: await (interactive && values['read-only'] !== true
      ? createCommandTools(agentConfig.workspace, config.provider === 'openai-compatible' ? [config.apiKey] : []) : createReadOnlyTools(agentConfig.workspace)) }),
  };
  if (interactive) {
    if (values.plain !== true && process.stdin.isTTY === true && process.stdout.isTTY === true) {
      const { runTui } = await import('./tui.ts');
      await runTui(new Conversation(provider, config.model, options));
      return;
    }
    const terminal = createInterface({
      input: process.stdin, output: process.stdout,
      terminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
      crlfDelay: Infinity,
    });
    const interrupt = () => { terminal.emit('SIGINT'); };
    process.on('SIGINT', interrupt);
    try {
      await runInteractive(new Conversation(provider, config.model, options), terminal, process.stdout, process.stderr);
    } finally {
      process.off('SIGINT', interrupt);
    }
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const response = await runTask(provider, {
      model: config.model,
      prompt: positionals.join(' '),
      options,
      onEvent: event => { if (event.type === 'tool') { process.stderr.write(`[工具] ${event.name}：${event.summary}\n`); } },
    }, controller.signal);
    process.stdout.write(`${displayText(response.text)}\n`);
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write('任务已取消。\n');
      process.exitCode = 130;
      return;
    }
    throw error;
  } finally {
    process.off('SIGINT', cancel);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
}
