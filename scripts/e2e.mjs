import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { backendImage } from './dev/compose.mjs';
import { fixtureProject } from './fixture-project.mjs';

const ciService = process.argv.includes('--ci-service');
if (ciService && process.env.GITLAB_CI !== 'true') throw new Error('--ci-service requires a disposable GitLab service');
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const name = `fred-e2e-${randomUUID()}`;
const remote = process.env.DOCKER_HOST?.startsWith('tcp://') ? new URL(process.env.DOCKER_HOST).hostname : undefined;
const host = remote ?? '127.0.0.1';
const bind = remote ? '0.0.0.0' : '127.0.0.1';
const docker = (...args) => exec('docker', args, { maxBuffer: 2 * 1024 * 1024 });
const since = String(Math.floor(Date.now() / 1000) - 1);

async function ready() {
  const events = spawn('docker', ['events', '--since', since, '--filter', `container=${name}`, '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = createInterface({ input: events.stdout });
  try {
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.Action === 'health_status: healthy') return;
      if (['die', 'health_status: unhealthy'].includes(event.Action)) throw new Error('E2E backend failed to start');
    }
    throw new Error('Docker event stream ended before readiness');
  } finally { lines.close(); events.kill(); }
}

let project;
try {
  let url, site, key;
  if (ciService) {
    url = 'http://fred-e2e-backend:3210';
    site = 'http://fred-e2e-backend:3211';
    key = 'fred-e2e|01be1e2e7316b1774f3d59b09e259eed275672522f0005349bdb1a8fa7744c513db1ebb56b';
    console.log('Using the disposable GitLab Convex service with public fixture credentials.');
  } else {
    console.log('Starting an isolated, disposable self-hosted Convex backend.');
    await docker('run', '--detach', '--rm', '--name', name,
      '-p', `${bind}::3210`, '-p', `${bind}::3211`,
      '--add-host', 'host.docker.internal:host-gateway',
      '-e', 'DISABLE_BEACON=true', '-e', 'DO_NOT_REQUIRE_SSL=true', '-e', 'SQLITE_DB=/dev/shm/fred-e2e.sqlite3',
      '--health-cmd', 'curl -fsS http://localhost:3210/version', '--health-interval', '1s', '--health-retries', '60', backendImage);
    await ready();
    const port = async (number) => (await docker('port', name, String(number))).stdout.trim().split(':').at(-1);
    url = `http://${host}:${await port(3210)}`;
    site = `http://${host}:${await port(3211)}`;
    key = (await docker('exec', name, './generate_admin_key.sh')).stdout.trim();
  }
  project = await fixtureProject(root, 'e2e', { url, adminKey: key });
  await project.deploy({ WORKER_SECRET: 'e2e-worker', GITLAB_WEBHOOK_SECRET: 'e2e-hook', FRED_TOKEN_KEY: randomBytes(32).toString('base64'), FRED_E2E_ONLY: '1' }, 'disable');
  console.log('Running concurrent worker, webhook, accounting, and publication recovery checks.');
  const child = spawn(resolve(root, 'node_modules/.bin/vitest'), ['run', '--config', 'vitest.e2e.config.ts'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, FRED_E2E_URL: url, FRED_E2E_SITE: site, FRED_E2E_KEY: key },
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error('E2E checks failed');
} finally {
  if (!ciService) await docker('rm', '--force', '--volumes', name).catch(() => {});
  await project?.remove();
}
