import { spawn } from 'node:child_process';
import { allowedOrigins } from './aiAccess';
import {
  DEFAULT_BRIDGE_PORT,
  SETTINGS,
  demoLink,
  loadSettings,
  parsePort,
  startBridge,
  type Bridge,
  type BridgeStatus,
  type Settings,
} from './bridge';
import { localServer } from './chatSession';
import type { QueryFn } from './claudeSession';
import { claudeWay } from './bridgeClaude';
import { cliEnabled, locate } from './cliTools';
import { codexMissing } from './codexSession';

// The AI bridge's command (bridge.ts): `npm run bridge` in a clone of the repository, or the
// bundled file (dist-bridge/ai-bridge.mjs) run with plain node anywhere. Reads the settings, loads
// the Claude Agent SDK when it is there, starts the bridge, says what it found and opens the
// online demo connected to it.

const USAGE = `Usage: node ai-bridge.mjs [--port <number>] [--no-open]

Serves the LLM endpoint of the 2D Battle Simulation on this computer only, so that the online
demo can use what you have here: a local server such as Ollama, Claude (your Claude Code
sign-in, or your Anthropic API key), Codex (your Codex sign-in), Gemini with your Gemini API
key, OpenRouter with your key. When it has started it opens the demo in your browser, connected
to it.
Settings come from the environment and from .env.local in the current folder:
  ${SETTINGS.join(', ')},
  and CLI_TOOL_<NAME> (a command of your own).
--port (or BRIDGE_PORT) chooses the port, ${DEFAULT_BRIDGE_PORT} by default (0: any free port).
--no-open (or BRIDGE_OPEN=0) does not open the browser.`;

// The Agent SDK is not bundled (it starts the Claude Code program it installs beside itself): it
// is loaded from node_modules when it is there (npx installs it with the packed bridge, a clone
// has it), and without it only the Claude models are off.
async function loadSdk(): Promise<QueryFn | null> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    if (typeof sdk.query === 'function') return sdk.query;
  } catch {
    // not installed, or not loadable by this Node.js
  }
  return null;
}

function stop(message: string, code = 1): never {
  console.error(`AI bridge: ${message}`);
  process.exit(code);
}

// The options: --help, the port given with --port, --no-open (there is no option to listen
// elsewhere)
function readArgs(args: string[]): { help: boolean; port?: string; open: boolean } {
  let port: string | undefined;
  let open = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true, open: false };
    if (arg === '--port') port = args[++i] ?? '';
    else if (arg.startsWith('--port=')) port = arg.slice('--port='.length);
    else if (arg === '--no-open') open = false;
    else stop(`unknown option ${JSON.stringify(arg.slice(0, 40))}\n\n${USAGE}`, 2);
  }
  return { help: false, port, open };
}

// BRIDGE_OPEN: on unless it says off
const openSetting = (value: string | undefined) =>
  !/^(off|0|false|no)$/i.test((value ?? '').trim());

// The bridge's other settings and the project's keys, never in the browser's environment
const KEYS = [
  'OPENROUTER_API_KEY',
  'LOCAL_LLM_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'TYPESAFE_API_KEY',
  'SUBQ_API_KEY',
  'AI_PASSWORD',
];

// Opens `url` in the default browser: macOS's open, xdg-open elsewhere on Unix, Windows' start
// (a command of cmd.exe; the address is the demo's constant and the port, a number, so nothing in
// it is read by cmd). The program is looked for on PATH and started without a shell, detached;
// true when it started. Never fails the bridge: a computer without one gets the link to open.
function openBrowser(url: string): Promise<boolean> {
  const pathEnv = process.env.PATH ?? '';
  const windows = process.platform === 'win32';
  const name = process.platform === 'darwin' ? 'open' : windows ? 'cmd' : 'xdg-open';
  const exe = locate(name, null, pathEnv);
  if (typeof exe !== 'string') return Promise.resolve(false);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of KEYS) delete env[key];
  return new Promise((done) => {
    try {
      const child = spawn(exe, windows ? ['/d', '/c', 'start', '', url] : [url], {
        env,
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
        shell: false,
      });
      child.once('error', () => done(false));
      child.once('spawn', () => {
        child.unref();
        done(true);
      });
    } catch {
      done(false);
    }
  });
}

// The port from --port, BRIDGE_PORT or the default
function portOf(given: string | undefined, settings: Settings): number {
  const text = given ?? settings.env.BRIDGE_PORT ?? String(DEFAULT_BRIDGE_PORT);
  const port = parsePort(text);
  if (port === null)
    stop(
      `the port must be a number from 0 to 65535 (${given === undefined ? 'BRIDGE_PORT' : '--port'} is ${JSON.stringify(text.slice(0, 20))}).`,
      2
    );
  return port;
}

const MODELS_SHOWN = 8;

