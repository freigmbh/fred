import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { uiVersionJson } from './release.mjs';

const bundlesOnly = process.argv.includes('--bundles');
const versionJson = process.env.FRED_VERSION ? uiVersionJson(process.env.FRED_VERSION) : undefined;
await build({
  entryPoints: ['apps/worker/src/main.ts'],
  outfile: 'apps/worker/dist/main.mjs',
  bundle: true,
  packages: 'external',
  platform: 'node',
  target: 'node24',
  format: 'esm',
});
execFileSync(process.execPath, ['--check', 'apps/worker/dist/main.mjs'], { stdio: 'inherit' });
execFileSync('pnpm', ['--filter', '@fred/ui', 'build'], { stdio: 'inherit' });
if (versionJson) writeFileSync('apps/ui/dist/version.json', versionJson);
if (bundlesOnly) {
  console.log('Built worker bundle and admin UI.');
} else {
  const files = execFileSync('git', ['ls-files', '-z']);
  execFileSync('tar', ['-czf', 'release.tar.gz', '--null', '-T', '-', 'apps/worker/dist/main.mjs', 'apps/ui/dist'], { input: files });
  console.log('Built worker bundle, admin UI, and release.tar.gz from tracked files. Dependencies are installed from the frozen lockfile on the server.');
}
