#!/usr/bin/env node
/** 单次任务 CLI；业务逻辑通过 runTask 调用注入的 provider。 */
import { parseArgs } from 'node:util';
import { AppError } from './errors.ts';
import { resolveConfig } from './config.ts';
import { createProvider } from './providers/index.ts';
import { runTask } from './task.ts';

const help = `my-coding-agent — 编码 Agent 学习项目

用法：my-coding-agent [选项] "你的任务"

  --help, -h      显示帮助
  --provider      模型适配器（mock 或 openai-compatible）
  --model         模型名称
  --base-url      模型 API 的基础地址
  --env           显式加载本地环境文件

示例：my-coding-agent "解释这个项目"
源码开发：pnpm dev "解释这个项目"

默认使用 mock 离线演示；openai-compatible 可连接自己的模型 API。
当前不会读取代码、修改文件或执行命令。`;

function parseInput() {
  try {
    return parseArgs({
      options: {
        help: { type: 'boolean', short: 'h' },
        provider: { type: 'string' },
        model: { type: 'string' },
        'base-url': { type: 'string' },
        env: { type: 'string' },
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
  if (values.help === true || process.argv.length === 2) {
    process.stdout.write(`${help}\n`);
    return;
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
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const response = await runTask(createProvider(config), {
      model: config.model,
      prompt: positionals.join(' '),
    }, controller.signal);
    process.stdout.write(`${response.text}\n`);
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
  process.stderr.write(error instanceof AppError
    ? `[${error.code}] ${error.message}\n`
    : '任务失败，未获得有效响应。\n');
  process.exitCode = 1;
}
