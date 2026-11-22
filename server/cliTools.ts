import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { isCliToolName, modelLabel } from '../src/ai/Models';

// A command-line tool of the server's own settings as the strategic LLM (model "cli:<name>"):
// CLI_TOOL_<NAME>=<executable and arguments> in the environment or .env.local, never from a request
// (the endpoint is reachable from web pages; a request only names a tool the settings define). Run
// once per report (cliSession.ts) without a shell, in an empty folder, with a small environment;
// the prompt (rulebook, the last CLI_HISTORY_TURNS reports and answers, the new report) on stdin,
// its whole output the answer. The server does not lock it down: it runs the command as written,
// so what the tool may do is what the command allows. CLI_TOOLS=off turns them all off.

export interface CliTool {
  name: string; // in "cli:<name>"
  label: string; // "my_tool (this computer)"
  argv: string[]; // the command as written, split without a shell
  path: string | null; // the executable when the command gives it as a path; else looked up on PATH
}

export interface CliConfig {
  enabled: boolean; // CLI_TOOLS is not off
  historyTurns: number; // CLI_HISTORY_TURNS
  tools: Map<string, CliTool>;
  pathEnv: string; // where executables are looked for: PATH
  vars: Record<string, string | undefined>; // where the passed-on variables come from
  warnings: string[]; // logged once, when the server starts
}

// Splits a command as typed, without a shell: spaces separate words, '…' and "…" keep them
// together ("…" with \" and \\ inside), a backslash outside quotes keeps the next space, quote or
// backslash. Nothing else is special: no variables, ~, pipes, ; or globs. Text when it cannot be
// read.
export function splitCommand(text: string): string[] | string {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return 'a quote is not closed';
      word += text.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let closed = false;
      for (i++; i < text.length; i++) {
        const d = text[i];
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) word += text[++i];
        else word += d;
      }
      if (!closed) return 'a quote is not closed';
      inWord = true;
    } else if (c === '\\' && /[\s'"\\]/.test(text[i + 1] ?? '')) {
      word += text[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words.length > 0 ? words : 'it is empty';
}

const DEFAULT_HISTORY_TURNS = 3;
const OFF = /^(off|0|false|no)$/i;
const ON = /^(on|1|true|yes)?$/i;

// CLI_TOOLS: on unless it says off
export function cliEnabled(value: string | undefined): boolean {
  return !OFF.test((value ?? '').trim());
}

// The tools of the server's own settings, read once: `vars` is the environment with .env.local
export function cliConfig(
  vars: Record<string, string | undefined>,
  cwd = process.cwd()
): CliConfig {
  const warnings: string[] = [];
  const switchValue = (vars.CLI_TOOLS ?? '').trim();
  if (!OFF.test(switchValue) && !ON.test(switchValue))
    warnings.push('CLI_TOOLS must be on or off; command-line tools stay on.');
  const t = (vars.CLI_HISTORY_TURNS ?? '').trim();
  if (t && !/^\d+$/.test(t))
    warnings.push(
      `CLI_HISTORY_TURNS must be a whole number (0 or more); ${DEFAULT_HISTORY_TURNS} is used.`
    );
  const tools = new Map<string, CliTool>();
  for (const key of Object.keys(vars).sort()) {
    const value = vars[key];
    const match = /^CLI_TOOL_([A-Z0-9_]+)$/.exec(key);
    if (value === undefined || !match) continue;
    const name = match[1].toLowerCase();
    if (!isCliToolName(name)) {
      warnings.push(
        `${key}: a tool's name starts with a letter and has at most 32 characters; left out.`
      );
      continue;
    }
    const argv = splitCommand(value);
    if (typeof argv === 'string') {
      warnings.push(`${key} cannot be read (${argv}); left out.`);
      continue;
    }
    const exe = argv[0];
    tools.set(name, {
      name,
      label: modelLabel(`cli:${name}`),
      argv,
      path: exe.includes('/') || exe.includes('\\') ? resolve(cwd, exe) : null,
    });
  }
  return {
    enabled: cliEnabled(vars.CLI_TOOLS),
    historyTurns: /^\d+$/.test(t) ? Number(t) : DEFAULT_HISTORY_TURNS,
    tools,
    pathEnv: vars.PATH ?? '',
    vars,
    warnings,
  };
}

const WINDOWS = process.platform === 'win32';

// A file this user may run
function runnable(file: string): 'yes' | 'no' | 'missing' {
  try {
    if (!statSync(file).isFile()) return 'no';
    accessSync(file, constants.X_OK);
    return 'yes';
  } catch (err) {
    return (err as { code?: unknown }).code === 'ENOENT' ? 'missing' : 'no';
  }
}

// Where an executable is, without running anything: the path it was given as, or the first
// runnable file of its name in a PATH folder (absolute folders only; on Windows only .exe and .com:
// the server starts no shell, so it cannot run .cmd or .bat scripts)
export function locate(
  executable: string,
  path: string | null,
  pathEnv: string
): string | { problem: 'missing' | 'not runnable' } {
  if (path !== null) {
    const r = runnable(path);
    return r === 'yes' ? path : { problem: r === 'missing' ? 'missing' : 'not runnable' };
  }
  const names =
    WINDOWS && !/\.(exe|com)$/i.test(executable)
      ? [`${executable}.exe`, `${executable}.com`]
      : [executable];
  let seen = false;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of names) {
      const r = runnable(join(dir, name));
      if (r === 'yes') return join(dir, name);
      if (r === 'no') seen = true;
    }
  }
  return { problem: seen ? 'not runnable' : 'missing' };
}

// GET /api/bridge's list of these tools: id, label and whether the executable is there. Nothing
// else (no path, no command).
export interface CliStatus {
  id: string;
  label: string;
  available: boolean;
}

export function cliStatus(config: CliConfig): CliStatus[] {
  if (!config.enabled) return [];
  return [...config.tools.values()].map((tool) => ({
    id: `cli:${tool.name}`,
    label: tool.label,
    available: typeof locate(tool.argv[0], tool.path, config.pathEnv) === 'string',
  }));
}

// Passed on to a program the server starts (a tool, the Codex CLI) when set: where it finds its
// home, config and login (HOME, XDG, the Windows profile), the user and locale, temporary folders,
// and how this computer reaches the network (proxies, certificates). Nothing else of the server's
// environment: not its keys (OPENROUTER_API_KEY, LOCAL_LLM_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY,
// …), so the program uses its own sign-in.
const PASSED_ON = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'PROGRAMDATA',
];

export function passedOnEnv(
  vars: Record<string, string | undefined>,
  pathEnv: string,
  extra: string[] = []
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...PASSED_ON, ...extra]) {
    const value = vars[name];
    if (value !== undefined) env[name] = value;
  }
  env.PATH = pathEnv;
  env.NO_COLOR = '1';
  return env;
}

// Terminal colour and cursor codes, and other control characters but line breaks and tabs
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
export const withoutAnsi = (text: string): string => text.replace(ANSI, '');
export const plainText = (text: string): string =>
  withoutAnsi(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

// A command line the program does not accept: commander's "unknown option", yargs' "Unknown
// argument", clap's "unexpected argument"
export const FLAGS_REFUSED =
  /unknown option|unknown argument|unexpected argument|unrecognized (?:option|argument)/i;

// A program's own text on one line, without colour codes
export const oneLine = (text: string): string => plainText(text).replace(/\s+/g, ' ').trim();
