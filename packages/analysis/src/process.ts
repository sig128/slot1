import { spawn } from "node:child_process";

export interface RunOptions {
  /** Hard wall-clock limit. The process is SIGKILLed when exceeded. */
  timeoutMs: number;
  /** Max bytes of stdout kept in memory (beyond that the process is killed). */
  maxStdoutBytes?: number;
  /** Keep only the last N bytes of stderr (ffmpeg is chatty). */
  stderrTailBytes?: number;
  /** Stream stderr lines as they arrive. */
  onStderrLine?: (line: string) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderrTail: string;
  timedOut: boolean;
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
  }
}

/**
 * Spawn a binary with an argument ARRAY (never a shell string), a timeout and output caps.
 * User-supplied text must never be interpolated into a shell; this function never uses one.
 */
export function runProcess(command: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", HOME: process.env.HOME ?? "/tmp" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const maxOut = opts.maxStdoutBytes ?? 16 * 1024 * 1024;
    const tailBytes = opts.stderrTailBytes ?? 16 * 1024;
    const outChunks: Buffer[] = [];
    let outBytes = 0;
    let stderrTail = "";
    let lineBuf = "";
    let timedOut = false;
    let killedForOutput = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxOut) {
        killedForOutput = true;
        child.kill("SIGKILL");
        return;
      }
      outChunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-tailBytes);
      if (opts.onStderrLine) {
        lineBuf += chunk;
        let idx: number;
        while ((idx = lineBuf.search(/[\r\n]/)) >= 0) {
          const line = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          if (line) opts.onStderrLine(line);
        }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.onStderrLine && lineBuf) opts.onStderrLine(lineBuf);
      const result: RunResult = { code, signal, stdout: Buffer.concat(outChunks), stderrTail, timedOut };
      if (killedForOutput) return reject(new ProcessError(`${command} exceeded the output limit`, result));
      resolve(result);
    });
  });
}

export async function runChecked(command: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  const res = await runProcess(command, args, opts);
  if (res.timedOut) throw new ProcessError(`${command} timed out after ${Math.round(opts.timeoutMs / 1000)}s`, res);
  if (res.code !== 0) {
    const lastLine = res.stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
    throw new ProcessError(`${command} exited with code ${res.code}: ${lastLine.slice(0, 300)}`, res);
  }
  return res;
}
