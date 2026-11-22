import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConfig } from '../src/config.ts';
import { AppError } from '../src/errors.ts';

test('默认运行离线适配器，CLI 配置优先于环境变量', () => {
  assert.deepEqual(resolveConfig({}), { provider: 'mock', model: 'mock-v1' });
  assert.equal(resolveConfig({ CODING_AGENT_MODEL: 'from-env' }).model, 'from-env');
  assert.equal(resolveConfig({ CODING_AGENT_MODEL: 'from-env' }, { model: 'from-cli' }).model, 'from-cli');
});

test('未知 provider 或显式空配置不会悄悄回退为 mock', () => {
  for (const env of [
    { CODING_AGENT_PROVIDER: 'openai' },
    { CODING_AGENT_PROVIDER: '' },
    { CODING_AGENT_MODEL: ' ' },
  ]) {
    assert.throws(() => resolveConfig(env), (error: Error) =>
      error instanceof AppError && error.code === 'INVALID_CONFIG');
  }
});
