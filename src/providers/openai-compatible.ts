import type { OpenAICompatibleConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import type { ModelProvider } from './types.ts';
import { readResponse, toWireMessage } from './wire.ts';

function httpError(status: number): AppError {
  if (status === 401 || status === 403) {
    return new AppError('AUTHENTICATION_FAILED', '模型 API 认证失败，请检查本地 API Key 和访问权限。');
  }
  if (status === 429) {
    return new AppError('RATE_LIMITED', '模型 API 请求受限，请稍后重试或检查账户额度。');
  }
  return new AppError('API_ERROR', `模型 API 返回 HTTP ${status}，请检查接口配置或服务状态。`);
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.body === null) {
    throw new AppError('INVALID_RESPONSE', '模型 API 响应正文为空。');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { break; }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AppError('INVALID_RESPONSE', '模型 API 响应超过 CODING_AGENT_MAX_RESPONSE_BYTES 限制。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AppError('INVALID_RESPONSE', '模型 API 返回的内容不是有效 JSON。');
    }
    throw error;
  }
}

/**
 * 创建非流式 Chat Completions 适配器；不重试或跟随重定向，不回显服务端错误正文。
 * @param config 已解析的模型、接口、密钥和超时配置。
 * @param transport HTTP 请求实现，默认使用 Node.js fetch。
 * @returns 实现协议转换和外部响应验证的适配器。
 */
export function createOpenAICompatibleProvider(
  config: OpenAICompatibleConfig,
  transport: typeof fetch = globalThis.fetch,
): ModelProvider {
  return {
    id: 'openai-compatible',
    async complete(request, signal) {
      signal.throwIfAborted();
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const combined = AbortSignal.any([signal, timeout]);
      try {
        const response = await transport(new URL('chat/completions', config.baseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: request.model, messages: request.messages.map(toWireMessage), stream: false,
            ...(request.tools === undefined ? {} : { tools: request.tools.map(tool => ({ type: 'function', function: tool })) }),
          }),
          signal: combined,
          redirect: 'error',
        });
        if (!response.ok) {
          // 丢弃错误正文，避免记录服务端可能回显的请求或凭据。
          await response.body?.cancel();
          throw httpError(response.status);
        }
        const value = await readJson(response, config.maxResponseBytes);
        combined.throwIfAborted();
        return readResponse(value);
      } catch (error) {
        if (signal.aborted) { throw signal.reason; }
        if (timeout.aborted) {
          throw new AppError('REQUEST_TIMEOUT', '模型 API 请求超时，可调整 CODING_AGENT_TIMEOUT_MS 后重试。');
        }
        if (error instanceof AppError) { throw error; }
        throw new AppError('NETWORK_ERROR', '无法完成模型 API 请求，请检查网络和接口地址；请求未自动重试。');
      }
    },
  };
}
