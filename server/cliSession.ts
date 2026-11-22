import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LLM_SERVER_TIMEOUT_MS } from '../src/ai/Limits';
import { MAX_ANSWER_CHARS, MAX_DETAIL, withoutThinking } from './chatSession';
import {
  FLAGS_REFUSED,
  locate,
  oneLine,
  passedOnEnv,
  withoutAnsi,
  type CliConfig,
  type CliTool,
} from './cliTools';
import {
  LlmError,
  SESSION_CLOSED,
  sessionClosed,
  type Answer,
  type LlmSession,
} from './llmSession';

// A model "cli:<name>" (cliTools.ts): a command of the server's own settings answers each report.
// Stateless: every request starts the command once with the rulebook, the last `historyTurns`
// reports and answers and the new report as one plain-text prompt on stdin, and its whole output
// is the answer. One request at a time; closing the session stops a running process (with every
// process it started) and removes the session's folder. `runProcess` starts such a program for one
// report (the Codex CLI too, codexSession.ts).

// The most of a tool's output that is read: an answer is at most MAX_ANSWER_CHARS of text; more is
// a tool that ran on, and it is stopped
const MAX_STDOUT_BYTES = 4_000_000;
// The end of the tool's error output that is kept (its messages come last)
const MAX_STDERR_CHARS = 64_000;
// After SIGTERM, how long the tool's processes have before SIGKILL
const KILL_GRACE_MS = 1500;

export const CLOSING = 'Answer the new report.';

// The prompt: the rulebook, the earlier reports and answers, oldest first, and the new report,
// with plain headings between them
export function cliPrompt(
  rulebook: string,
  turns: ReadonlyArray<readonly [string, string]>,
  report: string
): string {
  const parts: string[] = ['=== RULES ===', rulebook, ''];
  if (turns.length > 0) {
    parts.push(
      `=== EARLIER REPORTS AND YOUR ANSWERS (the last ${turns.length}, oldest first) ===`,
      ''
    );
    turns.forEach(([r, a], i) =>
      parts.push(
        `=== EARLIER REPORT ${i + 1} ===`,
        r,
        '',
        `=== YOUR ANSWER TO EARLIER REPORT ${i + 1} ===`,
        a,
        ''
      )
    );
  }
  parts.push('=== NEW REPORT ===', report, '', CLOSING);
  return parts.join('\n') + '\n';
}

const WINDOWS = process.platform === 'win32';

// The tool's process and every process it started: it is started as the leader of a process
// group of its own (on Windows: its process tree)
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (WINDOWS) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // the group has ended
  }
}

export function stopTree(child: ChildProcess): void {
  signalTree(child, 'SIGTERM');
  setTimeout(() => signalTree(child, 'SIGKILL'), KILL_GRACE_MS);
}

export interface Run {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  overflow: boolean; // more than MAX_STDOUT_BYTES: stopped
  timedOut: boolean; // stopped after timeoutMs
  spawnError: string | null; // the process could not be started (ENOENT, EACCES, …)
}

// A program started for one report (a command of the settings, the Codex CLI): its executable
// and arguments (never through a shell), environment, working folder, what goes on its stdin
export interface ProcessSpec {
  exe: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  input: string;
  timeoutMs: number;
}

