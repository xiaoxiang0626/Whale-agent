import { createElement as h, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { stripVTControlCharacters } from 'node:util';
import { renderDeepSeekLogo } from './mascot.ts';
import { InputLine } from './tui-input.ts';

const sidebarWidth = 34;

/** 终端显示记录；失败输入可以显示，但不进入模型的成功历史。 */
export interface DisplayEntry {
  readonly role: 'user' | 'assistant' | 'notice' | 'error';
  readonly text: string;
}

/** 当前终端中各区域的字符尺寸。 */
export interface TuiLayout {
  readonly columns: number;
  readonly rows: number;
  readonly compact: boolean;
  readonly sidebar: boolean;
  readonly bodyHeight: number;
  readonly historyRows: number;
  readonly messageWidth: number;
}

/**
 * 为固定输入区预留空间，小窗口收起边框和侧栏。
 * @param columns 当前列数。
 * @param rows 当前行数。
 * @returns 终端布局尺寸。
 */
export function getTuiLayout(columns: number, rows: number): TuiLayout {
  const compact = columns < 64 || rows < 18;
  const sidebar = columns >= 100 && rows >= 26;
  const bodyHeight = Math.max(0, rows - (compact ? 3 : 7));
  return {
    columns, rows, compact, sidebar, bodyHeight,
    historyRows: Math.max(0, bodyHeight - (compact ? 0 : 3)),
    messageWidth: Math.max(1, columns - (sidebar ? sidebarWidth : 0) - (compact ? 0 : 4)),
  };
}

/** 终端界面所需状态和输入回调。 */
export interface TerminalViewProps {
  readonly columns: number;
  readonly rows: number;
  readonly colorDepth: number;
  readonly model: string;
  readonly provider: string;
  readonly entries: readonly DisplayEntry[];
  readonly turns: number;
  readonly query: string;
  readonly pending: boolean;
  readonly status: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
}

const labels = { user: '你', assistant: '助手', notice: '提示', error: '错误' };
const colors = { user: 'cyan', assistant: undefined, notice: 'gray', error: 'red' };

function displayText(value: string): string {
  return stripVTControlCharacters(value).replace(/\r\n/g, '\n').replace(/\r/g, '')
    .replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/**
 * 绘制界面，消息按终端列宽折行并只显示当前视口。
 * @param props 布局、会话显示状态和输入回调。
 * @returns 终端界面元素。
 */
export function TerminalView(props: TerminalViewProps): ReactElement {
  const layout = getTuiLayout(props.columns, props.rows);
  const lines = useMemo(() => props.entries.flatMap(entry => [
    ...wrapAnsi(`${labels[entry.role]}  ${displayText(entry.text)}`, layout.messageWidth,
      { hard: true, wordWrap: false, trim: false }).split('\n')
      .map(text => ({ text, color: colors[entry.role] })),
    { text: '', color: undefined },
  ]), [props.entries, layout.messageWidth]);
  const [scrollOffset, setScrollOffset] = useState(0);
  useEffect(() => { setScrollOffset(0); }, [props.entries]);
  const maxOffset = Math.max(0, lines.length - layout.historyRows);
  const offset = Math.min(scrollOffset, maxOffset);
  const pageSize = Math.max(1, layout.historyRows - 1);
  useInput((_input, key) => {
    if (key.eventType === 'release') { return; }
    if (key.pageUp) { setScrollOffset(Math.min(maxOffset, offset + pageSize)); }
    if (key.pageDown) { setScrollOffset(Math.max(0, offset - pageSize)); }
  });
  const end = Math.max(0, lines.length - offset);
  const visible = lines.slice(Math.max(0, end - layout.historyRows), end);
  const frame = layout.compact ? {} : { borderStyle: 'round' as const, borderColor: 'gray', paddingX: 1 };
  const welcome = props.entries.length === 0;
  const mascot = useMemo(() => renderDeepSeekLogo({
    columns: layout.sidebar ? sidebarWidth - 4 : layout.messageWidth,
    rows: layout.sidebar ? layout.bodyHeight + 3 : layout.historyRows + 3,
    colorDepth: props.colorDepth,
  }).trimEnd(), [layout.sidebar, layout.messageWidth, layout.bodyHeight, layout.historyRows, props.colorDepth]);
  const header = layout.compact
    ? h(Text, { color: 'cyan', bold: true, wrap: 'truncate-end' }, `小鲸 · ${props.model} · ${props.status}`)
    : h(Box, { borderStyle: 'round', borderColor: 'cyan', height: 3, paddingX: 1, flexShrink: 0, justifyContent: 'space-between' },
      h(Text, { bold: true, color: 'cyan', wrap: 'truncate-end' }, '小鲸 / my-coding-agent'),
      h(Text, { color: props.pending ? 'yellow' : 'green', wrap: 'truncate-end' }, `${props.model} · ${props.status}`));
  const messages = h(Box, { ...frame, width: layout.sidebar ? props.columns - sidebarWidth : props.columns,
    height: layout.bodyHeight, flexShrink: 0, flexDirection: 'column', overflow: 'hidden' },
  !layout.compact ? h(Text, { dimColor: true, wrap: 'truncate-end' }, `对话 · ${props.turns} 轮 · ${offset > 0 ? '浏览历史' : '最新消息'}`) : null,
  h(Box, { flexDirection: 'column', height: layout.historyRows, overflow: 'hidden' },
    welcome ? h(Box, { flexDirection: 'column' },
      h(Text, { bold: true, color: 'cyan', wrap: 'truncate-end' }, '你好，我是小鲸。'),
      h(Text, { dimColor: true, wrap: 'truncate-end' }, '输入任务开始对话，输入 /help 查看帮助。'),
      !layout.sidebar && layout.historyRows >= 8 ? h(Text, null, mascot) : null)
      : visible.map((line, index) => h(Text, {
        key: index, ...(line.color === undefined ? {} : { color: line.color }),
      }, line.text || ' '))));
  const sidebar = layout.sidebar ? h(Box, { borderStyle: 'round', borderColor: 'blue', width: sidebarWidth,
    height: layout.bodyHeight, flexShrink: 0, flexDirection: 'column', paddingX: 1, overflow: 'hidden' },
  h(Text, { color: 'cyan', bold: true }, 'DeepSeek · 会话状态'),
  h(Text, null, mascot),
  h(Text, { dimColor: true, wrap: 'truncate-end' }, `适配器 ${props.provider}`)) : null;
  const input = h(Box, { ...frame, height: layout.compact ? 1 : 3, flexShrink: 0,
    borderColor: props.pending ? 'yellow' : 'cyan', overflow: 'hidden' },
  h(Text, { color: 'cyan' }, '你 › '),
  h(InputLine, {
    value: props.query, onChange: props.onChange, onSubmit: props.onSubmit, disabled: props.pending,
    width: Math.max(1, props.columns - (layout.compact ? 5 : 9)),
    originX: layout.compact ? 5 : 7, originY: props.rows - (layout.compact ? 2 : 3),
  }));
  const footer = h(Text, { dimColor: true, wrap: 'truncate-end' },
    layout.compact ? 'Enter 发送 · Ctrl+C 取消/退出' : 'Enter 发送  ·  PgUp/PgDn 历史  ·  /clear 清空  ·  /exit 退出  ·  Ctrl+C 取消');
  return h(Box, { width: props.columns, height: props.rows, flexDirection: 'column', overflow: 'hidden' },
    header, layout.bodyHeight > 0 ? h(Box, { height: layout.bodyHeight, flexShrink: 0 }, messages, sidebar) : null, input, footer);
}
