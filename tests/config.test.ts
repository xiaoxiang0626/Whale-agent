import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConfig } from '../src/config.ts';
import { AppError } from '../src/errors.ts';
import { resolveAgentConfig } from '../src/agent-config.ts';

test('工作区与循环限制有明确默认值，CLI 可覆盖环境，非法限制在启动时失败', () => {
  assert.deepEqual(resolveAgentConfig({}, {}, 'cwd'), { workspace: 'cwd', maxSteps: 12, maxContextChars: 48000 });
  assert.deepEqual(resolveAgentConfig({ CODING_AGENT_WORKSPACE: 'env', CODING_AGENT_MAX_STEPS: '3' }, { workspace: 'cli', maxSteps: '4' }, 'cwd'),
    { workspace: 'cli', maxSteps: 4, maxContextChars: 48000 });
  for (const value of ['', '0', '101', '-1', '1.5']) {
    assert.throws(() => resolveAgentConfig({}, { maxSteps: value }, 'cwd'), /max-steps/);
  }
  assert.equal(resolveAgentConfig({ CODING_AGENT_CONTEXT_CHARS: '8000' }, { maxContextChars: '6000' }, 'cwd').maxContextChars, 6000);
  for (const value of ['0', '3999', '1000001', 'NaN']) { assert.throws(() => resolveAgentConfig({}, { maxContextChars: value }, 'cwd'), /context-chars/); }
});

test('默认运行离线适配器，CLI 配置优先于环境变量', () => {
  assert.deepEqual(resolveConfig({}), { provider: 'mock', model: 'mock-v1' });
  assert.equal(resolveConfig({ CODING_AGENT_MODEL: 'from-env' }).model, 'from-env');
  assert.equal(resolveConfig({ CODING_AGENT_MODEL: 'from-env' }, { model: 'from-cli' }).model, 'from-cli');
});

const apiEnv = {
  CODING_AGENT_PROVIDER: 'openai-compatible',
  CODING_AGENT_MODEL: 'my-model',
  CODING_AGENT_BASE_URL: 'https://api.example/v1',
  CODING_AGENT_API_KEY: 'test-key',
};

test('真实接口要求显式模型、地址和密钥，并保留基础地址中的路径', () => {
  assert.deepEqual(resolveConfig(apiEnv), {
    provider: 'openai-compatible', model: 'my-model', baseUrl: 'https://api.example/v1/',
    apiKey: 'test-key', timeoutMs: 30_000, maxResponseBytes: 1_048_576,
  });
  const overridden = resolveConfig(apiEnv, { baseUrl: 'http://localhost:1234/custom///', model: 'override' });
  assert.equal(overridden.model, 'override');
  assert.ok(overridden.provider === 'openai-compatible');
  assert.equal(overridden.baseUrl, 'http://localhost:1234/custom/');
  for (const name of ['CODING_AGENT_MODEL', 'CODING_AGENT_BASE_URL', 'CODING_AGENT_API_KEY']) {
    assert.throws(() => resolveConfig({ ...apiEnv, [name]: '' }),
      (error: Error) => error instanceof AppError && error.code === 'INVALID_CONFIG');
  }
});

test('无效地址、超时与包含换行的密钥会被拒绝，错误不包含配置值', () => {
  for (const invalid of [
    { CODING_AGENT_BASE_URL: 'not-a-url-secret' },
    { CODING_AGENT_BASE_URL: 'ftp://api.example' },
    { CODING_AGENT_BASE_URL: 'https://user:password@api.example' },
    { CODING_AGENT_BASE_URL: 'https://api.example?key=test-key' },
    { CODING_AGENT_BASE_URL: 'https://api.example#fragment' },
    { CODING_AGENT_API_KEY: 'test-key\nInjected: header' },
    { CODING_AGENT_API_KEY: 'test-key\n' },
    { CODING_AGENT_TIMEOUT_MS: '' }, { CODING_AGENT_TIMEOUT_MS: '0' },
    { CODING_AGENT_TIMEOUT_MS: '1.5' }, { CODING_AGENT_TIMEOUT_MS: 'Infinity' },
    { CODING_AGENT_TIMEOUT_MS: '2147483648' },
    { CODING_AGENT_MAX_RESPONSE_BYTES: '0' },
  ]) {
    assert.throws(() => resolveConfig({ ...apiEnv, ...invalid }), (error: Error) => {
      assert.doesNotMatch(error.message, /test-key|password|not-a-url-secret/);
      return error instanceof AppError && error.code === 'INVALID_CONFIG';
    });
  }
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
