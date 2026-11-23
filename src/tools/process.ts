/** 执行用户已确认的前台命令；不提供进程沙箱。 */
import spawn from 'cross-spawn';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

/** 已展示给用户的具体命令。 */
export interface CommandSpec {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

/** 进程关闭后的结果；unknown 表示无法确认进程清理。 */
export interface CommandResult {
  readonly status: 'exited' | 'timeout' | 'cancelled' | 'spawn_failed' | 'unknown';
  readonly exitCode: number | null;
  readonly output: string;
  readonly truncated: boolean;
}

/** @param env 父环境，只读取执行命令所需的少量配置。 @returns 不含模型密钥和其他任意父环境变量的子环境。 */
export function commandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'appdata', 'localappdata', 'lang', 'lc_all']);
  return Object.fromEntries([...Object.entries(env).filter(([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined),
    ['CI', '1'], ['NO_COLOR', '1']]);
}

function stopTree(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
    if (systemRoot === undefined) { return Promise.resolve(false); }
    return new Promise(resolve => execFile(join(systemRoot, 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 3000 }, error => resolve(error === null)));
  }
  try { process.kill(-pid, 'SIGKILL'); return Promise.resolve(true); } catch (error) {
    return Promise.resolve(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

/**
 * 启动命令，合并输出最多保存 16 KiB；取消或超时请求终止进程树并等待关闭。
 * @param spec 已确认程序、参数、真实目录和超时。 @param signal 取消信号。
 * @param secrets 已知密钥，仅用于结果精确脱敏。 @returns 结果，启动失败不包含任意系统诊断。
 */
export async function runCommand(spec: CommandSpec, signal: AbortSignal, secrets: readonly string[] = []): Promise<CommandResult> {
  signal.throwIfAborted();
  const child = spawn(spec.program, [...spec.args], { cwd: spec.cwd, env: commandEnvironment(process.env),
    shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const captureLimit = 16384 + Math.max(0, ...secrets.map(secret => Buffer.byteLength(secret)));
    let truncated = false;
    let stopping: 'timeout' | 'cancelled' | undefined;
    let cleanup: Promise<boolean> | undefined;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: CommandResult['status'], exitCode: number | null) => {
      if (settled) { return; }
      settled = true; clearTimeout(timer); if (grace !== undefined) { clearTimeout(grace); }
      signal.removeEventListener('abort', cancel);
      child.stdout?.destroy(); child.stderr?.destroy();
      let output = status === 'spawn_failed' ? '' : Buffer.concat(chunks).toString('utf8');
      for (const secret of secrets) { if (secret.length > 0) { output = output.replaceAll(secret, '[REDACTED]'); } }
      if (Buffer.byteLength(output) > 16384) { truncated = true; output = Buffer.from(output).subarray(0, 16384).toString('utf8'); }
      resolve({ status, exitCode, output, truncated });
    };
    const stop = (reason: 'timeout' | 'cancelled') => {
      if (settled || stopping !== undefined) { return; }
      stopping = reason;
      cleanup = child.pid === undefined ? Promise.resolve(true) : stopTree(child.pid);
      grace = setTimeout(() => finish('unknown', null), 4000);
    };
    const cancel = () => { stop('cancelled'); };
    const timer = setTimeout(() => { stop('timeout'); }, spec.timeoutMs);
    const collect = (data: Buffer) => {
      const remaining = captureLimit - bytes;
      if (data.length > remaining) { truncated = true; }
      if (remaining > 0) { const part = data.subarray(0, remaining); chunks.push(part); bytes += part.length; }
    };
    child.stdout?.on('data', collect); child.stderr?.on('data', collect);
    child.once('error', () => { finish('spawn_failed', null); });
    child.once('close', (code, exitSignal) => {
      void (async () => {
        if (stopping !== undefined) { finish(await cleanup ? stopping : 'unknown', code); }
        else { finish(exitSignal === null ? 'exited' : 'unknown', code); }
      })();
    });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); }
  });
}
