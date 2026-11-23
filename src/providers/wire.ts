/** Chat Completions 字段转换与外部响应校验。 */
import { AppError } from '../errors.ts';
import type { ModelMessage, ModelResponse, ToolCall } from './types.ts';

/** @param value 外部 JSON。 @returns 是否为普通对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param message 内部消息。 @returns Chat Completions 接受的消息字段。 */
export function toWireMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'tool') { return { role: 'tool', content: message.content, tool_call_id: message.toolCallId }; }
  if (message.role !== 'assistant') { return { role: message.role, content: message.content }; }
  return { role: 'assistant', content: message.content,
    ...(message.reasoningContent === undefined ? {} : { reasoning_content: message.reasoningContent }),
    ...(message.toolCalls === undefined ? {} : { tool_calls: message.toolCalls.map(call => ({
      id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
    })) }),
  };
}

/** @param value 外部 JSON。 @returns 已验证的完整文本或工具调用。 */
export function readResponse(value: unknown): ModelResponse {
  if (!isRecord(value) || !Array.isArray(value['choices'])) {
    throw new AppError('INVALID_RESPONSE', '模型 API 响应缺少 choices。');
  }
  const choice: unknown = value['choices'][0];
  const invalid = () => new AppError('INVALID_RESPONSE', '模型 API 未返回有效的完整文本或工具调用。');
  if (!isRecord(choice) || (choice['finish_reason'] !== 'stop' && choice['finish_reason'] !== 'tool_calls')) { throw invalid(); }
  const message = choice['message'];
  if (!isRecord(message) || message['role'] !== 'assistant' || message['function_call'] != null) { throw invalid(); }
  const content = message['content'];
  const reasoning = message['reasoning_content'];
  if ((content != null && typeof content !== 'string') || (reasoning != null && typeof reasoning !== 'string')) { throw invalid(); }
  const calls = message['tool_calls'];
  if (choice['finish_reason'] === 'stop') {
    if (typeof content !== 'string' || content.trim().length === 0 || (calls != null && (!Array.isArray(calls) || calls.length > 0))) { throw invalid(); }
    return { text: content, ...(typeof reasoning === 'string' ? { reasoningContent: reasoning } : {}) };
  }
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 8) { throw invalid(); }
  const ids = new Set<string>();
  const toolCalls: ToolCall[] = calls.map((item: unknown) => {
    if (!isRecord(item) || typeof item['id'] !== 'string' || item['id'].length < 1 || item['id'].length > 256
      || ids.has(item['id']) || item['type'] !== 'function' || !isRecord(item['function'])) { throw invalid(); }
    const fn = item['function'];
    if (typeof fn['name'] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(fn['name'])
      || typeof fn['arguments'] !== 'string' || fn['arguments'].length > 65536) { throw invalid(); }
    ids.add(item['id']);
    return { id: item['id'], name: fn['name'], arguments: fn['arguments'] };
  });
  return { text: content ?? '', toolCalls, ...(typeof reasoning === 'string' ? { reasoningContent: reasoning } : {}) };
}
