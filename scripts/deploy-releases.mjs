import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { uiStagingPrefix } from './deploy-ui.mjs';

export function pruneReleases(root, { current, keep = 3 }) {
  const releases = join(root, 'releases');
  const directories = (directory) => readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(directory, entry.name));
  const byAge = directories(releases).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const retained = new Set([resolve(current), ...byAge.slice(0, keep)]);
  const removed = [...byAge.filter((path) => !retained.has(path)), ...directories(root).filter((path) => path.startsWith(join(root, uiStagingPrefix)))];
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  return removed;
}
