import { chmodSync, cpSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const uiStagingPrefix = 'ui-staged-';

// Installs a release's UI for nginx. Rollback allows older releases without a UI bundle.
export function installUi(root, release, { allowMissing = false } = {}) {
  const dist = join(release, 'apps/ui/dist');
  const target = join(root, 'ui');
  if (!existsSync(join(dist, 'index.html'))) {
    if (!allowMissing) throw new Error('Release is missing the admin UI bundle');
    rmSync(target, { recursive: true, force: true });
    return;
  }
  const staged = mkdtempSync(join(root, uiStagingPrefix));
  try {
    cpSync(dist, staged, { recursive: true });
    chmodSync(staged, 0o755);
    rmSync(target, { recursive: true, force: true });
    renameSync(staged, target);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}
