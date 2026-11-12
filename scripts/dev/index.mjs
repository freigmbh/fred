import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { composeConfig } from './compose.mjs';
import { planClean, readJson } from './instances.mjs';
import { snapshot } from './snapshot.mjs';

// The compose services that stay up between commands. Bootstrap runs once per source change.
const services = ['backend', 'worker', 'dashboard'];

export const usage = 'Usage: pnpm fred dev up|verify|inspect|logs|down|clean [--live openrouter] [--model vendor/model] [--effort default|none|minimal|low|medium|high|xhigh|max] [--scenario success|provider-failure|large-diff] [--json]';

export function parseArguments([command, ...args]) {
  if (!['up', 'verify', 'inspect', 'logs', 'down', 'clean'].includes(command)) throw new Error(usage);
  const flags = {};
  while (args.length) {
    const flag = args.shift();
    if (!['--live', '--model', '--effort', '--scenario', '--json'].includes(flag) || Object.hasOwn(flags, flag)) throw new Error(usage);
    flags[flag] = flag === '--json' ? true : args.shift();
    if (flags[flag] === undefined) throw new Error(usage);
  }
  if (command !== 'verify' && Object.keys(flags).some((flag) => flag !== '--json')) throw new Error(usage);
  if (flags['--live'] && flags['--live'] !== 'openrouter') throw new Error(usage);
  if (flags['--model'] && !/^[^\s/]+\/[^\s]+$/.test(flags['--model'])) throw new Error('Use a namespaced OpenRouter model ID, such as vendor/model');
  if (flags['--effort'] && !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(flags['--effort'])) throw new Error(usage);
  if (flags['--scenario'] && !['success', 'provider-failure', 'large-diff'].includes(flags['--scenario'])) throw new Error(usage);
  if (flags['--live'] && flags['--scenario'] === 'provider-failure') throw new Error('Failure scenarios use simulated OpenRouter responses');
  return { command, flags };
}

export async function openRouterKey(root, live, env = process.env) {
  if (!live) return {};
  const name = 'OPENROUTER_API_TOKEN';
  let value = env[name];
  for (const path of ['.env.dev', 'apps/worker/.env']) {
    if (value) break;
    try { value = parseEnv(await readFile(join(root, path), 'utf8'))[name]; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!value) throw new Error(`Set ${name} in your environment or .env.dev before a live check`);
  return { [name]: value };
}

function docker(args, { input, capture = false, report = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      if (capture) output += chunk;
      else (report ? process.stdout : process.stderr).write(chunk);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const interrupt = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    child.once('error', reject);
    child.once('close', (code) => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      if (code !== 0) reject(new Error(`Docker ${args[0]} failed. Inspect this instance with pnpm fred dev logs.`));
      else resolve(output.trim());
    });
  });
}

function publicMetadata(metadata) {
  if (!metadata) return {};
  const { settings, ...result } = metadata;
  return result;
}

