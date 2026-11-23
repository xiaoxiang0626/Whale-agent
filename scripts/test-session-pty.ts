/** 用两个独立的构建产物进程验证终端会话恢复，不访问真实 API。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';

const root = await mkdtemp(join(tmpdir(), 'agent-session-pty-'));
async function run(resume: boolean): Promise<void> {
  const terminal = new xterm.Terminal({ cols: 130, rows: 34, allowProposedApi: true });
  terminal.loadAddon(new unicode11.Unicode11Addon()); terminal.unicode.activeVersion = '11';
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !['CI', 'NO_COLOR'].includes(entry[0])));
  const child = pty.spawn(process.execPath, ['dist/cli.js', '--provider', 'mock', '--model', 'mock-v1', '--workspace', root, resume ? '--resume' : '--session', 'pty'],
    { cwd: process.cwd(), cols: 130, rows: 34, name: 'xterm-256color', env });
  let exitCode: number | undefined;
  let raw = '';
  const data = child.onData(value => { raw += value; terminal.write(value); });
  const replies = terminal.onData(value => child.write(value));
  const exited = child.onExit(result => { exitCode = result.exitCode; });
  const screen = () => Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? '').join('\n');
  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      assert.equal(exitCode, undefined, `CLI exited: ${label}`);
      if (Date.now() > deadline) { throw new Error(`Session PTY timeout: ${label}`); }
      await new Promise<void>(resolve => setTimeout(resolve, 30));
    }
  }
  try {
    await waitFor(() => screen().includes('输入消息或 /help'), 'ready');
    if (resume) { assert.match(screen(), /恢复之前/); assert.match(screen(), /会话恢复/); }
    const text = resume ? '恢复之后' : '恢复之前';
    child.write(text); await waitFor(() => screen().includes(`你 › ${text}`), 'input'); child.write('\r');
    await waitFor(() => screen().includes(`已收到任务：${text}`) && screen().includes(`对话 · ${resume ? 2 : 1} 轮`), 'response');
    child.write('/exit'); await waitFor(() => screen().includes('你 › /exit'), 'exit input'); child.write('\r');
    const deadline = Date.now() + 10000;
    while (exitCode === undefined && Date.now() < deadline) { await new Promise<void>(resolve => setTimeout(resolve, 30)); }
    assert.equal(exitCode, 0); assert.ok(raw.includes('\x1b[?1049h') && raw.includes('\x1b[?1049l'));
  } finally {
    if (exitCode === undefined || process.platform === 'win32') { child.kill(); }
    data.dispose(); replies.dispose(); exited.dispose(); terminal.dispose();
  }
}
try {
  await run(false); await run(true);
  const rows = (await readFile(join(root, '.coding-agent/sessions/pty.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.at(-1).data.turns, 2);
  console.log(JSON.stringify({ status: 'passed', realPty: true, independentProcesses: 2, resumedTurns: 2, restoresScreen: true }));
} finally { await rm(root, { recursive: true, force: true }); }
