import { createElement as h, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Text, useCursor, useInput } from 'ink';
import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), part => part.segment);

/** 单行输入的文本、可用列数、终端光标位置与回调。 */
export interface InputLineProps {
  readonly value: string;
  readonly width: number;
  readonly originX: number;
  readonly originY: number;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
}

/**
 * 按字素编辑文本，并水平移动视口以保持真实终端光标可见。
 * @param props 受控文本、空间与输入回调。
 * @returns 单行输入区域。
 */
export function InputLine(props: InputLineProps): ReactElement {
  const parts = useMemo(() => graphemes(props.value), [props.value]);
  const [position, setPosition] = useState(parts.length);
  const cursor = Math.min(position, parts.length);
  const { setCursorPosition } = useCursor();
  useInput((input, key) => {
    if (props.disabled || key.eventType === 'release' || key.ctrl || key.meta || key.super || key.hyper || key.escape || key.tab
      || key.upArrow || key.downArrow || key.pageUp || key.pageDown) { return; }
    if (key.return) { props.onSubmit(props.value); return; }
    if (key.leftArrow) { setPosition(Math.max(0, cursor - 1)); return; }
    if (key.rightArrow) { setPosition(Math.min(parts.length, cursor + 1)); return; }
    if (key.home) { setPosition(0); return; }
    if (key.end) { setPosition(parts.length); return; }
    if (key.backspace) {
      if (cursor > 0) {
        props.onChange([...parts.slice(0, cursor - 1), ...parts.slice(cursor)].join(''));
        setPosition(cursor - 1);
      }
      return;
    }
    if (key.delete) {
      props.onChange([...parts.slice(0, cursor), ...parts.slice(cursor + 1)].join(''));
      return;
    }
    const inserted = graphemes(input.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ''));
    if (inserted.length > 0) {
      props.onChange([...parts.slice(0, cursor), ...inserted, ...parts.slice(cursor)].join(''));
      setPosition(cursor + inserted.length);
    }
  });

  let start = cursor;
  let before = 0;
  while (start > 0 && before + stringWidth(parts[start - 1] ?? '') <= Math.max(0, props.width - 4)) {
    start--; before += stringWidth(parts[start] ?? '');
  }
  const leading = start > 0 ? '‹' : '';
  let end = start;
  let used = leading.length;
  while (end < parts.length && used + stringWidth(parts[end] ?? '') <= props.width - 1) {
    used += stringWidth(parts[end] ?? ''); end++;
  }
  const visible = leading + parts.slice(start, end).join('') + (end < parts.length ? '›' : '');
  setCursorPosition(props.disabled ? undefined : {
    x: props.originX + leading.length + before, y: props.originY,
  });
  return h(Text, { dimColor: props.disabled || props.value.length === 0, wrap: 'truncate-end' },
    props.disabled ? '等待回复，Ctrl+C 取消本轮' : (props.value.length === 0 ? '输入消息或 /help' : visible));
}
