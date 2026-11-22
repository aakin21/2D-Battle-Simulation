import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LLM_SERVER_TIMEOUT_MS } from '../src/ai/Limits';
import { MAX_ANSWER_CHARS, capped, keyProblem, withoutThinking } from './chatSession';
import { FLAGS_REFUSED, locate, oneLine, passedOnEnv } from './cliTools';
import { lastWords, runProcess, stopTree, type Run } from './cliSession';
import {
  LlmError,
  SESSION_CLOSED,
  num,
  sessionClosed,
  type Answer,
  type LlmSession,
} from './llmSession';

// A model "codex" or "codex:<model>": OpenAI's Codex through the Codex CLI installed on this
// computer (`codex`, found on PATH or at CODEX_PATH), driven as the official TypeScript SDK drives
// it (github.com/openai/codex, sdk/typescript/src/exec.ts and thread.ts, read 2026-11-22), without
// the SDK: the SDK only starts that same program, and installing it (with the ~400 MB Codex it
// carries) was what kept Codex out of the bridge's one command. A session per side and match, as
// Claude's: the first report runs `codex exec --json … -` and Codex answers with JSON Lines events,
// the first of them `thread.started` with the session's id; every later report runs
// `codex exec --json … resume <id> -`, so Codex keeps the conversation (in its own session files,
// $CODEX_HOME/sessions) and only the new report is sent. The report goes on stdin (`-`). Codex uses
// its own sign-in (`codex login`: a ChatGPT plan or an API key, in CODEX_HOME); the server passes no
// key of its own unless CODEX_API_KEY or OPENAI_API_KEY is set in its settings.
// Locked down: the rulebook replaces Codex's own instructions (model_instructions_file, a file in
// the session's folder); command execution, images, apps (connectors), sub-agents, remote plugins,
// hooks, bundled skills and MCP servers off; web search disabled; a read-only sandbox without
// network for anything left; never asking for approval; an empty working folder; the user's
// config.toml and execpolicy rules not loaded (--ignore-user-config: "auth still uses CODEX_HOME",
// --ignore-rules). Not --ephemeral: it keeps no session files, and `resume` in the next process
// reads the session from them.

// The documented sources of every argument (2026-11-22):
//  - learn.chatgpt.com/docs/non-interactive-mode.md: exec, --json (JSONL events), `-` (the prompt
//    from stdin), resume <SESSION_ID>, --skip-git-repo-check, --sandbox, --ignore-user-config,
//    --ignore-rules, --ephemeral ("doesn't persist session rollout files");
//  - codex-rs/exec/src/cli.rs: --json (alias --experimental-json, which the SDK passes), resume's
//    <SESSION_ID> [PROMPT] with `-` read from stdin; --skip-git-repo-check, --ignore-user-config,
//    --ignore-rules global; --sandbox, --cd, --model exec options before `resume`;
//  - learn.chatgpt.com/docs/config-file/config-reference.md: model_instructions_file,
//    features.shell_tool, view_image, apps, multi_agent, remote_plugin, hooks,
//    skills.bundled.enabled, mcp_servers, web_search, approval_policy,
//    sandbox_workspace_write.network_access; set with --config key=value (TOML values) as the SDK
//    does.

const RULEBOOK_FILE = 'rulebook.md';

// The arguments of one run: a new session (threadId null) or the next report of one
export function codexArgs(dir: string, model: string | null, threadId: string | null): string[] {
  const config = [
    `model_instructions_file=${JSON.stringify(join(dir, RULEBOOK_FILE))}`,
    'features.shell_tool=false',
    'features.view_image=false',
    'features.apps=false',
    'features.multi_agent=false',
    'features.remote_plugin=false',
    'features.hooks=false',
    'skills.bundled.enabled=false',
    'mcp_servers={}',
    'web_search="disabled"',
    'approval_policy="never"',
    'sandbox_workspace_write.network_access=false',
  ];
  return [
    'exec',
    '--json',
    ...config.flatMap((c) => ['--config', c]),
    ...(model === null ? [] : ['--model', model]),
    '--sandbox',
    'read-only',
    '--cd',
    join(dir, 'work'),
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    ...(threadId === null ? [] : ['resume', threadId]),
    '-',
  ];
}

// How Codex runs on this server, from its settings (never from a request)
export interface CodexRunner {
  exe: string; // the Codex program: CODEX_PATH, or codex on PATH
  env: Record<string, string>; // its environment
  keys: string[]; // the keys set for it on purpose, masked in its messages
  server: string;
}

