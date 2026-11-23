import { createElement as h, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { render, useApp, useInput, useWindowSize } from 'ink';
import type { Conversation } from './conversation.ts';
import { formatError } from './errors.ts';
import { TerminalView } from './tui-view.ts';
import type { DisplayEntry } from './tui-view.ts';

/** TUI 控制器接收的会话。 */
export interface TerminalAppProps {
  readonly conversation: Conversation;
}

/**
 * 管理 TUI 输入、显示记录与当前请求，卸载时取消正在进行的请求。
 * @param props 当前会话。
 * @returns 交互终端组件。
 */
export function TerminalApp({ conversation }: TerminalAppProps): ReactElement {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [entries, setEntries] = useState<DisplayEntry[]>([]);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('就绪');
  const active = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);
  useInput((input, key) => {
    if (key.eventType === 'release') { return; }
    if (key.ctrl && input === 'c') {
      if (active.current !== undefined && !active.current.signal.aborted) {
        active.current.abort(); setStatus('正在取消');
      } else { exit(); }
    } else if (key.escape && active.current !== undefined) {
      active.current.abort(); setStatus('正在取消');
    }
  });
  const submit = async (value: string): Promise<void> => {
    const text = value.trim();
    if (text.length === 0 || active.current !== undefined) { return; }
    setQuery('');
    if (text === '/exit') { exit(); return; }
    if (text === '/clear') {
      conversation.clear(); setEntries([]); setStatus('上下文已清空'); return;
    }
    if (text === '/help') {
      setEntries(current => [...current, { role: 'notice', text: '/help 帮助 · /clear 清空上下文 · /exit 退出。PgUp/PgDn 浏览消息，Ctrl+C 或 Esc 取消请求。' }]); return;
    }
    if (text.startsWith('/')) {
      setEntries(current => [...current, { role: 'error', text: '未知命令，请输入 /help。' }]); return;
    }
    const controller = new AbortController(); active.current = controller;
    setPending(true); setStatus('正在思考');
    setEntries(current => [...current, { role: 'user', text }]);
    try {
      const response = await conversation.send(text, controller.signal);
      if (mounted.current) {
        setEntries(current => [...current, { role: 'assistant', text: response.text }]);
        setStatus('就绪');
      }
    } catch (error) {
      if (mounted.current) {
        const cancelled = controller.signal.aborted;
        setEntries(current => [...current, {
          role: cancelled ? 'notice' : 'error',
          text: cancelled ? '已取消本次请求，上下文保持不变。' : formatError(error),
        }]);
        setStatus(cancelled ? '已取消 · 可继续输入' : '请求失败 · 可重试');
      }
    } finally {
      active.current = undefined;
      if (mounted.current) { setPending(false); }
    }
  };
  return h(TerminalView, {
    columns, rows, model: conversation.model, provider: conversation.providerId,
    colorDepth: process.env['NO_COLOR'] === undefined ? (process.stdout.getColorDepth?.() ?? 1) : 1,
    entries, turns: conversation.turnCount, query, pending, status,
    onChange: setQuery, onSubmit: value => { void submit(value); },
  });
}

/**
 * 在真实终端的备用屏幕运行 TUI，退出时由 Ink 恢复终端。
 * @param conversation 本次会话。
 * @returns 终端界面关闭后完成。
 */
export async function runTui(conversation: Conversation): Promise<void> {
  const app = render(h(TerminalApp, { conversation }), {
    alternateScreen: true, interactive: true, exitOnCtrlC: false, patchConsole: false,
  });
  try { await app.waitUntilExit(); } finally { app.cleanup(); }
}
