/** 用真实伪终端验证构建后的 CLI；默认离线，--live 显式使用本地 .env。 */
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, capture: { type: 'boolean' } } });
const live = values.live === true;
const workspace = await mkdtemp(join(tmpdir(), 'agent-tui-pty-'));
await mkdir(join(workspace, 'tests/fixtures'), { recursive: true });
await writeFile(join(workspace, 'tests/fixtures/agent-read.txt'), 'AGENT_READ_FIXTURE\n');
const terminal = new xterm.Terminal({ cols: 130, rows: 34, allowProposedApi: true });
terminal.loadAddon(new unicode11.Unicode11Addon());
terminal.unicode.activeVersion = '11';
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  // node-pty 会把 undefined 序列化成字符串，因此不传递缺失值。
  if (value !== undefined && key !== 'NO_COLOR' && key !== 'CI') { env[key] = value; }
}
env['FORCE_COLOR'] = '3'; env['COLORTERM'] = 'truecolor';
if (!live) { env['CODING_AGENT_API_KEY'] = ''; }
const args = live ? ['--env', '.env'] : ['--provider', 'mock', '--model', 'mock-v1'];
const child = pty.spawn(process.execPath, ['dist/cli.js', ...args, '--workspace', workspace], {
  cwd: process.cwd(), cols: terminal.cols, rows: terminal.rows, name: 'xterm-256color', env,
});
let raw = '';
let exitResult: { exitCode: number; signal?: number } | undefined;
const dataListener = child.onData(data => { raw += data; terminal.write(data); });
const replyListener = terminal.onData(data => child.write(data));
const exitListener = child.onExit(result => { exitResult = result; });
const captures: object[] = [];

function screen(): string {
  return Array.from({ length: terminal.rows }, (_, row) =>
    terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? '').join('\n');
}

async function waitFor(predicate: () => boolean, label: string, timeout = 15000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.equal(exitResult, undefined, `CLI exited before ${label}`);
    // 失败诊断只记录测试阶段，真实服务模式也不输出终端或密钥内容。
    if (Date.now() >= deadline) { throw new Error(`PTY timeout: ${label}`); }
    await new Promise<void>(resolve => setTimeout(resolve, 30));
  }
}

async function type(text: string, expected = `你 › ${text}`): Promise<void> {
  child.write(text);
  await waitFor(() => screen().includes(expected), 'input');
}

function capture(name: string): void {
  if (values.capture !== true || live) { return; }
  const cells = Array.from({ length: terminal.rows }, (_, row) => {
    const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row);
    return Array.from({ length: terminal.cols }, (_, column) => {
      const cell = line?.getCell(column);
      return cell === undefined ? null : {
        text: cell.getChars(), width: cell.getWidth(),
        fg: cell.getFgColor(), fgMode: cell.isFgRGB() ? 'rgb' : cell.isFgPalette() ? 'palette' : 'default',
        bg: cell.getBgColor(), bgMode: cell.isBgRGB() ? 'rgb' : cell.isBgPalette() ? 'palette' : 'default',
        bold: cell.isBold() !== 0, dim: cell.isDim() !== 0,
      };
    });
  });
  captures.push({ name, columns: terminal.cols, rows: terminal.rows, cells });
}

async function resize(columns: number, rows: number): Promise<void> {
  terminal.resize(columns, rows); child.resize(columns, rows);
  await waitFor(() => screen().includes('你 ›') && terminal.buffer.active.cursorY === rows - (columns < 64 || rows < 18 ? 2 : 3), 'resize cursor');
}

try {
  await waitFor(() => screen().includes('输入消息或 /help') && screen().includes('DeepSeek · 会话状态'), 'welcome');
  assert.equal(terminal.buffer.active.type, 'alternate');
  capture('welcome-130x34');
  const prompt = live ? '请仅回复：界面连接成功' : '你好，小鲸';
  await type(prompt); child.write('\r');
  await waitFor(() => screen().includes(live ? '界面连接成功' : '已收到任务：你好，小鲸') && screen().includes('对话 · 1 轮'), 'response', live ? 120000 : 15000);
  capture('reply-130x34');
  if (!live) {
    await type('演示读取 tests/fixtures/agent-read.txt'); child.write('\r');
    await waitFor(() => screen().includes('AGENT_READ_FIXTURE') && screen().includes('read_file：读取'), 'real file tool');
    await waitFor(() => screen().includes('对话 · 2 轮'), 'tool turn');
    capture('tool-130x34');
    const proposal = '演示修改 ' + JSON.stringify({ path: 'edited.txt', content: 'PTY_CONFIRMED\n', expected_sha256: null });
    await type(proposal, '"expected_sha256":null}'); child.write('\r');
    await waitFor(() => screen().includes('待确认 edit-1') && screen().includes('+PTY_CONFIRMED'), 'file preview');
    await assert.rejects(readFile(join(workspace, 'edited.txt')), { code: 'ENOENT' });
    capture('diff-130x34');
    await type('/apply edit-1'); child.write('\r');
    await waitFor(() => screen().includes('已应用 edit-1') && screen().includes('对话 · 4 轮'), 'confirmed write');
    assert.equal(await readFile(join(workspace, 'edited.txt'), 'utf8'), 'PTY_CONFIRMED\n');
    const draft = '中文🐳'.repeat(25) + '尾部';
    await type(draft, '尾部');
    await resize(80, 24);
    await waitFor(() => screen().includes('尾部') && !screen().includes('DeepSeek · 会话状态'), 'normal layout');
    capture('draft-80x24');
    await resize(40, 12);
    await waitFor(() => screen().includes('尾部') && !screen().includes('╭'), 'compact layout');
    capture('draft-40x12');
    child.write('\r');
    await waitFor(() => screen().includes('输入消息或 /help'), 'long draft sent');
    await resize(130, 34);
    await waitFor(() => screen().includes('对话 · 5 轮'), 'draft preserved after resize');
    const messages = Array.from({ length: terminal.rows }, (_, row) =>
      terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true, 0, terminal.cols - 34) ?? '').join('');
    assert.ok(messages.replace(/[\s│╭╮╰╯─]/g, '').includes(`已收到任务：${draft}`), 'Entire draft should survive resize');
    await type('/clear'); child.write('\r');
    await waitFor(() => screen().includes('上下文已清空') && screen().includes('对话 · 0 轮'), 'clear');
    await type('/help'); child.write('\r');
    await waitFor(() => screen().includes('/apply 编号'), 'help');
  }
  await type('/exit'); child.write('\r');
  const deadline = Date.now() + 10000;
  while (exitResult === undefined && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 30));
  }
  assert.equal(exitResult?.exitCode, 0, 'CLI should exit normally');
  assert.ok(raw.includes('\x1b[?1049h') && raw.includes('\x1b[?1049l'), 'Alternate screen should be restored');
  if (values.capture === true && !live) { await writeFile('.git/tui-captures.json', JSON.stringify(captures)); }
  console.log(JSON.stringify({ status: 'passed', provider: live ? 'local-api' : 'mock', realPty: true,
    dimensions: live ? ['130x34'] : ['130x34', '80x24', '40x12'], restoresScreen: true, exitCode: exitResult.exitCode }));
} finally {
  // Windows 的 ConPTY 在子进程正常退出后仍持有输入管道，需要显式释放。
  if (exitResult === undefined || process.platform === 'win32') { child.kill(); }
  dataListener.dispose(); replyListener.dispose(); exitListener.dispose(); terminal.dispose();
  await rm(workspace, { recursive: true, force: true });
}
