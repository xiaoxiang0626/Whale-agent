import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, appendFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionJournal, sessionPath } from '../src/session.ts';
import type { SessionIdentity } from '../src/session.ts';
import { Conversation } from '../src/conversation.ts';
import { createCommandTools } from '../src/tools/commands.ts';
import { createMockProvider } from '../src/providers/mock.ts';
import { AppError } from '../src/errors.ts';
import type { ModelProvider, ModelRequest } from '../src/providers/types.ts';

const signal = new AbortController().signal;
const matches = (code: string) => (error: Error) => error instanceof AppError && error.code === code;
const identity = (root: string): SessionIdentity => ({ workspace: root, provider: 'mock', model: 'mock', mode: 'confirmed' });

test('完整请求、推理、工具与成功历史写入日志；重启恢复后旧提案失效', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await sessionPath(root, '学习');
  const journal = await SessionJournal.open(path, identity(root), false, false, ['fixture-private-key']);
  const tools = await createCommandTools(root);
  assert.match((await tools.execute({ id: 'protected', name: 'read_file', arguments: '{"path":".coding-agent/sessions/学习.jsonl"}' }, signal)).content, /PATH_DENIED/);
  const conversation = new Conversation(createMockProvider(), 'mock', { tools, journal });
  await conversation.send('演示修改 {"path":"new.txt","content":"new","expected_sha256":null}', signal);
  await journal.close();
  const raw = await readFile(path, 'utf8');
  assert.match(raw, /"kind":"request"/); assert.match(raw, /"kind":"response"/); assert.match(raw, /propose_file/);
  assert.doesNotMatch(raw, /fixture-private-key|Authorization|Bearer/);
  const recovered = await SessionJournal.open(path, identity(root), true);
  t.after(() => recovered.close());
  const restored = new Conversation(createMockProvider(), 'mock', { tools: await createCommandTools(root), journal: recovered });
  assert.equal(restored.turnCount, 1); assert.match(restored.messages.at(-1)?.content ?? '', /提案全部失效/);
  assert.match((await restored.send('/apply edit-1', signal)).text, /UNKNOWN_PROPOSAL/);
  await assert.rejects(readFile(join(root, 'new.txt')), { code: 'ENOENT' });
  restored.clear(); assert.equal(restored.turnCount, 0);
  assert.deepEqual(recovered.state.messages, []);
});

test('操作结束结果先于模型回复保存；模型失败不丢失已经写入的事实', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-session-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await sessionPath(root, 'result');
  const journal = await SessionJournal.open(path, identity(root), false);
  const tools = await createCommandTools(root);
  await tools.execute({ id: 'p', name: 'propose_file', arguments: '{"path":"saved.txt","content":"saved","expected_sha256":null}' }, signal);
  const conversation = new Conversation({ id: 'fail', async complete() { throw new Error('private'); } }, 'mock', { tools, journal });
  await assert.rejects(conversation.send('/apply edit-1', signal));
  await journal.close();
  const recovered = await SessionJournal.open(path, identity(root), true);
  t.after(() => recovered.close());
  assert.equal(await readFile(join(root, 'saved.txt'), 'utf8'), 'saved');
  assert.ok(recovered.state.messages.some(message => message.content.includes('"status":"applied"')));
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.findIndex(row => row.kind === 'action_begin') < rows.findIndex(row => row.kind === 'action_end'));
  assert.equal(recovered.state.blocked, false);
});

test('中断的确认操作恢复为未知，禁止确认副作用；不重放任何命令', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-session-interrupted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await sessionPath(root, 'interrupted');
  const journal = await SessionJournal.open(path, identity(root), false);
  journal.append({ kind: 'action_begin', data: { input: '/run command-1' } });
  await journal.close();
  const recovered = await SessionJournal.open(path, identity(root), true);
  t.after(() => recovered.close());
  let actions = 0;
  const tools = await createCommandTools(root);
  const conversation = new Conversation(createMockProvider(), 'mock', { journal: recovered, tools: { ...tools, async action() { actions++; throw new Error('Must not execute'); } } });
  assert.match(conversation.messages.at(-1)?.content ?? '', /操作结果未知/);
  await assert.rejects(conversation.send('/run command-1', signal), matches('ACTION_UNCERTAIN'));
  conversation.clear();
  await assert.rejects(conversation.send('/apply edit-1', signal), matches('ACTION_UNCERTAIN'));
  assert.equal(actions, 0);
  await recovered.close();
  const twice = await SessionJournal.open(path, identity(root), true);
  twice.append({ kind: 'action_begin', data: { input: '/reject missing' } });
  twice.append({ kind: 'action_end', data: { input: '/reject missing', result: { ok: false, content: '{}', summary: 'missing' }, state: twice.state } });
  await twice.close();
  const third = await SessionJournal.open(path, identity(root), true);
  assert.equal(third.state.blocked, true); await third.close();
});

