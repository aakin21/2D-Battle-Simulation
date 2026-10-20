import type { SimConfig } from '../types/types';

// Saving a file from the page: the match log (JSON) and the match replay (.replay).

// "match-control-jevllm-vs-none-20261018-153642.json": the objective, who commands each side
// ("+" left out) and the time `iso` (an ISO date string)
export function matchFileName(config: SimConfig, iso: string, extension: string): string {
  const stamp = iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const name = `match-${config.objective ?? 'elimination'}-${config.friendlyAI ?? 'none'}-vs-${config.enemyAI ?? 'none'}-${stamp}.${extension}`;
  return name.replace(/\+/g, '');
}

// Hands the blob to the browser as a download
export function downloadFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
