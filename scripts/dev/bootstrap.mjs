import { fileURLToPath } from 'node:url';
// The dev image's Node 24 runs this TypeScript module directly through type stripping. That works only while it has no imports.
import { redactSecrets, secretValues } from '../../packages/contracts/src/redaction.ts';
import { fixtureProject } from '../fixture-project.mjs';

if (process.env.FRED_DEV_ONLY !== '1' || process.env.CONVEX_SELF_HOSTED_URL !== 'http://127.0.0.1:3210') throw new Error('Expected an isolated local controller');
const root = fileURLToPath(new URL('../../', import.meta.url));
let project;
try {
  project = await fixtureProject(root, 'dev', { url: process.env.CONVEX_SELF_HOSTED_URL, adminKey: process.env.CONVEX_SELF_HOSTED_ADMIN_KEY });
  await project.deploy({ FRED_DEV_ONLY: '1', WORKER_SECRET: process.env.WORKER_SECRET, GITLAB_WEBHOOK_SECRET: process.env.GITLAB_WEBHOOK_SECRET,
    ADMIN_SECRET: process.env.ADMIN_SECRET, FRED_TOKEN_KEY: process.env.FRED_TOKEN_KEY }, 'enable');
  await project.run('dev:seed');
  await project.run('dev:seedDashboard');
  await project.run('dev:connectFixture');
  try {
    await project.run('admin:refreshModels', { adminSecret: process.env.ADMIN_SECRET });
  } catch {
    process.stderr.write('OpenRouter catalog refresh failed. Local verification remains available; retry Refresh catalog in the admin UI.\n');
  }
  console.log('Local controller deployed and seeded.');
} catch (error) {
  const output = [error?.stderr, error?.stdout].filter(Boolean).map(String).join('\n').trim() || String(error?.message ?? '');
  process.stderr.write(`Local controller setup failed.${output ? `\n${redactSecrets(output, secretValues(process.env))}` : ' Check the backend logs and controller code.'}\n`);
  process.exitCode = 1;
} finally {
  await project?.remove();
}
