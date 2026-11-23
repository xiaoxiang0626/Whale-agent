import { AppError } from './errors.ts';

/** CLI 启动时解析的工作区和模型调用次数限制。 */
export interface AgentConfig {
  readonly workspace: string;
  readonly maxSteps: number;
  readonly maxContextChars: number;
}

/** @param env 环境变量。 @param overrides CLI 设置。 @param cwd 当前目录。 @returns 已验证的 Agent 配置。 */
export function resolveAgentConfig(env: Readonly<Record<string, string | undefined>>,
  overrides: { readonly workspace?: string; readonly maxSteps?: string; readonly maxContextChars?: string }, cwd: string): AgentConfig {
  const workspace = overrides.workspace ?? env['CODING_AGENT_WORKSPACE'] ?? cwd;
  const value = overrides.maxSteps ?? env['CODING_AGENT_MAX_STEPS'] ?? '12';
  const maxSteps = Number(value);
  if (workspace.trim().length === 0 || !/^\d+$/.test(value) || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) {
    throw new AppError('INVALID_CONFIG', '工作区不能为空，max-steps 须为 1 至 100 的整数。');
  }
  const contextValue = overrides.maxContextChars ?? env['CODING_AGENT_CONTEXT_CHARS'] ?? '48000';
  const maxContextChars = Number(contextValue);
  if (!/^\d+$/.test(contextValue) || !Number.isSafeInteger(maxContextChars) || maxContextChars < 4000 || maxContextChars > 1000000) {
    throw new AppError('INVALID_CONFIG', 'context-chars 须为 4000 至 1000000 的整数。');
  }
  return { workspace, maxSteps, maxContextChars };
}
