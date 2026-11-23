/** 命令提案与一次性用户确认。 */
import { createEditingTools } from './editing.ts';
import { Workspace, FileToolError } from './workspace.ts';
import { runCommand } from './process.ts';
import type { CommandSpec } from './process.ts';
import type { ToolResult, ToolSet } from './types.ts';
import { isRecord } from '../providers/wire.ts';
import { relative } from 'node:path';

function failure(code: string, message: string): ToolResult {
  return { ok: false, content: JSON.stringify({ ok: false, error: { code, message } }), summary: `${code}：${message}` };
}

/** @param directory 已授权工作区。 @param secrets 已知密钥，用于精确脱敏。 @returns 文件工具及待确认命令，不会因模型调用直接启动进程。 */
export async function createCommandTools(directory: string, secrets: readonly string[] = []): Promise<ToolSet> {
  const base = await createEditingTools(directory);
  const workspace = await Workspace.create(directory);
  const pending = new Map<string, CommandSpec>();
  let sequence = 0;
  let uncertain = false;
  return { ...base,
    context: `${base.context} 命令须使用 propose_command 提案，等待用户 /run 编号。命令运行在用户账户中，不是沙箱；优先使用项目测试脚本，禁止后台任务。只根据实际退出码与输出判断测试结果。`,
    definitions: [...base.definitions, { name: 'propose_command', description: '提出前台命令，展示参数、目录和超时，等待用户确认；此调用不会执行。',
      parameters: { type: 'object', properties: {
        program: { type: 'string', description: '可执行程序名或路径，如 node、pnpm；不会自动把整段命令拆成参数。' },
        args: { type: 'array', items: { type: 'string' }, maxItems: 64, description: '逐项参数；管道和重定向不会由 Agent 自动解释。' },
        cwd: { type: 'string', description: '已存在的工作区相对目录，根目录填 .。' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, description: '运行时间上限，毫秒。' },
      }, required: ['program', 'args', 'cwd', 'timeout_ms'], additionalProperties: false } }],
    clearPending() { pending.clear(); base.clearPending?.(); },
    async execute(call, signal) {
      if (uncertain && (call.name === 'propose_file' || call.name === 'propose_command')) { return failure('COMMAND_BLOCKED', '上次进程结果未知，请检查并关闭残留进程后重启会话。'); }
      if (call.name !== 'propose_command') { return base.execute(call, signal); }
      signal.throwIfAborted();
      if (uncertain) { return failure('COMMAND_BLOCKED', '上次进程结果未知，请检查并关闭残留进程后重启会话。'); }
      try {
        const args: unknown = JSON.parse(call.arguments);
        if (!isRecord(args) || typeof args['program'] !== 'string' || args['program'].trim().length === 0
          || /[\u0000-\u001f]/.test(args['program']) || !Array.isArray(args['args']) || args['args'].length > 64
          || !args['args'].every((item: unknown) => typeof item === 'string' && !item.includes('\0'))
          || typeof args['cwd'] !== 'string' || !Number.isInteger(args['timeout_ms']) || typeof args['timeout_ms'] !== 'number'
          || args['timeout_ms'] < 100 || args['timeout_ms'] > 120000
          || Object.keys(args).some(key => !['program', 'args', 'cwd', 'timeout_ms'].includes(key))
          || Buffer.byteLength(call.arguments) > 16384) {
          return failure('INVALID_ARGUMENTS', '命令须包含有效 program、args、cwd 和 100–120000 毫秒 timeout_ms。');
        }
        const values = [args['program'], args['cwd'], ...args['args'] as string[]];
        if (secrets.some(secret => secret.length > 0 && values.some(value => value.includes(secret)))) {
          return failure('INVALID_ARGUMENTS', '命令参数不得包含模型 API Key。');
        }
        if (pending.size >= 10) { return failure('PROPOSAL_LIMIT', '待确认命令已达 10 项，请先运行或拒绝。'); }
        const target = await workspace.existing(args['cwd'], signal);
        if (!target.stat.isDirectory()) { return failure('NOT_DIRECTORY', '命令目录须为工作区内普通目录。'); }
        const spec = { program: args['program'], args: args['args'] as string[], cwd: target.path, timeoutMs: args['timeout_ms'] };
        const id = `command-${++sequence}`;
        pending.set(id, spec);
        return { ok: true, content: JSON.stringify({ ok: true, status: 'pending_approval', id }), summary: `待确认 ${id}`,
          preview: `程序：${JSON.stringify(spec.program)}\n参数：${JSON.stringify(spec.args)}\n目录：${spec.cwd}\n超时：${spec.timeoutMs} ms\n/run ${id} 执行 · /reject ${id} 拒绝` };
      } catch (error) {
        signal.throwIfAborted();
        return failure(error instanceof FileToolError ? error.code : 'INVALID_ARGUMENTS', '无法提出命令，请检查参数、目录和权限。');
      }
    },
    async action(command, id, signal) {
      if (uncertain && command !== 'reject') { return failure('COMMAND_BLOCKED', '上次进程结果未知，禁止继续执行。'); }
      if (!id.startsWith('command-')) { return base.action?.(command, id, signal) ?? failure('UNKNOWN_PROPOSAL', '编号不存在。'); }
      const spec = pending.get(id);
      if (spec === undefined) { return failure('UNKNOWN_PROPOSAL', '命令编号不存在或已经处理。'); }
      if (command === 'apply') { return failure('INVALID_ACTION', '命令请使用 /run 编号 确认。'); }
      pending.delete(id);
      if (command === 'reject') { return { ok: true, content: JSON.stringify({ ok: true, status: 'rejected', id }), summary: `已拒绝 ${id}` }; }
      if (uncertain) { return failure('COMMAND_BLOCKED', '上次进程结果未知，禁止继续执行。'); }
      try {
        const target = await workspace.existing(relative(workspace.root, spec.cwd) || '.', signal);
        if (!target.stat.isDirectory() || target.path !== spec.cwd) { return failure('PATH_DENIED', '工作目录已变化，请重新提案。'); }
        const result = await runCommand(spec, signal, secrets);
        uncertain = result.status === 'unknown';
        const ok = result.status === 'exited' && result.exitCode === 0;
        return { ok, content: JSON.stringify({ ok, id, command: spec, ...result }), continueModel: result.status === 'exited' || result.status === 'timeout',
          summary: `${id}：${result.status}，退出码 ${result.exitCode ?? '未知'}${result.truncated ? '，输出已截断' : ''}`,
          preview: result.output };
      } catch (error) {
        return failure(error instanceof FileToolError ? error.code : signal.aborted ? 'CANCELLED' : 'COMMAND_FAILED', '命令未能启动，请检查目录、程序与取消状态。');
      }
    },
  };
}
