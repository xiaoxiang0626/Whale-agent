/** 单次任务 CLI；业务逻辑通过 runTask 调用注入的 provider。 */
import { parseArgs } from 'node:util';
import { AppError } from './errors.ts';
import { resolveConfig } from './config.ts';
import { createMockProvider } from './providers/mock.ts';
import { runTask } from './task.ts';

const help = `my-coding-agent — 编码 Agent 学习项目

用法：pnpm dev [--provider mock] [--model mock-v1] "你的任务"

  --help, -h      显示帮助
  --provider      模型适配器（当前仅 mock）
  --model         模型名称（mock 只回显输入，不运行模型）

当前为离线演示：不会调用 API、读取代码、修改文件或执行命令。`;

function parseInput() {
  try {
    return parseArgs({
      options: {
        help: { type: 'boolean', short: 'h' },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error
      && typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_')) {
      throw new AppError('INVALID_ARGUMENTS', '参数无效，请运行 pnpm dev --help 查看用法。');
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseInput();
  if (values.help === true) {
    process.stdout.write(`${help}\n`);
    return;
  }
  const config = resolveConfig(process.env, {
    ...(values.provider === undefined ? {} : { provider: values.provider }),
    ...(values.model === undefined ? {} : { model: values.model }),
  });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const response = await runTask(createMockProvider(), {
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
