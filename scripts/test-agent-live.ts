/** 显式真实服务检查：仅向模型发送临时夹具，报告调用与 prompt token 指标。 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveConfig } from '../src/config.ts';
import { createOpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';
import { isRecord } from '../src/providers/wire.ts';
import { createReadOnlyTools } from '../src/tools/read-only.ts';
import { Conversation } from '../src/conversation.ts';
import { formatError } from '../src/errors.ts';

let directory: string | undefined;
try {
  process.loadEnvFile('.env');
  const config = resolveConfig(process.env);
  assert.equal(config.provider, 'openai-compatible');
  if (config.provider !== 'openai-compatible') { throw new Error('Real provider required'); }
  directory = await mkdtemp(join(tmpdir(), 'coding-agent-live-'));
  const marker = `AGENT_${randomBytes(8).toString('hex')}`;
  await writeFile(join(directory, 'agent-fixture.txt'), marker + '\n');
  const toolSet = await createReadOnlyTools(directory);
  const promptTokens: (number | null)[] = [];
  const transport: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (response.ok) {
      const value: unknown = await response.clone().json();
      const usage = isRecord(value) ? value['usage'] : undefined;
      promptTokens.push(isRecord(usage) && typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : null);
    }
    return response;
  };
  const provider = createOpenAICompatibleProvider(config, transport);
  const signal = AbortSignal.timeout(180000);
  const messages = [{ role: 'user' as const, content: '仅回复：收到' }];
  await provider.complete({ model: config.model, messages }, signal);
  await provider.complete({ model: config.model, messages, tools: toolSet.definitions }, signal);
  const names: string[] = [];
  const conversation = new Conversation(provider, config.model, { tools: {
    ...toolSet, async execute(call, toolSignal) { names.push(call.name); return toolSet.execute(call, toolSignal); },
  }, maxSteps: 5 });
  const response = await conversation.send('请调用 read_file 读取 agent-fixture.txt，只回复文件中的完整标记，不要猜测。', signal);
  assert.ok(names.includes('read_file'));
  assert.ok(response.text.includes(marker));
  assert.ok(conversation.messages.some(message => message.role === 'tool' && message.content.includes(marker)));
  console.log(JSON.stringify({ status: 'passed', toolCalls: names, modelRequests: promptTokens.length,
    promptTokensWithoutTools: promptTokens[0], promptTokensWithTools: promptTokens[1],
    firstTurnToolTokenDifference: promptTokens[0] == null || promptTokens[1] == null ? null : promptTokens[1] - promptTokens[0],
    turnCount: conversation.turnCount, secretsSaved: false }));
} catch (error) { process.stderr.write(`${formatError(error)}\n`); process.exitCode = 1; }
finally { if (directory !== undefined) { await rm(directory, { recursive: true, force: true }); } }
