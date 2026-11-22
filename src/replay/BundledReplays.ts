import { decodeReplay, Replay } from './Replay';

// Replays shipped with the site, for the title screen's "Watch a recorded battle": static files in
// `public/replays/` (copied to the site's `replays/` folder by the build) listed in
// `replays/index.json`:
//   { "replays": [ { "file": "llm-vs-llm.replay", "title": "Sonnet + Jev vs Opus, Control A-B" } ] }
// `file` is a plain file name in that folder (no path, no address); `title` is optional text. The
// list is fetched relative to the page, so it works under any base path (vite `base: './'`).

export interface BundledReplay {
  file: string;
  title: string | null;
}

const INDEX_URL = 'replays/index.json';
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.replay$/;
const MAX_ENTRIES = 50;
const MAX_TITLE = 120;
const INDEX_TIMEOUT_MS = 8000;

// The usable entries of an index (anything else is skipped)
export function readIndex(json: unknown): BundledReplay[] {
  const list = (json as { replays?: unknown } | null)?.replays;
  if (!Array.isArray(list)) return [];
  const found: BundledReplay[] = [];
  for (const entry of list.slice(0, MAX_ENTRIES)) {
    const file = (entry as { file?: unknown } | null)?.file;
    if (typeof file !== 'string' || !FILE_NAME.test(file)) continue;
    const title = (entry as { title?: unknown }).title;
    found.push({
      file,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, MAX_TITLE) : null,
    });
  }
  return found;
}

// The replays the site ships; none when there is no index or it cannot be read (offline, opened
// from a file, no replays yet)
export async function listBundledReplays(): Promise<BundledReplay[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), INDEX_TIMEOUT_MS);
  try {
    const res = await fetch(INDEX_URL, { signal: abort.signal, cache: 'no-cache' });
    if (!res.ok) return [];
    return readIndex(await res.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Loads and checks a shipped replay (decodeReplay refuses a damaged file with a message)
export async function loadBundledReplay(entry: BundledReplay): Promise<Replay> {
  if (!FILE_NAME.test(entry.file)) throw new Error('not a replay file name');
  const res = await fetch(`replays/${entry.file}`);
  if (!res.ok) throw new Error(`the file could not be loaded (HTTP ${res.status})`);
  return decodeReplay(await res.blob());
}
