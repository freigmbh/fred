import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { backendImage, composeConfig } from './compose.mjs';
import { clean, lock, parseArguments, openRouterKey } from './index.mjs';
import { snapshot } from './snapshot.mjs';
import { planClean } from './instances.mjs';

const root = new URL('../../', import.meta.url);

test('every Convex backend pin names the same image revision', async () => {
  const revision = backendImage.split(':').at(-1);
  const stack = await readFile(new URL('docker/compose.yaml', root), 'utf8');
  const selfHosted = await readFile(new URL('apps/controller/self-hosted/.env.example', root), 'utf8');
  assert.deepEqual([...new Set(stack.match(/convex-backend:\w+/g))], [`convex-backend:${revision}`]);
  assert.match(selfHosted, new RegExp(`^REV=${revision}$`, 'm'));
});

test('dangling source symlinks have the same actionable error as valid symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fred-dev-symlink-'));
  try {
    const root = join(directory, 'repo');
    await mkdir(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    await symlink('missing.ts', join(root, 'link.ts'));
    await assert.rejects(snapshot(root, join(directory, 'copy')), /Source symlinks are not supported in local snapshots: link.ts/);
    await writeFile(join(root, 'missing.ts'), 'export {};');
    await assert.rejects(snapshot(root, join(directory, 'copy')), /Source symlinks are not supported in local snapshots: link.ts/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('root agent tooling stays out of the snapshot, so its skill symlinks do not block it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fred-dev-agents-'));
  try {
    const root = join(directory, 'repo');
    await mkdir(join(root, '.agents', 'skills', 'review'), { recursive: true });
    await mkdir(join(root, '.claude', 'skills'), { recursive: true });
    await mkdir(join(root, 'fixtures', '.agents'), { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    await writeFile(join(root, '.agents', 'skills', 'review', 'SKILL.md'), 'skill');
    await symlink('../../.agents/skills/review', join(root, '.claude', 'skills', 'review'));
    await writeFile(join(root, 'fixtures', '.agents', 'SKILL.md'), 'fixture skill');
    await snapshot(root, join(directory, 'copy'));
    await assert.rejects(access(join(directory, 'copy', '.agents')), { code: 'ENOENT' });
    await assert.rejects(access(join(directory, 'copy', '.claude')), { code: 'ENOENT' });
    assert.equal(await readFile(join(directory, 'copy', 'fixtures', '.agents', 'SKILL.md'), 'utf8'), 'fixture skill');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('source identity includes uncommitted edits and new files while excluding env files and host dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fred-dev-snapshot-'));
  try {
    const root = join(directory, 'repo');
    await mkdir(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    await writeFile(join(root, 'code.ts'), 'before');
    await writeFile(join(root, '.env.example'), 'API_KEY=');
    execFileSync('git', ['add', 'code.ts', '.env.example'], { cwd: root });
    const before = await snapshot(root, join(directory, 'before'));
    await writeFile(join(root, 'code.ts'), 'after');
    await writeFile(join(root, 'new.ts'), 'new file');
    await writeFile(join(root, '.env'), 'PRIVATE_TOKEN=secret');
    await writeFile(join(root, '.env.local.example'), 'UNTRACKED_SECRET=private');
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'host-binary'), 'host');
    const after = await snapshot(root, join(directory, 'after'));
    assert.notEqual(before, after);
    assert.equal(await readFile(join(directory, 'after', 'code.ts'), 'utf8'), 'after');
    assert.equal(await readFile(join(directory, 'after', 'new.ts'), 'utf8'), 'new file');
    await assert.rejects(readFile(join(directory, 'after', '.env')), { code: 'ENOENT' });
    assert.equal(await readFile(join(directory, 'after', '.env.example'), 'utf8'), 'API_KEY=');
    await assert.rejects(readFile(join(directory, 'after', '.env.local.example')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(directory, 'after', 'node_modules', 'host-binary')), { code: 'ENOENT' });
    await writeFile(join(root, '.env'), 'PRIVATE_TOKEN=changed');
    assert.equal(await snapshot(root, join(directory, 'again')), after);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only the OpenRouter token leaves the host env file for an explicit live check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fred-dev-keys-'));
  try {
    await mkdir(join(directory, 'apps/worker'), { recursive: true });
    await writeFile(join(directory, 'apps/worker/.env'), 'OPENROUTER_API_TOKEN=router-token\nGITLAB_BOT_TOKEN_CLAUDE=gitlab-secret\n');
    assert.deepEqual(await openRouterKey(directory, undefined, {}), {});
    assert.deepEqual(await openRouterKey(directory, 'openrouter', {}), { OPENROUTER_API_TOKEN: 'router-token' });
    assert.deepEqual(await openRouterKey(directory, 'openrouter', { OPENROUTER_API_TOKEN: 'environment-token', WORKER_SECRET: 'private' }), { OPENROUTER_API_TOKEN: 'environment-token' });
    await rm(join(directory, 'apps/worker/.env'));
    await assert.rejects(openRouterKey(directory, 'openrouter', {}), /Set OPENROUTER_API_TOKEN/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('clean selects orphaned worktrees, skipping ones a live command owns or without recorded metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fred-dev-clean-'));
  try {
    const stateRoot = join(directory, 'state');
    const worktree = join(directory, 'worktree');
    await mkdir(worktree);
    const instance = async (name, sourceRoot) => {
      await mkdir(join(stateRoot, name), { recursive: true });
      if (sourceRoot) await writeFile(join(stateRoot, name, 'instance.json'), JSON.stringify({ sourceRoot }));
    };
    await instance('fred-dev-alive', worktree);
    await instance('fred-dev-gone', join(directory, 'deleted'));
    await instance('fred-dev-busy', join(directory, 'deleted-too'));
    await mkdir(join(stateRoot, 'fred-dev-busy', 'lock'));
    await writeFile(join(stateRoot, 'fred-dev-busy', 'lock', 'pid'), String(process.pid));
    await instance('fred-dev-unknown');
    const plan = await planClean(stateRoot);
    assert.deepEqual(plan.remove.map((entry) => entry.instance), ['fred-dev-gone']);
    assert.deepEqual(plan.skipped.map((entry) => [entry.instance, entry.reason]), [['fred-dev-busy', `owned by process ${process.pid}`], ['fred-dev-unknown', 'no recorded worktree']]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('clean untags legacy images by name so a shared image keeps other tags, and holds its lock until the current instance goes last', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fred-dev-clean-run-'));
  const log = console.log;
  console.log = () => {};
  try {
    const stateRoot = join(directory, 'state');
    const current = join(stateRoot, 'fred-dev-current');
    await mkdir(current, { recursive: true });
    await mkdir(join(stateRoot, 'fred-dev-gone'));
    await writeFile(join(stateRoot, 'fred-dev-gone', 'instance.json'), JSON.stringify({ sourceRoot: join(directory, 'deleted') }));
    await writeFile(join(stateRoot, 'fred-dev-gone', 'compose.json'), '{}');
    const unlock = await lock(current);
    const calls = [];
    const docker = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'compose') await access(join(current, 'lock', 'pid'));
      if (args[0] === 'image' && args[1] === 'ls') return args[4].startsWith('reference=') ? 'shared-image' : '';
      return '';
    };
    await clean(stateRoot, 'fred-dev-current', current, docker);
    await unlock();
    assert.ok(calls.includes('compose --project-name fred-dev-gone --file ' + join(stateRoot, 'fred-dev-gone', 'compose.json') + ' down --volumes --remove-orphans'));
    assert.deepEqual(calls.filter((call) => call.startsWith('image rm')), ['image rm fred-dev-gone:local', 'image rm fred-dev-current:local']);
    await assert.rejects(access(current), { code: 'ENOENT' });
    await assert.rejects(access(join(stateRoot, 'fred-dev-gone')), { code: 'ENOENT' });
  } finally { console.log = log; await rm(directory, { recursive: true, force: true }); }
});

test('releasing a lock leaves a lock another process acquired in its place alone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fred-dev-lock-'));
  try {
    const unlock = await lock(directory);
    await rm(join(directory, 'lock'), { recursive: true });
    await mkdir(join(directory, 'lock'));
    await writeFile(join(directory, 'lock', 'pid'), String(process.pid + 1));
    await unlock();
    assert.equal(await readFile(join(directory, 'lock', 'pid'), 'utf8'), String(process.pid + 1));
    await rm(join(directory, 'lock'), { recursive: true });
    const again = await lock(directory);
    await again();
    await assert.rejects(access(join(directory, 'lock')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('local containers expose only loopback ports and keep fixture endpoints inside their shared network', () => {
  const config = composeConfig({ name: 'fred-dev-example', sourceHash: 'abc', secret: 'instance', workerSecret: 'worker', webhookSecret: 'hook', tokenKey: 'vault' });
  assert.equal(config.services.worker.network_mode, 'service:backend');
  assert.equal(config.services.bootstrap.environment.FRED_TOKEN_KEY, 'vault');
  assert.equal(Object.hasOwn(config.services.worker.environment, 'FRED_TOKEN_KEY'), false);
  assert.deepEqual(config.services.worker.cap_drop, ['ALL']);
  for (const service of Object.values(config.services)) {
    for (const port of service.ports ?? []) assert.ok(port.startsWith('127.0.0.1:'));
    assert.equal(service.privileged, undefined);
    assert.equal(Object.hasOwn(service.environment, 'OPENROUTER_API_TOKEN'), false);
  }
});

test('invalid live selections fail before Docker starts and any vendor model can run either stage', () => {
  for (const args of [
    ['verify', '--live', 'other'], ['verify', '--bot', 'claude'], ['up', '--live', 'openrouter'],
    ['verify', '--live', 'openrouter', '--scenario', 'provider-failure'], ['verify', '--model', 'unnamespaced'],
    ['verify', '--effort', 'invented'], ['clean', '--live', 'openrouter'],
  ]) assert.throws(() => parseArguments(args));
  assert.deepEqual(parseArguments(['verify', '--live', 'openrouter', '--model', 'google/gemini-3.1-pro-preview', '--effort', 'default', '--json']).flags,
    { '--live': 'openrouter', '--model': 'google/gemini-3.1-pro-preview', '--effort': 'default', '--json': true });
  assert.deepEqual(parseArguments(['verify', '--live', 'openrouter', '--scenario', 'large-diff']).flags,
    { '--live': 'openrouter', '--scenario': 'large-diff' });
});