const WINDOWS = process.platform === 'win32';
const INSTALL = 'npm install -g @openai/codex';
// Without a shell Windows can start a .exe only: npm's codex.cmd is not one
const WINDOWS_NOTE = WINDOWS
  ? " On Windows only a codex.exe is started (not npm's codex.cmd): use OpenAI's standalone installer, or set CODEX_PATH to a codex.exe."
  : '';

export const codexMissing = (server: string) =>
  `Codex is not installed on this computer (codex not found on PATH). Install it (${INSTALL}), run codex once and sign in, then restart ${server}.${WINDOWS_NOTE}`;

// Codex can run here, or why not (a request for it gets that as a 500, not retryable). Finding the
// program runs nothing: a file this user may run, on PATH or at CODEX_PATH.
export function codexRunner(
  vars: Record<string, string | undefined>,
  server: string,
  cwd = process.cwd()
): CodexRunner | string {
  const pathEnv = vars.PATH ?? '';
  const codexKey = (vars.CODEX_API_KEY ?? '').trim();
  const openaiKey = (vars.OPENAI_API_KEY ?? '').trim();
  const problem =
    keyProblem('CODEX_API_KEY', codexKey, server) ||
    keyProblem('OPENAI_API_KEY', openaiKey, server);
  if (problem) return problem;
  const configured = (vars.CODEX_PATH ?? '').trim();
  const found = locate('codex', configured ? resolve(cwd, configured) : null, pathEnv);
  if (typeof found !== 'string') {
    if (configured)
      return `CODEX_PATH is not the Codex program (no file this user may run there); fix it and restart ${server}.`;
    if (found.problem === 'not runnable')
      return `codex on PATH is not a file this user may run; fix it (or set CODEX_PATH) and restart ${server}.`;
    return codexMissing(server);
  }
  const env = passedOnEnv(vars, pathEnv, [
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
    'CODEX_CA_CERTIFICATE',
  ]);
  if (codexKey) env.CODEX_API_KEY = codexKey;
  if (openaiKey) env.OPENAI_API_KEY = openaiKey;
  return { exe: found, env, keys: [codexKey, openaiKey].filter(Boolean), server };
}

// What one run's JSON Lines say (codex-rs/exec/src/exec_events.rs; the SDK's events.ts): the
// session's id (thread.started), the last agent message of the turn (item.completed with an
// agent_message), the turn's usage (turn.completed), a failed turn's message (turn.failed), the
// last error event (the stream's own; also sent for errors that are retried)
export interface CodexTurn {
  threadId: string | null;
  text: string | null;
  completed: boolean;
  usage: Record<string, unknown> | null;
  failed: string | null;
  lastError: string | null;
}

// A session id as `resume` takes it: a UUID in practice; never anything that could be read as an
// option or hold a path
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function readEvents(stdout: string): CodexTurn {
  const turn: CodexTurn = {
    threadId: null,
    text: null,
    completed: false,
    usage: null,
    failed: null,
    lastError: null,
  };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event: { type?: unknown; [key: string]: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue; // not an event
    }
    if (!event || typeof event !== 'object') continue;
    const item = event.item as { type?: unknown; text?: unknown } | undefined;
    switch (event.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string' && SESSION_ID.test(event.thread_id))
          turn.threadId = event.thread_id;
        break;
      case 'item.completed':
        if (item?.type === 'agent_message' && typeof item.text === 'string') turn.text = item.text;
        break;
      case 'turn.completed':
        turn.completed = true;
        turn.usage =
          event.usage && typeof event.usage === 'object'
            ? (event.usage as Record<string, unknown>)
            : null;
        break;
      case 'turn.failed': {
        const message = (event.error as { message?: unknown } | undefined)?.message;
        turn.failed = typeof message === 'string' && message.trim() ? message : 'turn failed';
        break;
      }
      case 'error':
        if (typeof event.message === 'string') turn.lastError = event.message;
        break;
    }
  }
  return turn;
}

// A session Codex no longer has: `resume` fails naming it ("no rollout found for thread id <id>",
// codex-rs/thread-store) before a turn starts
const LOST = /no rollout found|session not found|thread not found|no thread with id/i;

// What Codex's own text says went wrong (codex-rs/protocol/src/error.rs, read 2026-11-22), as a
// message for the page: whether trying again at the next report may help
const SIGN_IN =
  /\b401\b|unauthori[sz]ed|not logged in|not signed in|missing bearer|please (?:re-?)?(?:log|sign) ?in|codex login|refresh token|token (?:has )?expired|access token/i;
