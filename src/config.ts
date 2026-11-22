import { AppError } from './errors.ts';

/** 已解析的运行配置；默认值在启动时确定。 */
export interface AppConfig {
  readonly provider: 'mock';
  readonly model: string;
}

/** CLI 可覆盖的配置项。 */
export interface ConfigOverrides {
  readonly provider?: string;
  readonly model?: string;
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
  const model = (overrides.model ?? env['CODING_AGENT_MODEL'] ?? 'mock-v1').trim();
  if (provider !== 'mock') {
    throw new AppError('INVALID_CONFIG', '当前仅支持 mock provider；真实 API 尚未接入。');
  }
  if (model.length === 0) {
    throw new AppError('INVALID_CONFIG', '模型名不能为空。');
  }
  return { provider, model };
}
