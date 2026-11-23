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
      const last = request.messages.at(-1);
      if (last?.role === 'tool') {
        return { text: `[模拟响应，未调用模型 API]\n工具返回：${last.content}` };
      }
      const message = request.messages.findLast(item => item.role === 'user');
      if (message === undefined || message.content.trim().length === 0) {
        throw new AppError('EMPTY_PROMPT', '请输入非空任务。');
      }
      const demo = /^演示(读取|列出) (.+)$/.exec(message.content.trim());
      if (demo !== null && request.tools !== undefined) {
        return { text: '', toolCalls: [{ id: 'mock-tool-call', name: demo[1] === '读取' ? 'read_file' : 'list_files', arguments: JSON.stringify({ path: demo[2] }) }] };
      }
      return {
        text: `[模拟响应，未调用模型 API]\n已收到任务：${message.content}\n当前为离线演示；可用“演示读取 文件路径”检查文件工具。`,
      };
    },
  };
}
