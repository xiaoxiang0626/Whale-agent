import type { AppConfig } from '../config.ts';
import { createMockProvider } from './mock.ts';
import { createOpenAICompatibleProvider } from './openai-compatible.ts';
import type { ModelProvider } from './types.ts';

/**
 * 按已解析的配置创建适配器。
 * @param config 具体运行配置。
 * @returns 对应的模型适配器。
 */
export function createProvider(config: AppConfig): ModelProvider {
  switch (config.provider) {
    case 'mock': return createMockProvider();
    case 'openai-compatible': return createOpenAICompatibleProvider(config);
  }
}