const PLAN_LIMIT =
  /usage limit|quota exceeded|insufficient_quota|spend limit|spend cap|out of credits|upgrade to (?:plus|pro)/i;
const UNKNOWN_MODEL =
  /model_not_found|unknown model|invalid model|\bmodel\b[^\n]{0,80}?\b(?:not found|does not exist|not supported|unsupported|not available)/i;
const SANDBOX_REFUSED = /sandbox denied/i;
const SANDBOX_BROKEN = /landlock|seccomp|codex-linux-sandbox|sandbox error/i;
const BAD_SETTINGS =
  /error loading config|error parsing -c|invalid configuration|unknown configuration key/i;
const REFUSED_LINE = new RegExp(`${FLAGS_REFUSED.source}|invalid value '[^']*' for '--`, 'i');

export class CodexSession implements LlmSession {
  private threadId: string | null = null; // Codex's session, from the first report's events
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private dir: string | null = null; // the session's folder: the rulebook, and "work", empty
  private running: ChildProcess | null = null;

  constructor(
    readonly matchId: string,
    readonly model: string, // "codex" or "codex:<model>"
    private readonly rulebook: string,
    private readonly name: string | null, // the model's name; null: Codex's default
    private readonly runner: CodexRunner,
    private readonly side = '',
    private readonly timeoutMs = LLM_SERVER_TIMEOUT_MS
  ) {
    console.warn(
      `[llm] ${side} session started: ${model} (the Codex CLI at ${runner.exe}, a session kept by Codex)`
    );
  }

  isAlive(): boolean {
    return !this.closed;
  }

  ask(prompt: string): Promise<Answer> {
    const answer = this.queue.then(() => this.run(prompt));
    this.queue = answer.catch(() => undefined);
    return answer;
  }

