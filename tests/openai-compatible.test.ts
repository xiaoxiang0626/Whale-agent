import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveConfig } from '../src/config.ts';
import type { OpenAICompatibleConfig } from '../src/config.ts';
import { AppError } from '../src/errors.ts';
import { createProvider } from '../src/providers/index.ts';
import { createOpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';

const config: OpenAICompatibleConfig = {
  provider: 'openai-compatible', baseUrl: 'https://api.example/v1/',
  model: 'my-model', apiKey: 'test-secret-key', timeoutMs: 30_000, maxResponseBytes: 1_048_576,
};
const request = { model: 'my-model', messages: [{ role: 'user' as const, content: '测试任务' }] };
const result = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '模型回复' } }] };

test('适配器按配置请求完整路径，携带认证、模型、消息并关闭流式与重定向', async () => {
  let calls = 0;
  const transport: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.example/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-secret-key');
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init?.body)), { ...request, stream: false });
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json(result);
  };
  assert.deepEqual(await createOpenAICompatibleProvider(config, transport).complete(request, new AbortController().signal),
    { text: '模型回复' });
  assert.equal(calls, 1);
  assert.equal(createProvider(resolveConfig({})).id, 'mock');
  assert.equal(createProvider(config).id, 'openai-compatible');
});

test('认证、限流与服务错误提供固定诊断，不回显错误正文或自动重试', async () => {
  for (const [status, code] of [[401, 'AUTHENTICATION_FAILED'], [403, 'AUTHENTICATION_FAILED'],
    [429, 'RATE_LIMITED'], [500, 'API_ERROR']] as const) {
    let calls = 0;
    const transport: typeof fetch = async () => {
      calls++;
      return new Response('test-secret-key / private request', { status });
    };
    await assert.rejects(createOpenAICompatibleProvider(config, transport).complete(request, new AbortController().signal),
      (error: Error) => {
        assert.doesNotMatch(error.message, /test-secret-key|private request/);
        return error instanceof AppError && error.code === code;
      });
    assert.equal(calls, 1);
  }
});

test('畸形 JSON、空响应、不完整输出和工具调用不会被当成完整文本', async () => {
  const invalidBodies = ['<html>server error</html>', 'null', '{}', '{"choices":[]}',
    JSON.stringify({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'partial' } }] }),
    JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }] }),
    JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'user', content: 'wrong role' } }] }),
    JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null } }] }),
    JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'text', tool_calls: [{}] } }] }),
  ];
  for (const body of invalidBodies) {
    const transport: typeof fetch = async () => new Response(body);
    await assert.rejects(createOpenAICompatibleProvider(config, transport).complete(request, new AbortController().signal),
      (error: Error) => error instanceof AppError && error.code === 'INVALID_RESPONSE');
  }
});

test('已取消请求不会访问传输层，网络异常不暴露底层诊断', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error('test-secret-key'); };
  const provider = createOpenAICompatibleProvider(config, transport);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.complete(request, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
  await assert.rejects(provider.complete(request, new AbortController().signal), (error: Error) => {
    assert.doesNotMatch(error.message, /test-secret-key/);
    return error instanceof AppError && error.code === 'NETWORK_ERROR';
  });
});

test('响应超过配置的字节上限时终止读取', async () => {
  const transport: typeof fetch = async () => new Response('x'.repeat(101));
  await assert.rejects(createOpenAICompatibleProvider({ ...config, maxResponseBytes: 100 }, transport)
    .complete(request, new AbortController().signal),
  (error: Error) => error instanceof AppError && error.code === 'INVALID_RESPONSE');
});

test('真实 HTTP 传输可完成调用，等待响应正文时支持超时和用户取消', { timeout: 10_000 }, async t => {
  const server = createServer((_req, res) => {
    if (_req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
    }
  });
  t.after(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const localConfig = { ...config, baseUrl: `http://127.0.0.1:${address.port}/v1/` };
  assert.deepEqual(await createOpenAICompatibleProvider(localConfig).complete(request, new AbortController().signal),
    { text: '模型回复' });
  const cli = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../src/cli.ts', import.meta.url)), '--provider', 'openai-compatible',
    '--base-url', localConfig.baseUrl, '--model', 'my-model', '测试任务',
  ], {
    timeout: 5000,
    env: { ...process.env, CODING_AGENT_API_KEY: 'test-secret-key', CODING_AGENT_TIMEOUT_MS: '3000',
      CODING_AGENT_MAX_RESPONSE_BYTES: '1048576' },
  });
  assert.equal(cli.stdout, '模型回复\n');
  assert.equal(cli.stderr, '');
  const stalled = { ...localConfig, baseUrl: `http://127.0.0.1:${address.port}/stalled/`, timeoutMs: 50 };
  await assert.rejects(createOpenAICompatibleProvider(stalled).complete(request, new AbortController().signal),
    (error: Error) => error instanceof AppError && error.code === 'REQUEST_TIMEOUT');
  const controller = new AbortController();
  const requested = once(server, 'request');
  const pending = createOpenAICompatibleProvider({ ...stalled, timeoutMs: 5000 }).complete(request, controller.signal);
  await requested;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
