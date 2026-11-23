import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function cli(...args: string[]) {
  return cliWithEnv(args, { ...process.env, CODING_AGENT_PROVIDER: 'mock', CODING_AGENT_MODEL: 'mock-v1' });
}

function cliWithEnv(args: string[], env: NodeJS.ProcessEnv, input?: string) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env,
    ...(input === undefined ? {} : { input }),
  });
}

test('CLI 可显示帮助并运行不依赖密钥的演示', () => {
  const empty = cli();
  assert.equal(empty.error, undefined);
  assert.equal(empty.status, 0);
  assert.equal(empty.stderr, '');
  assert.match(empty.stdout, /用法：my-coding-agent/);
  const help = cli('--help');
  assert.equal(help.error, undefined);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /默认使用 mock 离线演示/);
  const result = cli('解释这个项目');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /模拟响应/);
  assert.match(result.stdout, /解释这个项目/);
  assert.doesNotMatch(result.stdout, /DeepSeek|\u001b\[/);
});

test('显式环境文件可以加载，CLI 和已有环境变量优先，读取失败不会泄露文件内容', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coding-agent-env-'));
  const file = join(directory, 'test.env');
  await writeFile(file, 'CODING_AGENT_PROVIDER=invalid-file-provider\nCODING_AGENT_API_KEY=private-test-key\n');
  t.after(async () => { await unlink(file); await rmdir(directory); });
  const env = { ...process.env };
  delete env['CODING_AGENT_PROVIDER'];
  const loaded = cliWithEnv(['--env', file, 'task'], env);
  assert.equal(loaded.status, 1);
  assert.match(loaded.stderr, /INVALID_CONFIG.*适配器必须/);
  assert.doesNotMatch(loaded.stderr, /private-test-key|invalid-file-provider/);
  assert.equal(cliWithEnv(['--env', file, '--provider', 'mock', 'task'], env).status, 0);
  assert.equal(cli('--env', file, 'task').status, 0);
  const missing = cli('--env', join(directory, 'missing.env'), 'task');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /无法加载环境文件/);
  assert.equal(cli('--env', join(directory, 'missing.env'), '--help').status, 0);
});

test('CLI 为无效参数、空任务和未支持的 provider 返回非零状态', () => {
  for (const args of [[' '], ['--unknown'], ['--model'], ['--provider', 'mock'], ['--provider', 'real-api', 'task'], ['-i', 'task']]) {
    const result = cli(...args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /\[(EMPTY_PROMPT|INVALID_ARGUMENTS|INVALID_CONFIG)\]/);
  }
});

test('显式交互模式处理多条输入并退出，非交互空输入仍显示帮助', () => {
  const result = cliWithEnv(['--interactive'], {
    ...process.env, CODING_AGENT_PROVIDER: 'mock', CODING_AGENT_MODEL: 'mock-v1',
  }, '第一条\n第二条\n/exit\n不会发送\n');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /交互会话/);
  assert.match(result.stdout, /DeepSeek/);
  assert.doesNotMatch(result.stdout, /\u001b\[/);
  assert.match(result.stdout, /已收到任务：第一条/);
  assert.match(result.stdout, /已收到任务：第二条/);
  assert.doesNotMatch(result.stdout, /已收到任务：不会发送/);
});

test('CLI 在指定工作区执行离线工具循环，拒绝凭据读取并支持纯文本模式', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coding-agent-cli-tools-'));
  const file = join(directory, 'fixture.txt');
  await writeFile(file, 'public-code-fixture\n');
  t.after(async () => { await unlink(file); await rmdir(directory); });
  const result = cli('--workspace', directory, '演示读取 fixture.txt');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /public-code-fixture/);
  assert.match(result.stderr, /\[工具\] read_file/);
  const denied = cli('--workspace', directory, '演示读取 .env');
  assert.equal(denied.status, 0); assert.match(denied.stdout, /PATH_DENIED/);
  const plain = cli('--workspace', directory, '--no-tools', '演示读取 fixture.txt');
  assert.equal(plain.status, 0); assert.doesNotMatch(plain.stdout, /public-code-fixture/); assert.equal(plain.stderr, '');
  const limited = cli('--workspace', directory, '--max-steps', '1', '演示读取 fixture.txt');
  assert.equal(limited.status, 1); assert.match(limited.stderr, /AGENT_LIMIT/);
});

test('CLI 交互模式显示预览并接受明确确认，单次和只读模式均不提供写入工具', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cli-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const demo = '演示修改 ' + JSON.stringify({ path: 'new.txt', content: 'confirmed\n', expected_sha256: null });
  const env = { ...process.env, CODING_AGENT_PROVIDER: 'mock', CODING_AGENT_MODEL: 'mock-v1' };
  for (const args of [['--workspace', root, demo], ['--workspace', root, '-i', '--read-only']]) {
    assert.equal(cliWithEnv(args, env, `${demo}\n/apply edit-1\n/exit\n`).status, 0);
    await assert.rejects(readFile(join(root, 'new.txt')), { code: 'ENOENT' });
  }
  const result = cliWithEnv(['--workspace', root, '-i'], env, `${demo}\n/apply edit-1\n/exit\n`);
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.match(result.stdout, /待确认 edit-1/); assert.match(result.stdout, /\+confirmed/);
  assert.match(result.stdout, /已应用 edit-1/);
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'confirmed\n');
});

test('CLI 新建和恢复命名会话，拒绝覆盖、模式冲突与无效恢复参数', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cli-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, CODING_AGENT_PROVIDER: 'mock', CODING_AGENT_MODEL: 'mock-v1' };
  const created = cliWithEnv(['-i', '--workspace', root, '--session', '学习'], env, '保留历史\n/exit\n');
  assert.equal(created.status, 0); assert.match(created.stdout, /会话日志/);
  const resumed = cliWithEnv(['-i', '--workspace', root, '--resume', '学习'], env, '继续\n/exit\n');
  assert.equal(resumed.status, 0); assert.match(resumed.stdout, /已完成 1 轮/);
  const log = await readFile(join(root, '.coding-agent/sessions/学习.jsonl'), 'utf8');
  assert.match(log, /保留历史/); assert.match(log, /会话恢复/); assert.match(log, /继续/);
  for (const args of [['-i', '--session', '学习'], ['-i', '--resume', '学习', '--read-only'],
    ['-i', '--session', 'x', '--resume', 'x'], ['-i', '--repair-session'], ['-i', '--resume', '../escape']]) {
    assert.equal(cliWithEnv(['--workspace', root, ...args], env, '/exit\n').status, 1);
  }
});
