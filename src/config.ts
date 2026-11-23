import { AppError } from './errors.ts';

/** 已解析的运行配置；默认值在启动时确定。 */
export interface MockConfig {
  readonly provider: 'mock';
  readonly model: string;
}

/** 已验证的 OpenAI 兼容接口配置；密钥不得写入日志。 */
export interface OpenAICompatibleConfig {
  readonly provider: 'openai-compatible';
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

/** 启动时确定的适配器配置。 */
export type AppConfig = MockConfig | OpenAICompatibleConfig;

/** CLI 可覆盖的配置项。 */
export interface ConfigOverrides {
  readonly provider?: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new AppError('INVALID_CONFIG', `请配置 ${name}。`);
  }
  return value.trim();
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
    throw new AppError('INVALID_CONFIG', `${name} 须为 1 至 2147483647 的整数。`);
  }
  return number;
}

/**
 * 按 CLI、环境变量、默认值的顺序解析配置；空值和未知 provider 会失败。
 * @param env 环境变量；显式传入便于隔离测试。
 * @param overrides CLI 参数。
 * @returns 可直接用于本次任务的配置。
 */
export function resolveConfig(
  env: Readonly<Record<string, string | undefined>>,
  overrides: ConfigOverrides = {},
): AppConfig {
  const provider = (overrides.provider ?? env['CODING_AGENT_PROVIDER'] ?? 'mock').trim();
  if (provider === 'mock') {
    const model = requireValue(overrides.model ?? env['CODING_AGENT_MODEL'] ?? 'mock-v1', '模型名');
    return { provider, model };
  }
  if (provider !== 'openai-compatible') {
    throw new AppError('INVALID_CONFIG', '适配器必须为 mock 或 openai-compatible。');
  }
  const model = requireValue(overrides.model ?? env['CODING_AGENT_MODEL'], 'CODING_AGENT_MODEL');
  const baseUrl = requireValue(overrides.baseUrl ?? env['CODING_AGENT_BASE_URL'], 'CODING_AGENT_BASE_URL');
  let url: URL;
  try { url = new URL(baseUrl); } catch (error) {
    // 地址解析失败时使用固定提示，避免回显地址中的凭据。
    if (error instanceof TypeError) {
      throw new AppError('INVALID_CONFIG', '模型 API 地址必须是有效的 HTTP 或 HTTPS 地址。');
    }
    throw error;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AppError('INVALID_CONFIG', '模型 API 地址须使用 HTTP 或 HTTPS，且不能包含凭据、查询参数或片段。');
  }
  if (/[\r\n]/.test(env['CODING_AGENT_API_KEY'] ?? '')) {
    throw new AppError('INVALID_CONFIG', 'API Key 不能包含换行。');
  }
  const apiKey = requireValue(env['CODING_AGENT_API_KEY'], 'CODING_AGENT_API_KEY');
  const timeoutMs = positiveInteger(env['CODING_AGENT_TIMEOUT_MS'] ?? '30000', 'CODING_AGENT_TIMEOUT_MS');
  const maxResponseBytes = positiveInteger(env['CODING_AGENT_MAX_RESPONSE_BYTES'] ?? '1048576', 'CODING_AGENT_MAX_RESPONSE_BYTES');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return { provider, model, baseUrl: url.href, apiKey, timeoutMs, maxResponseBytes };
}
