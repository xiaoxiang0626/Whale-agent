/** 真实模型提出测试命令，人工确认入口仅运行临时夹具。 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.ts';
import { createOpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';
import { isRecord } from '../src/providers/wire.ts';
import { createCommandTools } from '../src/tools/commands.ts';
import { createEditingTools } from '../src/tools/editing.ts';
import { Conversation } from '../src/conversation.ts';
import { formatError } from '../src/errors.ts';

let root: string | undefined;
try {
  process.loadEnvFile('.env');
  const config = resolveConfig(process.env);
  if (config.provider !== 'openai-compatible') { throw new Error('Real provider required'); }
  root = await mkdtemp(join(tmpdir(), 'agent-command-live-'));
  await writeFile(join(root, 'fixture.test.cjs'), "require('node:test')('fixture',()=>require('node:assert/strict').equal(2+2,4));\n");
  const tools = await createCommandTools(root, [config.apiKey]);
  const editing = await createEditingTools(root);
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
  for (const definitions of [editing.definitions, tools.definitions]) {
    await provider.complete({ model: config.model, messages: [{ role: 'user', content: '仅回复：收到' }], tools: definitions }, signal);
  }
  let id: string | undefined;
  const conversation = new Conversation(provider, config.model, { maxSteps: 5, tools: {
    ...tools, async execute(call, toolSignal) {
      const result = await tools.execute(call, toolSignal);
      const data: unknown = JSON.parse(result.content);
      if (call.name === 'propose_command' && isRecord(data) && typeof data['id'] === 'string') { id = data['id']; }
      return result;
    },
  } });
  await conversation.send('只提出一个命令：程序 node，参数 ["--test","fixture.test.cjs"]，目录 .，超时 10000 毫秒；等待确认，不修改文件。', signal);
  assert.ok(id);
  await conversation.send(`/run ${id}`, signal);
  const message = conversation.messages.findLast(item => item.role === 'system' && item.content.startsWith('[已确认操作结果]'));
  assert.ok(message?.content.includes('"exitCode":0') && message.content.includes('fixture'));
  console.log(JSON.stringify({ status: 'passed', modelRequests: tokens.length, promptTokensEditing: tokens[0], promptTokensCommands: tokens[1],
    firstTurnTokenDifference: tokens[0] == null || tokens[1] == null ? null : tokens[1] - tokens[0], temporaryTestPassed: true, confirmed: true }));
} catch (error) { process.stderr.write(`${formatError(error)}\n`); process.exitCode = 1; }
finally { if (root !== undefined) { await rm(root, { recursive: true, force: true }); } }
