import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, commandEnvironment } from '../src/tools/process.ts';
import { createCommandTools } from '../src/tools/commands.ts';
import { Conversation } from '../src/conversation.ts';
import { createMockProvider } from '../src/providers/mock.ts';
import type { ToolSet } from '../src/tools/types.ts';

const signal = new AbortController().signal;
async function propose(tools: ToolSet, args: object) {
  return tools.execute({ id: 'proposal', name: 'propose_command', arguments: JSON.stringify(args) }, signal);
}
const spec = (code: string) => ({ program: process.execPath, args: ['-e', code], cwd: '.', timeout_ms: 3000 });

test('命令须单独确认；真实输出和非零退出码回传模型，重复确认不重跑', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await createCommandTools(root);
  const code = "require('node:fs').writeFileSync('ran.txt','yes');console.log('TEST_FAILED');process.exitCode=7";
  const proposal = await propose(tools, spec(code));
  assert.equal(proposal.ok, true); assert.match(proposal.preview ?? '', /\/run command-1/);
  await assert.rejects(readFile(join(root, 'ran.txt')), { code: 'ENOENT' });
  assert.match((await tools.action?.('apply', 'command-1', signal))?.content ?? '', /INVALID_ACTION/);
  const conversation = new Conversation(createMockProvider(), 'mock', { tools });
  const response = await conversation.send('/run command-1', signal);
  assert.equal(await readFile(join(root, 'ran.txt'), 'utf8'), 'yes');
  assert.match(response.text, /TEST_FAILED/); assert.match(response.text, /"exitCode":7/);
  assert.equal(conversation.turnCount, 1);
  await writeFile(join(root, 'ran.txt'), 'user');
  assert.match((await conversation.send('/run command-1', signal)).text, /UNKNOWN_PROPOSAL/);
  assert.equal(await readFile(join(root, 'ran.txt'), 'utf8'), 'user');
  await propose(tools, spec(code));
  await conversation.send('/reject command-2', signal);
  assert.match((await conversation.send('/run command-2', signal)).text, /UNKNOWN_PROPOSAL/);
});

test('工作目录需合法且再次校验；无效参数、密钥和过多待确认命令会被拒绝', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-command-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'sub')); await mkdir(join(root, 'other'));
  const tools = await createCommandTools(root, ['test-private-key']);
  for (const args of [{ ...spec(''), cwd: '..' }, { ...spec(''), timeout_ms: 99 }, { ...spec(''), args: ['test-private-key'] },
    { ...spec(''), program: 'node\n' }, { ...spec(''), args: [1] }]) {
    assert.equal((await propose(tools, args)).ok, false);
  }
  await propose(tools, { ...spec(''), cwd: 'sub' });
  await rm(join(root, 'sub'), { recursive: true });
  await symlink(join(root, 'other'), join(root, 'sub'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match((await tools.action?.('run', 'command-1', signal))?.content ?? '', /PATH_DENIED/);
  for (let index = 0; index < 10; index++) { assert.equal((await propose(tools, spec(''))).ok, true); }
  assert.match((await propose(tools, spec(''))).content, /PROPOSAL_LIMIT/);
  tools.clearPending?.();
  assert.match((await tools.action?.('run', 'command-2', signal))?.content ?? '', /UNKNOWN_PROPOSAL/);
});

test('执行器限制输出、隔离父环境并脱敏；不可执行程序提供固定失败', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(commandEnvironment({ PATH: 'allowed', CODING_AGENT_API_KEY: 'private', AWS_SECRET_ACCESS_KEY: 'private' }),
    { PATH: 'allowed', CI: '1', NO_COLOR: '1' });
  const result = await runCommand({ program: process.execPath, args: ['-e', "console.log(process.env.CODING_AGENT_API_KEY??'NO_KEY');console.log('fixture-key');console.log('x'.repeat(30000))"], cwd: root, timeoutMs: 5000 }, signal, ['fixture-key']);
  assert.equal(result.status, 'exited'); assert.equal(result.exitCode, 0); assert.equal(result.truncated, true);
  assert.match(result.output, /NO_KEY/); assert.match(result.output, /REDACTED/); assert.doesNotMatch(result.output, /fixture-key/);
  assert.ok(Buffer.byteLength(result.output) <= 16384);
  const failed = await runCommand({ program: join(root, 'missing-executable'), args: [], cwd: root, timeoutMs: 5000 }, signal);
  assert.equal(failed.status, 'spawn_failed'); assert.equal(failed.output, '');
});

test('超时和取消终止前台进程；取消后的实际结果仍进入会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-process-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const timeout = await runCommand({ program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: root, timeoutMs: 150 }, signal);
  assert.equal(timeout.status, 'timeout');
  const controller = new AbortController();
  const tools = await createCommandTools(root);
  await propose(tools, spec("console.log('RUNNING');setInterval(()=>{},1000)"));
  const conversation = new Conversation(createMockProvider(), 'mock', { tools: { ...tools, async action(command, id, actionSignal) {
    const timer = setTimeout(() => controller.abort(), 150);
    try { return await tools.action!(command, id, actionSignal); } finally { clearTimeout(timer); }
  } } });
  await assert.rejects(conversation.send('/run command-1', controller.signal), { name: 'AbortError' });
  assert.match(conversation.messages.at(-1)?.content ?? '', /"status":"cancelled"/);
});
