import { AppError } from '../errors.ts';
import type { ModelProvider } from './types.ts';

/**
 * 创建不访问网络的演示适配器，返回值明确标记为模拟响应。
 * @returns 可替换为真实 API 适配器的 provider。
 */
export function createMockProvider(): ModelProvider {
  return {
    id: 'mock',
    async complete(request, signal) {
      signal.throwIfAborted();
      const message = request.messages.findLast(item => item.role === 'user');
      if (message === undefined || message.content.trim().length === 0) {
        throw new AppError('EMPTY_PROMPT', '请输入非空任务。');
      }
      return {
        text: `[模拟响应，未调用模型 API]\n已收到任务：${message.content}\n当前仅演示调用流程，尚不能读取或修改代码。`,
      };
    },
  };
}