// One run: started without a shell as the leader of a process group of its own, the input written
// to its stdin, its output read up to the limits, stopped (with every process it started) after
// timeoutMs; `started` gets the process so its owner can stop it (stopTree) on close
export function runProcess(
  spec: ProcessSpec,
  started: (child: ChildProcess | null) => void = () => undefined
): Promise<Run> {
  return new Promise((resolve) => {
    const out: Run = {
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      overflow: false,
      timedOut: false,
      spawnError: null,
    };
    let child: ChildProcess;
    try {
      child = spawn(spec.exe, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !WINDOWS, // the leader of its own process group, so the whole group can be stopped
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      out.spawnError = String((err as { code?: unknown }).code ?? 'error');
      return resolve(out);
    }
    started(child);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      started(null);
      out.stdout = Buffer.concat(chunks).toString('utf8');
      resolve(out);
    };
    const timer = setTimeout(() => {
      out.timedOut = true;
      stopTree(child);
    }, spec.timeoutMs);
    child.stdout!.on('data', (data: Buffer) => {
      if (out.overflow) return;
      bytes += data.length;
      if (bytes > MAX_STDOUT_BYTES) {
        out.overflow = true;
        stopTree(child);
      } else chunks.push(data);
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (text: string) => {
      out.stderr = (out.stderr + text).slice(-MAX_STDERR_CHARS);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      out.spawnError = err.code ?? 'error';
      finish();
    });
    child.on('exit', (code, signal) => {
      out.code = code;
      out.signal = signal;
      // Anything the program left running in its group ends with it
      if (!WINDOWS) signalTree(child, 'SIGKILL');
    });
    child.on('close', finish);
    child.stdin!.on('error', () => undefined); // a program that exits before reading all of it
    child.stdin!.end(spec.input);
  });
}

// The end of a failed program's output, where its last words are (stderr, else stdout), at most
// MAX_DETAIL characters
export function lastWords(out: Run): string {
  const text = oneLine(out.stderr.trim() ? out.stderr : out.stdout);
  return text.length > MAX_DETAIL ? `…${text.slice(-MAX_DETAIL)}` : text;
}

export class CliSession implements LlmSession {
  private turns: Array<[report: string, answer: string]> = [];
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private dir: string | null = null; // the session's folder: dir/work is the tool's working folder
  private running: ChildProcess | null = null;

  constructor(
    readonly matchId: string,
    readonly model: string, // "cli:<name>"
    private readonly rulebook: string,
    private readonly tool: CliTool,
    private readonly config: CliConfig,
    private readonly side = '',
    private readonly timeoutMs = LLM_SERVER_TIMEOUT_MS
  ) {
    const turns = config.historyTurns;
    console.warn(
      `[llm] ${side} session started: ${model} (a process per report, last ${turns} turn${turns === 1 ? '' : 's'})`
    );
  }

  isAlive(): boolean {
    return !this.closed;
  }

  ask(prompt: string): Promise<Answer> {
    const answer = this.queue.then(() => this.request(prompt));
    this.queue = answer.catch(() => undefined);
    return answer;
  }

  // The session's folder, made at the first request: the tool works in its empty "work" folder
  private folder(): string {
    if (this.dir) return this.dir;
    const dir = mkdtempSync(join(tmpdir(), 'battle-cli-'));
    mkdirSync(join(dir, 'work'));
    this.dir = dir;
    return dir;
  }

  private removeFolder(): void {
    if (!this.dir) return;
    try {
      rmSync(this.dir, { recursive: true, force: true });
      this.dir = null;
    } catch {
      // Windows: still the working folder of a process that is ending; tried again after it
    }
  }

  private async request(prompt: string): Promise<Answer> {
    const { tool, config } = this;
    const label = tool.label;
    const NAME = tool.name.toUpperCase();
    if (this.closed) throw sessionClosed();
    // Never the executable's path (the page shows these messages)
    const notFound = `${label}: the command of CLI_TOOL_${NAME} was not found on this computer. Install it or fix the setting, then start the match again.`;
    const notRunnable = `${label}: the command of CLI_TOOL_${NAME} is not a file this user may run. Fix it and start the match again.`;
    const exe = locate(tool.argv[0], tool.path, config.pathEnv);
    if (typeof exe !== 'string')
      throw new LlmError(exe.problem === 'missing' ? notFound : notRunnable, false, true);
    const work = join(this.folder(), 'work');
    const input = cliPrompt(this.rulebook, this.turns, prompt);
    const started = Date.now();
    const out = await runProcess(
      {
        exe,
        args: tool.argv.slice(1),
        env: passedOnEnv(config.vars, config.pathEnv),
        cwd: work,
        input,
        timeoutMs: this.timeoutMs,
      },
      (child) => (this.running = child)
    );
    const ms = Date.now() - started;
    if (this.closed) this.removeFolder();
    console.warn(
      `[llm] ${this.side} (${this.model}): ${exe} ran ${(ms / 1000).toFixed(1)} s, start-up included (${out.spawnError ? `not started: ${out.spawnError}` : out.signal ? `ended by ${out.signal}` : `exit ${out.code}`})`
    );

    if (out.spawnError === 'ENOENT') throw new LlmError(notFound, false, true);
    if (out.spawnError === 'EACCES') throw new LlmError(notRunnable, false, true);
    if (out.spawnError)
      throw new LlmError(`${label} could not be started (${out.spawnError}).`, true, true);
    if (this.closed) throw new LlmError(SESSION_CLOSED, true, true);
    // Not from a result: the endpoint closes the session (a fresh one next time)
    if (out.timedOut)
      throw new LlmError(
        `${label} did not answer within ${Math.round(this.timeoutMs / 1000)} s; its process was stopped.`,
        true
      );
    if (out.overflow)
      throw new LlmError(
        `${label} wrote more than ${MAX_STDOUT_BYTES / 1_000_000} MB of output; its process was stopped.`,
        true,
        true
      );
    if (out.code !== 0 || out.signal !== null) {
      // The end of its output, where a program's last words are
      const detail = lastWords(out) || (out.signal ? `ended by ${out.signal}` : `exit ${out.code}`);
      if (FLAGS_REFUSED.test(detail))
        throw new LlmError(
          `${label} did not accept its command line (CLI_TOOL_${NAME}): ${detail}`,
          false,
          true
        );
      throw new LlmError(
        `${label} failed (${out.signal ? `ended by ${out.signal}` : `exit ${out.code}`}): ${detail}`,
        true,
        true
      );
    }
    // An empty or oversized answer is an error, never a 200: the browser would read it as no
    // orders and go on, while failures are counted and three in a row stop the layer
    const text = withoutThinking(withoutAnsi(out.stdout));
    if (!text.trim()) throw new LlmError(`${label}: the answer was empty.`, true, true);
    if (text.length > MAX_ANSWER_CHARS)
      throw new LlmError(
        `${label}: the answer was ${Math.round(text.length / 1000)} KB of text, more than the ${MAX_ANSWER_CHARS / 1000} KB an answer may have.`,
        true,
        true
      );
    this.turns.push([prompt, text]);
    if (this.turns.length > config.historyTurns) this.turns.shift();
    return {
      text,
      meta: {
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        apiMs: null,
        turns: 1,
        modelIds: [],
      },
    };
  }

  // Replaced by a new match or model, or the server is closing: a running tool is stopped and the
  // session's folder removed; a request still waiting fails with "session was closed"
  close(): void {
    this.closed = true;
    if (this.running) stopTree(this.running);
    this.removeFolder();
  }
}
