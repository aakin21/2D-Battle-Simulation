// Packs the AI bridge for the published site: dist/ai-bridge.tgz, an npm package of the one
// bundled file, so a visitor starts the bridge with one command and no clone:
//   npx https://aakin21.github.io/2D-Battle-Simulation/ai-bridge.tgz
// Run after `vite build` (npm run build): it needs dist/ and builds the bundle first.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const { version, devDependencies } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// The SDK the bridge loads at run time when it is there (server/bridgeCli.ts): npx installs the
// Claude Agent SDK with the package, at the repository's version range. Codex needs nothing here:
// the bridge runs the Codex CLI installed on the computer (server/codexSession.ts).
const CLAUDE_SDK = '@anthropic-ai/claude-agent-sdk';

execFileSync('npm', ['run', 'bridge:build', '--silent'], { cwd: root, stdio: 'inherit' });

const work = mkdtempSync(join(tmpdir(), 'ai-bridge-'));
try {
  const pkg = join(work, 'package');
  mkdirSync(pkg);
  copyFileSync(join(root, 'dist-bridge', 'ai-bridge.mjs'), join(pkg, 'ai-bridge.mjs'));
  chmodSync(join(pkg, 'ai-bridge.mjs'), 0o755);
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify(
      {
        name: 'battle-ai-bridge',
        version,
        description: 'The 2D Battle Simulation AI bridge: runs your own model for the online demo',
        type: 'module',
        bin: { 'battle-ai-bridge': 'ai-bridge.mjs' },
        engines: { node: '>=20.12' },
        dependencies: { [CLAUDE_SDK]: devDependencies[CLAUDE_SDK] },
      },
      null,
      2
    ) + '\n'
  );
  mkdirSync(join(root, 'dist'), { recursive: true });
  execFileSync('tar', ['-czf', join(root, 'dist', 'ai-bridge.tgz'), '-C', work, 'package']);
  console.log('dist/ai-bridge.tgz');
} finally {
  rmSync(work, { recursive: true, force: true });
}