export async function lock(directory) {
  const path = join(directory, 'lock');
  try { await mkdir(path); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another local FRED command owns ${path}. If it was interrupted, confirm it has exited before removing that lock directory.`);
  }
  await writeFile(join(path, 'pid'), String(process.pid));
  return async () => {
    if (await readFile(join(path, 'pid'), 'utf8').catch(() => '') === String(process.pid)) await rm(path, { recursive: true, force: true });
  };
}

async function removeInstance(instance, directory, docker) {
  const configFile = join(directory, 'compose.json');
  if (await readJson(configFile)) await docker(['compose', '--project-name', instance, '--file', configFile, 'down', '--volumes', '--remove-orphans']);
  const tag = `${instance}:local`;
  if (await docker(['image', 'ls', '--quiet', '--filter', `reference=${tag}`], { capture: true })) await docker(['image', 'rm', tag]);
  const labeled = (await docker(['image', 'ls', '--quiet', '--filter', `label=fred-dev.instance=${instance}`], { capture: true })).split('\n').filter(Boolean);
  if (labeled.length) await docker(['image', 'rm', '--force', ...labeled]);
  await rm(directory, { recursive: true, force: true });
}

export async function clean(stateRoot, instance, directory, docker) {
  const plan = await planClean(stateRoot);
  for (const orphan of plan.remove) await removeInstance(orphan.instance, orphan.directory, docker);
  await removeInstance(instance, directory, docker);
  console.log(JSON.stringify({ removed: [{ instance, directory, reason: 'current worktree' }, ...plan.remove], skipped: plan.skipped }, null, 2));
}

export async function develop(args) {
  const { command, flags } = parseArguments(args);
  const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const name = `fred-dev-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
  const stateRoot = join(homedir(), '.local', 'share', 'fred-dev');
  const directory = join(stateRoot, name);
  const configFile = join(directory, 'compose.json');
  const metadataFile = join(directory, 'instance.json');
  const compose = (args, options) => docker(['compose', '--project-name', name, '--file', configFile, ...args], options);
  const endpoint = process.env.DOCKER_HOST || execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
  if (!endpoint.startsWith('unix://') && !endpoint.startsWith('npipe://')) throw new Error('Local development requires a local Docker socket, not a remote Docker host');
  const keys = await openRouterKey(root, flags['--live']);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const unlock = ['up', 'verify', 'down', 'clean'].includes(command) ? await lock(directory) : undefined;
  try {
    if (command === 'clean') { await clean(stateRoot, name, directory, docker); return; }
    let metadata = await readJson(metadataFile);
    const configured = Boolean(await readJson(configFile));
    if (!configured && ['inspect', 'logs', 'down'].includes(command)) {
      console.log(JSON.stringify({ running: false, instance: name, message: 'No local instance. Run pnpm fred dev up or verify.' }, null, 2));
      return;
    }
    if (command === 'down') { await compose(['down']); return; }
    if (command === 'logs') { await compose(['logs', '--no-color', '--tail', '200'], { report: true }); return; }
    const wasRunning = configured && Boolean(await compose(['ps', '--status', 'running', '-q', 'worker'], { capture: true }));
    if (command === 'inspect') {
      if (!wasRunning) { console.log(JSON.stringify({ running: false, ...publicMetadata(metadata) }, null, 2)); return; }
      await compose(['exec', '-T', 'worker', 'node', '--import', 'tsx/esm', 'src/dev/client.ts', 'inspect'], { report: true });
      return;
    }

    const source = join(directory, 'source');
    await rm(source, { recursive: true, force: true });
    await mkdir(source);
    const sourceHash = await snapshot(root, source);
    const settings = {
      secret: randomBytes(32).toString('hex'), workerSecret: randomBytes(32).toString('hex'), webhookSecret: randomBytes(32).toString('hex'),
      adminSecret: randomBytes(32).toString('hex'), tokenKey: randomBytes(32).toString('base64'), ...metadata?.settings,
    };
    const writeConfig = (options = {}) => writeFile(configFile, JSON.stringify(composeConfig({ name, sourceHash, ...settings, ...options }), null, 2), { mode: 0o600 });
    let started = false;
    try {
      const runningServices = configured ? (await compose(['ps', '--status', 'running', '-q'], { capture: true })).split('\n').filter(Boolean).length : 0;
      if (runningServices !== services.length || metadata?.sourceHash !== sourceHash) {
        if (wasRunning) await compose(['stop', 'worker']);
        await docker(['build', '--label', `fred-dev.instance=${name}`, '--file', join(source, 'scripts/dev/Dockerfile'), '--tag', `${name}:local`, source]);
        await writeConfig();
        await compose(['up', '-d', '--wait', 'backend']);
        started = true;
        const adminKey = await compose(['exec', '-T', 'backend', './generate_admin_key.sh'], { capture: true });
        const address = await compose(['port', 'backend', '3210'], { capture: true });
        const controllerUrl = `http://${address}`;
        await writeConfig({ adminKey, dashboardUrl: controllerUrl });
        await writeFile(join(directory, 'admin-key'), `${adminKey}\n`, { mode: 0o600 });
        await writeFile(join(directory, 'admin-secret'), `${settings.adminSecret}\n`, { mode: 0o600 });
        await compose(['run', '--rm', '--no-deps', 'bootstrap']);
        await compose(['up', '-d', '--no-deps', '--wait', 'worker', 'dashboard']);
        const dashboardAddress = await compose(['port', 'dashboard', '6791'], { capture: true });
        metadata = { instance: name, sourceHash, sourceRoot: root, controllerUrl, dashboardUrl: `http://${dashboardAddress}`, adminKeyFile: join(directory, 'admin-key'),
          adminSecretFile: join(directory, 'admin-secret'), adminUi: `VITE_CONVEX_URL=${controllerUrl} pnpm --filter @fred/ui dev`, settings };
        await writeFile(metadataFile, JSON.stringify(metadata, null, 2), { mode: 0o600 });
      } else await compose(['up', '-d', '--wait', ...services]);
      if (command === 'up') {
        console.log(JSON.stringify({ running: true, ...publicMetadata(metadata) }, null, 2));
      } else {
        const verifyArgs = Object.entries(flags).filter(([flag]) => flag !== '--json').flatMap(([flag, value]) => [flag, value]);
        try {
          await compose(['exec', '-T', 'worker', 'node', '--import', 'tsx/esm', 'src/dev/client.ts', 'verify', ...verifyArgs], { input: JSON.stringify(keys), report: true });
        } catch (error) {
          await compose(['stop', 'worker']);
          throw error;
        }
      }
    } finally {
      if (command === 'verify' && !wasRunning && started) await compose(['stop', 'worker', 'dashboard', 'backend']);
    }
  } finally { await unlock?.(); }
}
