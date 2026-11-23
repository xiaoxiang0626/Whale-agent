/** 只修改临时夹具的真实 API 检查；不保存密钥、响应全文和推理内容。 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.ts';
import { createOpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';
import { isRecord } from '../src/providers/wire.ts';
import { createEditingTools } from '../src/tools/editing.ts';
import { createReadOnlyTools } from '../src/tools/read-only.ts';
import { Conversation } from '../src/conversation.ts';
import { formatError } from '../src/errors.ts';

let root: string | undefined;
try {
  process.loadEnvFile('.env');
  const config = resolveConfig(process.env);
  if (config.provider !== 'openai-compatible') { throw new Error('Real provider required'); }
  root = await mkdtemp(join(tmpdir(), 'agent-edit-live-'));
  await writeFile(join(root, 'fixture.txt'), 'before\n');
  const tools = await createEditingTools(root);
  const readonly = await createReadOnlyTools(root);
  const tokens: (number | null)[] = [];
  const provider = createOpenAICompatibleProvider(config, async (input, init) => {
    const response = await fetch(input, init);
    if (response.ok) {
      const value: unknown = await response.clone().json();
      const usage = isRecord(value) ? value['usage'] : undefined;
      tokens.push(isRecord(usage) && typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : null);
    }
    return response;
  });
  const signal = AbortSignal.timeout(180000);
  for (const definitions of [readonly.definitions, tools.definitions]) {
    await provider.complete({ model: config.model, messages: [{ role: 'user', content: '仅回复：收到' }], tools: definitions }, signal);
  }
  let proposalId: string | undefined;
  const calls: string[] = [];
  const conversation = new Conversation(provider, config.model, { maxSteps: 6, tools: {
    ...tools, async execute(call, toolSignal) {
      calls.push(call.name);
      const result = await tools.execute(call, toolSignal);
      const data: unknown = JSON.parse(result.content);
      if (isRecord(data) && data['status'] === 'pending_approval' && typeof data['id'] === 'string') { proposalId = data['id']; }
      return result;
    },
  } });
  await conversation.send('读取 fixture.txt，把完整内容修改为 after 后换行。调用 propose_file 提出修改，等待我确认。', signal);
  assert.ok(calls.includes('read_file') && calls.includes('propose_file'));
  assert.equal(await readFile(join(root, 'fixture.txt'), 'utf8'), 'before\n');
  assert.ok(proposalId);
  await conversation.send(`/apply ${proposalId}`, signal);
  assert.equal(await readFile(join(root, 'fixture.txt'), 'utf8'), 'after\n');
  assert.ok(conversation.messages.some(message => message.role === 'system' && message.content.includes('"status":"applied"')));
  console.log(JSON.stringify({ status: 'passed', toolCalls: calls, modelRequests: tokens.length,
    promptTokensReadOnly: tokens[0], promptTokensEditing: tokens[1],
    firstTurnTokenDifference: tokens[0] == null || tokens[1] == null ? null : tokens[1] - tokens[0],
    wroteOnlyTemporaryFixture: true, explicitConfirmation: true }));
} catch (error) { process.stderr.write(`${formatError(error)}\n`); process.exitCode = 1; }
finally { if (root !== undefined) { await rm(root, { recursive: true, force: true }); } }