test('锁阻止并发写入；未知版本、身份冲突和畸形工具历史均拒绝恢复', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-session-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await sessionPath(root, 'invalid');
  const journal = await SessionJournal.open(path, identity(root), false);
  await assert.rejects(SessionJournal.open(path, identity(root), true), matches('SESSION_IO'));
  await journal.close();
  const original = await readFile(path, 'utf8');
  await assert.rejects(SessionJournal.open(path, { ...identity(root), model: 'other' }, true), matches('SESSION_MISMATCH'));
  await writeFile(path, original.replace('"formatVersion":1', '"formatVersion":999'));
  await assert.rejects(SessionJournal.open(path, identity(root), true), matches('SESSION_VERSION'));
  await writeFile(path, original + JSON.stringify({ seq: 2, kind: 'state', data: { messages: [{ role: 'tool', toolCallId: 'orphan', content: 'x' }], turns: 1, blocked: false } }) + '\n');
  await assert.rejects(SessionJournal.open(path, identity(root), true), matches('SESSION_CORRUPT'));
  await assert.rejects(sessionPath(root, '../escape'), matches('INVALID_ARGUMENTS'));
  await assert.rejects(sessionPath(root, 'CON'), matches('INVALID_ARGUMENTS'));
});

test('不完整末行默认拒绝；显式修复先备份，损坏的完整行仍拒绝', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-session-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await sessionPath(root, 'partial');
  const journal = await SessionJournal.open(path, identity(root), false);
  journal.append({ kind: 'action_begin', data: { input: '/apply edit-1' } });
  await journal.close();
  await appendFile(path, '{"seq":3,"kind":"action_end"');
  const damaged = await readFile(path);
  await assert.rejects(SessionJournal.open(path, identity(root), true), matches('SESSION_CORRUPT'));
  const repaired = await SessionJournal.open(path, identity(root), true, true);
  await repaired.close();
  const backup = (await readdir(join(root, '.coding-agent/sessions'))).find(name => name.endsWith('.bak'));
  assert.ok(backup); assert.deepEqual(await readFile(join(root, '.coding-agent/sessions', backup)), damaged);
  const again = await SessionJournal.open(path, identity(root), true);
  assert.equal(again.state.blocked, true); await again.close();
  await appendFile(path, '{broken}\n');
  await assert.rejects(SessionJournal.open(path, identity(root), true, true), matches('SESSION_CORRUPT'));
});

test('关闭或写入受保护密钥的日志会在模型调用前停止；日志目录不能为链接', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-session-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await sessionPath(root, 'private');
  const journal = await SessionJournal.open(path, identity(root), false, false, ['fixture-private-key']);
  let calls = 0;
  const conversation = new Conversation({ id: 'test', async complete() { calls++; return { text: 'done' }; } }, 'mock', { journal });
  await assert.rejects(conversation.send('fixture-private-key', signal), matches('SESSION_SECRET'));
  assert.equal(calls, 0);
  await journal.close();
  await assert.rejects(conversation.send('after close', signal), matches('SESSION_IO'));
  assert.equal(calls, 0);
  assert.doesNotMatch(await readFile(path, 'utf8'), /fixture-private-key/);
  const linked = join(root, 'linked'); await mkdir(linked);
  await symlink(join(root, '.coding-agent'), join(linked, '.coding-agent'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(sessionPath(linked, 'test'), matches('SESSION_IO'));
});

test('请求原样记录推理与工具 ID，失败轮次不成为恢复后的成功历史', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-session-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await sessionPath(root, 'wire');
  const journal = await SessionJournal.open(path, identity(root), false);
  const tools = await createCommandTools(root);
  let calls = 0;
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = { id: 'test', async complete(request) {
    requests.push(request); calls++;
    if (calls === 1) { return { text: '', reasoningContent: 'synthetic-reasoning', toolCalls: [{ id: 'id-1', name: 'list_files', arguments: '{"path":"."}' }] }; }
    if (calls === 2) { return { text: 'done' }; }
    throw new Error('private-error');
  } };
  const conversation = new Conversation(provider, 'mock', { tools, journal });
  await conversation.send('first', signal);
  await assert.rejects(conversation.send('failed', signal));
  await journal.close();
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.filter(row => row.kind === 'request').map(row => row.data), requests);
  assert.match(await readFile(path, 'utf8'), /synthetic-reasoning/);
  const recovered = await SessionJournal.open(path, identity(root), true);
  t.after(() => recovered.close());
  assert.equal(recovered.state.turns, 1);
  assert.ok(recovered.state.messages.some(message => message.role === 'assistant' && message.reasoningContent === 'synthetic-reasoning'));
  assert.ok(!recovered.state.messages.some(message => message.content === 'failed'));
  assert.ok(!recovered.state.messages.some(message => message.content.includes('.coding-agent/sessions/wire')));
});
