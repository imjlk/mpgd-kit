import { spawn, spawnSync } from 'node:child_process';

export interface ReleaseProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number | undefined;
  /** Opt in only for machine parsing; never write this unredacted stdout to logs. */
  readonly captureMachineStdout?: boolean | undefined;
  readonly secretValues?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ReleaseProcessResult {
  readonly output: string;
  readonly truncated: boolean;
  /** Present only when requested and successful; may contain secrets. */
  readonly machineStdout?: string;
}

const reasonLabels = {
  abort: 'aborted',
  exit: 'failed',
  spawn: 'could not start',
  timeout: 'timed out',
} as const;

export class ReleaseProcessError extends Error {
  readonly reason: 'abort' | 'exit' | 'spawn' | 'timeout';
  readonly output: string;
  readonly exitCode?: number;

  constructor(reason: ReleaseProcessError['reason'], output: string, exitCode?: number) {
    super(`Release process ${reasonLabels[reason]}${output === '' ? '.' : `:\n${output}`}`);
    this.name = 'ReleaseProcessError';
    this.reason = reason;
    this.output = output;
    if (exitCode !== undefined) {
      this.exitCode = exitCode;
    }
  }
}

const defaultMaxOutputBytes = 256 * 1024;
const sensitiveEnvironmentKey = /(?:^|_)(?:PASSWORD|TOKEN|SECRET|CREDENTIAL|PRIVATE_KEY|API_KEY)(?:_|$)/iu;

/** Execute a release step without streaming unredacted child output to logs. */
export async function runReleaseProcess(input: ReleaseProcessInput): Promise<ReleaseProcessResult> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new Error('Release process timeoutMs must be a positive integer.');
  }
  const outputLimit = input.maxOutputBytes ?? defaultMaxOutputBytes;
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 1) {
    throw new Error('Release process maxOutputBytes must be a positive integer.');
  }
  if (input.signal?.aborted) {
    throw new ReleaseProcessError('abort', '');
  }
  const environment = input.environment ?? process.env;
  const secrets = [
    ...(input.secretValues ?? []),
    ...Object.entries(environment)
      .filter(([key]) => sensitiveEnvironmentKey.test(key))
      .map(([, value]) => value ?? ''),
  ].filter((value) => value.length > 0);
  const launch = resolveReleaseCommand(input.command, input.args, environment);

  return new Promise<ReleaseProcessResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, [...launch.args], {
        cwd: input.cwd,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: false,
      });
    } catch {
      reject(new ReleaseProcessError('spawn', ''));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stopReason: 'abort' | 'timeout' | undefined;
    let settled = false;
    let escalation: NodeJS.Timeout | undefined;

    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const available = Math.max(0, outputLimit - capturedBytes);
      if (available > 0) {
        const selected = chunk.subarray(0, available);
        (stream === 'stdout' ? stdoutChunks : stderrChunks).push(selected);
        capturedBytes += selected.length;
      }
      if (chunk.length > available) {
        truncated = true;
        if (stream === 'stdout') {
          stdoutTruncated = true;
        } else {
          stderrTruncated = true;
        }
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk));

    const renderOutput = (): string => {
      const longestSecretBytes = secrets.reduce(
        (longest, secret) => Math.max(longest, Buffer.byteLength(secret)),
        0,
      );
      const renderStream = (chunks: readonly Buffer[], wasTruncated: boolean): string => {
        const captured = Buffer.concat(chunks);
        const safeBytes = wasTruncated
          ? captured.subarray(0, Math.max(0, captured.length - longestSecretBytes))
          : captured;
        let output = safeBytes.toString('utf8');
        for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
          output = output.replaceAll(secret, '[REDACTED]');
        }
        return output;
      };
      const output = [
        renderStream(stdoutChunks, stdoutTruncated),
        renderStream(stderrChunks, stderrTruncated),
      ].filter((part) => part !== '').join('\n');
      return truncated ? `${output}\n[output truncated]` : output;
    };
    const terminate = (reason: 'abort' | 'timeout'): void => {
      if (settled || stopReason !== undefined) {
        return;
      }
      stopReason = reason;
      killReleaseProcess(child.pid, 'SIGTERM');
      escalation = setTimeout(() => killReleaseProcess(child.pid, 'SIGKILL'), 2_000);
      escalation.unref();
    };
    const onAbort = (): void => terminate('abort');
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
    }
    const timeout = setTimeout(() => terminate('timeout'), input.timeoutMs);
    timeout.unref();

    const cleanup = (): void => {
      settled = true;
      clearTimeout(timeout);
      if (escalation !== undefined) {
        clearTimeout(escalation);
      }
      input.signal?.removeEventListener('abort', onAbort);
    };
    child.once('error', () => {
      if (settled) {
        return;
      }
      cleanup();
      reject(new ReleaseProcessError('spawn', renderOutput()));
    });
    child.once('close', (code) => {
      if (settled) {
        return;
      }
      if (stopReason !== undefined) {
        // The direct child may exit while a build tool it spawned is still alive.
        killReleaseProcess(child.pid, 'SIGKILL');
      }
      cleanup();
      const output = renderOutput();
      if (stopReason !== undefined) {
        reject(new ReleaseProcessError(stopReason, output));
      } else if (code !== 0) {
        reject(new ReleaseProcessError('exit', output, code ?? undefined));
      } else {
        resolve({
          output,
          truncated,
          ...(input.captureMachineStdout === true
            ? { machineStdout: Buffer.concat(stdoutChunks).toString('utf8') }
            : {}),
        });
      }
    });
  });
}

function resolveReleaseCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): { readonly command: string; readonly args: readonly string[] } {
  if (process.platform !== 'win32' || command !== 'pnpm') {
    return { command, args };
  }
  const pnpmScript = environment.npm_execpath;
  if (pnpmScript === undefined || !/\.[cm]?js$/iu.test(pnpmScript)) {
    throw new Error('Windows release steps require a pnpm JavaScript entrypoint. Run via pnpm.');
  }
  return { command: process.execPath, args: [pnpmScript, ...args] };
}

function killReleaseProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // The process may have exited between a timeout and termination.
  }
}