// What the bridge found, for the terminal: never a key or another secret. `opened`: the demo was
// opened in the browser (null: not tried)
function report(
  bridge: Bridge,
  status: BridgeStatus,
  settings: Settings,
  cwd: string,
  sdkQuery: QueryFn | null,
  opened: boolean | null
): string {
  const { env } = settings;
  const { llm } = status;
  const lines = [`2D Battle Simulation AI bridge ${status.version}`];
  lines.push(`Listening on ${bridge.url} (this computer only)`, '');
  const local = localServer(env.LOCAL_LLM_URL, 'the bridge');
  let localLine: string;
  if (typeof local === 'string') localLine = local;
  else if (llm.local.models === null)
    localLine = `${local.origin} does not answer: start Ollama (or your local server), or set LOCAL_LLM_URL.`;
  else if (llm.local.models.length === 0)
    localLine = `${local.origin} answers but has no models (with Ollama: ollama pull <model>).`;
  else {
    const shown = llm.local.models.slice(0, MODELS_SHOWN).join(', ');
    const more = llm.local.models.length - MODELS_SHOWN;
    localLine = `${local.origin}: ${llm.local.models.length} model${llm.local.models.length === 1 ? '' : 's'} (${shown}${more > 0 ? `, and ${more} more` : ''})`;
  }
  if (!/^[\x21-\x7e]*$/.test((env.LOCAL_LLM_KEY ?? '').trim()))
    localLine += ' LOCAL_LLM_KEY has characters a header cannot carry; fix it.';
  lines.push(`  Local models   ${localLine}`);
  const claude = claudeWay(sdkQuery, env.ANTHROPIC_API_KEY);
  lines.push(
    `  Claude         ${claude === 'key' ? 'with your Anthropic API key (ANTHROPIC_API_KEY), billed to its account; a session stops at LLM_MAX_BUDGET_USD of estimated spend' : claude === 'sign-in' ? 'your Claude Code sign-in on this computer (not signed in: run claude once and sign in)' : `off: ${claude}`}`
  );
  const codexKey = (env.CODEX_API_KEY ?? '').trim() ? ', with CODEX_API_KEY' : '';
  lines.push(
    `  Codex          ${llm.codex.available ? `found: your Codex sign-in on this computer${codexKey} (not signed in: run codex once and sign in)` : llm.codex.reason === codexMissing('the bridge') ? 'not found (install it and sign in: npm install -g @openai/codex, then codex login)' : `off: ${llm.codex.reason ?? ''}`}`
  );
  const geminiKey = (env.GEMINI_API_KEY ?? '').trim();
  lines.push(
    `  Gemini         ${llm.gemini ? 'key set (GEMINI_API_KEY)' : geminiKey ? 'GEMINI_API_KEY has characters a header cannot carry; fix it.' : 'no key (optional: GEMINI_API_KEY in .env.local)'}`
  );
  const routerKey = (env.OPENROUTER_API_KEY ?? '').trim();
  lines.push(
    `  OpenRouter     ${llm.openrouter ? 'key set (OPENROUTER_API_KEY)' : routerKey ? 'OPENROUTER_API_KEY has characters a header cannot carry; fix it.' : 'no key (optional: OPENROUTER_API_KEY in .env.local)'}`
  );
  // Commands of the player's own settings, only when there are any
  if (!cliEnabled(env.CLI_TOOLS)) lines.push('  Own commands   off (CLI_TOOLS=off)');
  else if (llm.custom.length > 0)
    lines.push(
      `  Own commands   ${llm.custom.map((t) => `${t.id} ${t.available ? 'found' : 'not found'}`).join(', ')}`
    );
  const where = settings.file
    ? `.env.local in ${cwd} and the environment`
    : `the environment${settings.problem ? ` (${settings.problem})` : ` (no .env.local in ${cwd})`}`;
  lines.push(`  Settings       ${where}`);
  lines.push(`  Allowed sites  ${[...allowedOrigins(env)].join(', ')} and pages on this computer`);
  lines.push('');
  const link = demoLink(env, bridge.url);
  if (link && opened) lines.push('Opened the demo in your browser, connected to this bridge.');
  else if (link && opened === false) lines.push('Could not open a browser here.');
  if (link)
    lines.push(
      `${opened ? 'In another browser, open' : 'Open the demo with this bridge'}:`,
      `  ${link}`
    );
  else lines.push(`Open your site with ?ai=${bridge.url} added to its address.`);
  lines.push(
    '',
    'The first time, the browser asks whether the site may reach your computer: allow it.',
    'Press Ctrl+C to stop the bridge.'
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const cwd = process.cwd();
  const settings = loadSettings(cwd);
  const port = portOf(args.port, settings);
  const sdkQuery = await loadSdk();
  let bridge: Bridge;
  try {
    bridge = await startBridge({ port, env: settings.env, sdkQuery });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'EADDRINUSE')
      stop(
        `port ${port} on 127.0.0.1 is already in use (is the bridge already running?). Start it on another port with --port <number> or BRIDGE_PORT=<number>.`
      );
    if (code === 'EACCES')
      stop(`port ${port} cannot be used without administrator rights; choose one above 1023.`);
    stop(`could not start: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The demo, connected to this bridge, in the default browser: only with the demo's site allowed
  const link = demoLink(settings.env, bridge.url);
  const opened =
    link && args.open && openSetting(settings.env.BRIDGE_OPEN) ? await openBrowser(link) : null;
  console.log(report(bridge, await bridge.status(), settings, cwd, sdkQuery, opened));
  const quit = () => void bridge.close().then(() => process.exit(0));
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);
}

void main();
