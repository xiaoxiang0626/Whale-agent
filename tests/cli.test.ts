import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function cli(...args: string[]) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, CODING_AGENT_PROVIDER: 'mock', CODING_AGENT_MODEL: 'mock-v1' },
  });
}

test('CLI 可显示帮助并运行不依赖密钥的演示', () => {
  const help = cli('--help');
  assert.equal(help.error, undefined);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /当前为离线演示/);
  const result = cli('解释这个项目');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /模拟响应/);
  assert.match(result.stdout, /解释这个项目/);
});

test('CLI 为无效参数、空任务和未支持的 provider 返回非零状态', () => {
  for (const args of [[], ['--unknown'], ['--model'], ['--provider', 'real-api', 'task']]) {
    const result = cli(...args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /\[(EMPTY_PROMPT|INVALID_ARGUMENTS|INVALID_CONFIG)\]/);
  }
});
