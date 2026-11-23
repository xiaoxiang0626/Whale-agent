import { whalePalette, whalePixels } from './mascot-art.ts';

const compact = [
  "         .-~^~^~-.",
  "        / /\\/\\   \\",
  "   <~~(  (o  o)  )~~>",
  "       \\  \\_v_/ /       _/\\",
  "      / /<\\<>/> \\ \\__.-'  /",
  "     ( ( /[~~]\\ ) )  \\__/",
  "      \\_/|_<>_|\\_/",
  "         /_/\\_\\"
].join("\n");

const tiny = [
  "    .-^~^-.",
  "  <( o  o )>",
  "   /<\\_/> \\__><",
  "   \\_[__]_/"
].join("\n");

/** 终端当前的可用空间与颜色深度。 */
export interface MascotTerminal {
  readonly columns: number;
  readonly rows: number;
  readonly colorDepth: number;
}

function colorCode(symbol: string, background: boolean, depth: number): string {
  if (symbol === ' ') { return background ? '49' : '39'; }
  const [red, green, blue] = whalePalette[symbol as keyof typeof whalePalette];
  const prefix = background ? 48 : 38;
  if (depth >= 24) { return `${prefix};2;${red};${green};${blue}`; }
  const index = 16 + 36 * Math.round(red / 51) + 6 * Math.round(green / 51) + Math.round(blue / 51);
  return `${prefix};5;${index}`;
}

/**
 * 绘制会话启动形象；窄窗口或无颜色终端使用纯文本，彩色版本使用半块字符。
 * @param terminal 当前终端尺寸和颜色能力。
 * @returns 以换行结束、不会遗留终端颜色的装饰文本。
 */
export function renderWhaleMascot(terminal: MascotTerminal): string {
  const size = Math.min(44, Math.floor((terminal.columns - 2) / 2) * 2, (terminal.rows - 8) * 2);
  if (terminal.columns < 16 || terminal.rows < 12) { return '鲸鱼娘\n\n'; }
  if (terminal.colorDepth < 8 || size < 28) {
    return `${terminal.columns >= 30 && terminal.rows >= 18 ? compact : tiny}\n  鲸鱼娘\n\n`;
  }
  const pixel = (x: number, y: number): string =>
    whalePixels[Math.floor(y * 44 / size)]?.[Math.floor(x * 44 / size)] ?? ' ';
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = '  ';
    let previous = '';
    for (let x = 0; x < size; x++) {
      const upper = pixel(x, y);
      const lower = pixel(x, y + 1);
      const foreground = upper === ' ' ? lower : upper;
      const background = upper === ' ' || lower === ' ' || upper === lower ? ' ' : lower;
      const style = `${colorCode(foreground, false, terminal.colorDepth)};${colorCode(background, true, terminal.colorDepth)}`;
      if (style !== previous) { line += `\u001b[${style}m`; previous = style; }
      line += upper === lower ? (upper === ' ' ? ' ' : '█') : (upper === ' ' ? '▄' : '▀');
    }
    lines.push(`${line}\u001b[0m`);
  }
  return `${lines.join('\n')}\n  鲸鱼娘 · my-coding-agent\n\n`;
}
