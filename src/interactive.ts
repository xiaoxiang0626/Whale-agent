import type { Interface } from 'node:readline';
import type { Writable } from 'node:stream';
import type { Conversation } from './conversation.ts';
import { formatError } from './errors.ts';
import { renderDeepSeekLogo } from './mascot.ts';
import { displayText } from './display.ts';

/** 交互输出流，可提供终端尺寸和颜色能力。 */
export interface InteractiveOutput extends Writable {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  /** @returns 终端支持的颜色位数。 */
  getColorDepth?(): number;
}

const commands = '/help 帮助 · /clear 清空 · /exit 退出 · /apply 编号 应用 · /run 编号 执行 · /reject 编号 拒绝\n请求期间 Ctrl+C 取消本次请求；空闲时 Ctrl+C 退出。';

/**
 * 连续处理终端输入，按顺序发送请求；结束时关闭传入的 readline 接口。
 * @param conversation 仅在本进程保留历史的会话。
 * @param terminal 调用方创建的逐行输入接口，其 SIGINT 事件控制取消和退出。
 * @param output 正常终端输出。
 * @param errors 固定格式的失败诊断。
 * @returns 会话退出后完成。
 */
export async function runInteractive(
  conversation: Conversation, terminal: Interface, output: InteractiveOutput, errors: Writable,
): Promise<void> {
  let active: AbortController | undefined;
  let exiting = false;
  let inputClosed = false;
  const closed = () => { inputClosed = true; };
  const interrupt = () => {
    if (active !== undefined && !active.signal.aborted) { active.abort(); }
    else { exiting = true; terminal.close(); }
  };
  terminal.on('SIGINT', interrupt);
  terminal.once('close', closed);
  const unsubscribe = conversation.subscribe(event => {
    if (event.type === 'tool') { output.write(displayText(`[工具] ${event.name}：${event.summary}\n${event.preview === undefined ? '' : `${event.preview}\n`}`)); }
  });
  terminal.setPrompt('你> ');
  output.write(renderDeepSeekLogo({
    columns: output.columns ?? 80, rows: output.rows ?? 30,
    colorDepth: output.isTTY === true && process.env['NO_COLOR'] === undefined ? (output.getColorDepth?.() ?? 1) : 1,
  }));
  output.write(`my-coding-agent · 交互会话\n模型：${conversation.model} · 适配器：${conversation.providerId}\n${conversation.workspace === undefined ? '' : `工作区：${conversation.workspace}\n`}${commands}\n\n`);
  terminal.prompt();
  try {
    for await (const line of terminal) {
      if (exiting) { break; }
      const input = line.trim();
      if (input === '/exit') { break; }
      if (input === '/help') { output.write(`${commands}\n`); }
      else if (input === '/clear') { conversation.clear(); output.write('已清空上下文。\n'); }
      else if (input.startsWith('/') && !/^\/(apply|reject|run) [a-zA-Z0-9-]+$/.test(input)) { errors.write('未知命令，请输入 /help 查看帮助。\n'); }
      else if (input.length > 0) {
        active = new AbortController();
        output.write('正在思考…\n');
        try {
          const response = await conversation.send(input, active.signal);
          output.write(`助手> ${displayText(response.text)}\n\n`);
        } catch (error) {
          if (active.signal.aborted) { output.write('已取消本次请求；已完成的确认操作不回滚。\n'); }
          else { errors.write(`${formatError(error)}\n`); }
        } finally {
          active = undefined;
        }
      }
      if (exiting) { break; }
      if (!inputClosed) { terminal.prompt(); }
    }
  } finally {
    terminal.off('SIGINT', interrupt);
    terminal.off('close', closed);
    unsubscribe();
    terminal.close();
    output.write('会话已结束。\n');
  }
}
