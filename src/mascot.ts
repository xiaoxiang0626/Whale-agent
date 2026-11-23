import { deepseekWhale } from './mascot-art.ts';

const compact = [
  '        ___        __',
  "   .---'   `-.___./  |",
  " .'   .--.       \\  /",
  '/    /    `-.  o  \\/',
  '\\    \\__     `-.__/',
  " `-.__  `---.____/",
  "      `-------'",
];
const tiny = [
  '      __       /|',
  " .---'  `-.___/ /",
  '(  ._  o      _/',
  " `-._`-------'",
];

/** 终端当前的可用空间与颜色深度。 */
export interface MascotTerminal {
  readonly columns: number;
  readonly rows: number;
  readonly colorDepth: number;
}

/**
 * 绘制 DeepSeek 蓝鲸字符图标，结束时恢复颜色；窗口不足时使用简化图标或名称。
 * @param terminal 当前终端尺寸和颜色能力。
 * @returns 以一个换行结束、不包含图片协议的文字图标。
 */
export function renderDeepSeekLogo(terminal: MascotTerminal): string {
  const label = 'DeepSeek'.slice(0, Math.max(0, terminal.columns));
  let lines: readonly string[];
  if (terminal.columns >= 28 && terminal.rows >= 17 && terminal.colorDepth >= 8) {
    lines = [...deepseekWhale, '         DeepSeek'];
  } else if (terminal.columns >= 28 && terminal.rows >= 14) {
    lines = [...compact, '      DeepSeek'];
  } else if (terminal.columns >= 18 && terminal.rows >= 10) {
    lines = [...tiny, '    DeepSeek'];
  } else { lines = [label]; }
  const color = terminal.colorDepth >= 24 ? '\x1b[38;2;77;107;254m'
    : terminal.colorDepth >= 8 ? '\x1b[38;5;63m' : '';
  return `${color}${lines.join('\n')}${color.length > 0 ? '\x1b[0m' : ''}\n`;
}