  // The session's folder, made at the first report: the rulebook beside an empty working folder
  private folder(): string {
    if (this.dir) return this.dir;
    const dir = mkdtempSync(join(tmpdir(), 'battle-codex-'));
    mkdirSync(join(dir, 'work'));
    writeFileSync(join(dir, RULEBOOK_FILE), this.rulebook);
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

  // One run of the Codex CLI: a new session, or the next report of this one
  private async once(dir: string, prompt: string, threadId: string | null) {
    const started = Date.now();
    const out = await runProcess(
      {
        exe: this.runner.exe,
        args: codexArgs(dir, this.name, threadId),
        env: this.runner.env,
        cwd: join(dir, 'work'),
        input: prompt,
        timeoutMs: this.timeoutMs,
      },
      (child) => (this.running = child)
    );
    const turn = readEvents(out.stdout);
    console.warn(
      `[llm] ${this.side} (${this.model}): Codex ran ${((Date.now() - started) / 1000).toFixed(1)} s, start-up included (${out.spawnError ? `not started: ${out.spawnError}` : out.signal ? `ended by ${out.signal}` : `exit ${out.code}`}; ${threadId ? `session ${threadId.slice(0, 40)}` : 'a new session'})`
    );
    // The session goes on from here even when this turn failed: Codex has saved it
    if (turn.threadId) this.threadId = turn.threadId;
    return { out, turn };
  }

  private async run(prompt: string): Promise<Answer> {
    if (this.closed) throw sessionClosed();
    let dir: string;
    try {
      dir = this.folder();
    } catch (err) {
      throw new LlmError(
        `Codex could not be started: its folder could not be made (${capped(oneLine(String((err as { code?: unknown }).code ?? err)))}).`,
        true,
        true
      );
    }
    const resumed = this.threadId;
    let { out, turn } = await this.once(dir, prompt, resumed);
    // A session Codex no longer has: a new one at once, with the rulebook and this report
    if (resumed !== null && !this.closed && this.lost(out, turn, resumed)) {
      console.warn(
        `[llm] ${this.side} (${this.model}): Codex no longer has the session; a new one starts with this report`
      );
      this.threadId = null;
      ({ out, turn } = await this.once(dir, prompt, null));
    }
    if (this.closed) this.removeFolder();
    return this.answer(out, turn);
  }

  private lost(out: Run, turn: CodexTurn, id: string): boolean {
    if (out.spawnError || out.timedOut || out.overflow || turn.completed) return false;
    if (out.code === 0 && out.signal === null) return false;
    const said = `${turn.failed ?? ''} ${turn.lastError ?? ''} ${out.stderr}`;
    return LOST.test(said) && said.includes(id);
  }

  private answer(out: Run, turn: CodexTurn): Answer {
    const { server } = this.runner;
    if (out.spawnError === 'ENOENT' || out.spawnError === 'EACCES')
      throw new LlmError(
        `Codex could not be started (${out.spawnError}): its program is not there or not runnable; install Codex (${INSTALL}), or fix CODEX_PATH, and restart ${server}.`,
        false,
        true
      );
    if (out.spawnError)
      throw new LlmError(`Codex could not be started (${out.spawnError}).`, true, true);
    if (this.closed) throw new LlmError(SESSION_CLOSED, true, true);
    // Not from a result: the endpoint closes the session (a fresh one next time)
    if (out.timedOut)
      throw new LlmError(
        `Codex did not answer within ${Math.round(this.timeoutMs / 1000)} s; its process was stopped.`,
        true
      );
    if (out.overflow)
      throw new LlmError(
        'Codex wrote more than 4 MB of output; its process was stopped.',
        true,
        true
      );
    if (turn.failed !== null) throw this.failure(capped(oneLine(this.masked(turn.failed))));
    if (out.code !== 0 || out.signal !== null) {
      const detail =
        (turn.lastError !== null ? capped(oneLine(this.masked(turn.lastError))) : '') ||
        this.masked(lastWords(out)) ||
        (out.signal ? `ended by ${out.signal}` : `exit ${out.code}`);
      throw this.failure(detail);
    }
    // An answer that is empty, cut off or oversized is an error, never a 200 (the browser would
    // read it as no orders); Codex has the turn in its session anyway
    if (!turn.completed)
      throw new LlmError(
        'Codex: the turn did not complete (its events ended before turn.completed); the answer is not used.',
        true,
        true
      );
    const text = withoutThinking(turn.text ?? '');
    if (!text.trim()) throw new LlmError('Codex: the answer was empty.', true, true);
    if (text.length > MAX_ANSWER_CHARS)
      throw new LlmError(
        `Codex: the answer was ${Math.round(text.length / 1000)} KB of text, more than the ${MAX_ANSWER_CHARS / 1000} KB an answer may have.`,
        true,
        true
      );
    const usage = turn.usage ?? {};
    return {
      text,
      meta: {
        costUsd: null, // Codex reports none
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: num(usage.cached_input_tokens),
        cacheWriteTokens: num(usage.cache_write_input_tokens),
        apiMs: null,
        turns: 1,
        modelIds: this.name === null ? [] : [this.name],
      },
    };
  }

  // A failed turn or run, by what Codex's text says (already cut to 300 characters)
  private failure(detail: string): LlmError {
    const { server } = this.runner;
    if (REFUSED_LINE.test(detail))
      return new LlmError(
        `The installed Codex does not accept the command line the bridge gives it (an older or newer version?): ${detail}`,
        false,
        true
      );
    if (BAD_SETTINGS.test(detail))
      return new LlmError(
        `The installed Codex refused the settings the bridge gives it (another version?): ${detail}`,
        false,
        true
      );
    if (SIGN_IN.test(detail))
      return new LlmError(
        `Codex is not signed in on this computer, or its sign-in has expired (${detail}). Run codex once in a terminal and sign in (codex login), then start the match again.`,
        false,
        true
      );
    if (PLAN_LIMIT.test(detail))
      return new LlmError(
        `Codex: a limit of its plan or key was reached (${detail}).`,
        false,
        true
      );
    if (UNKNOWN_MODEL.test(detail))
      return new LlmError(
        `Codex cannot use ${this.name === null ? 'its default model' : `the model "${this.name}"`} (${detail}). Choose another model.`,
        false,
        true
      );
    if (SANDBOX_REFUSED.test(detail))
      return new LlmError(
        `Codex's read-only sandbox refused what the model tried to do (${detail}).`,
        true,
        true
      );
    if (SANDBOX_BROKEN.test(detail))
      return new LlmError(
        `Codex's sandbox cannot run here (${detail}); see Codex's own documentation on its sandbox, then restart ${server}.`,
        false,
        true
      );
    return new LlmError(
      `Codex failed (${detail}). If it keeps failing: if Codex is not signed in, run codex once in a terminal and sign in (codex login).`,
      true,
      true
    );
  }

  // The keys set for Codex on purpose, out of its text
  private masked(text: string): string {
    let result = text;
    for (const key of this.runner.keys) result = result.split(key).join('…');
    return result;
  }

  // Replaced by a new match or model, or the server is closing: a running Codex is stopped (with
  // every process it started) and the session's folder removed; a request still waiting fails with
  // "session was closed". Codex's own session files stay (they are its, in CODEX_HOME).
  close(): void {
    this.closed = true;
    if (this.running) stopTree(this.running);
    this.removeFolder();
  }
}
