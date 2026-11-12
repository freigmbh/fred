import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyController, controllerEnvironment, destinations, ensureTokenKey, outputs, readDraft, readEnv, renderEnv, saveEnv, validateValue } from './setup-env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts/setup-env.mjs');
const values = {
  ...readEnv(join(root, 'apps/worker/.env.example')),
  CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:3210', CONVEX_SELF_HOSTED_ADMIN_KEY: 'fixture-admin',
  WORKER_SECRET: 'fixture-worker', GITLAB_WEBHOOK_SECRET: 'fixture-hook', GITLAB_URL: 'https://gitlab.internal',
  FRED_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), OPENROUTER_API_TOKEN: 'fixture-router',
  WORKER_MODE: 'fixture', WORKER_FIXTURE_PROJECT_IDS: '1', AI_REVIEW_LIVE: '',
};

function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'fred-setup-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function draft(path, values) {
  writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
}

test('dotenv round trips literal secrets and retains unrelated values without evaluating them', (t) => {
  const path = join(temporary(t), '.env');
  writeFileSync(path, 'UNRELATED="keep # this"\nWORKER_SECRET=old\n');
  const secret = 'literal#hash$HOME$(command)`text`\\backslash"quote';
  saveEnv(path, { WORKER_SECRET: secret, EXTRA_JSON: '{"example":"text"}' });
  assert.equal(readEnv(path).WORKER_SECRET, secret);
  assert.equal(readEnv(path).UNRELATED, 'keep # this');
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('the wizard leaves ADMIN_SECRET, which it never asks for, to the controller', () => {
  assert.equal(outputs({ ...values, ADMIN_SECRET: 'stale' }).controller.ADMIN_SECRET, undefined);
});

test('rejects dotenv record injection and symlink destinations', (t) => {
  assert.throws(() => renderEnv({ WORKER_SECRET: 'secret\nOPENROUTER_API_TOKEN=other' }), /single line/);
  const dir = temporary(t);
  const target = join(dir, 'target');
  const link = join(dir, '.env');
  writeFileSync(target, 'UNCHANGED=1\n');
  symlinkSync(target, link);
  assert.throws(() => saveEnv(link, { WORKER_SECRET: 'fixture' }), /non-regular/);
  assert.equal(readFileSync(target, 'utf8'), 'UNCHANGED=1\n');
});

test('keeps the token vault key on the controller and the provider key on the worker', () => {
  const files = outputs(values);
  assert.equal(files.controller.WORKER_SECRET, files.worker.WORKER_SECRET);
  assert.equal(files.controller.FRED_TOKEN_KEY, values.FRED_TOKEN_KEY);
  assert.equal(files.worker.FRED_TOKEN_KEY, undefined);
  assert.equal(files.deployment.CONVEX_SELF_HOSTED_ADMIN_KEY, 'fixture-admin');
  assert.equal(files.worker.CONVEX_SELF_HOSTED_ADMIN_KEY, undefined);
  assert.equal(files.controller.OPENROUTER_API_TOKEN, undefined);
  assert.equal(files.worker.OPENROUTER_API_TOKEN, 'fixture-router');
  assert.throws(() => validateValue('FRED_TOKEN_KEY', 'a'.repeat(64)), /32 random bytes/);
});

test('the preview hides the token vault key', (t) => {
  const path = join(temporary(t), 'draft');
  draft(path, values);
  const result = spawnSync(process.execPath, [script, 'summary', root, path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FRED_TOKEN_KEY: \[set, hidden\]/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${values.FRED_TOKEN_KEY.replace(/[+/=]/g, '\\$&')}|fixture-admin|fixture-router`));
});

test('controller reads and writes use the explicit self-hosted target, bounded requests, and no redirects', async () => {
  const calls = [];
  const stored = { WORKER_SECRET: 'remote-worker', UNRELATED: 'retain-me' };
  const fetcher = async (url, options) => {
    calls.push({ url, ...options, body: JSON.parse(options.body) });
    if (url.endsWith('/api/update_environment_variables')) for (const { name, value } of JSON.parse(options.body).changes) stored[name] = value;
    return new Response(JSON.stringify(url.endsWith('/api/query') ? { status: 'success', value: Object.entries(stored).map(([name, value]) => ({ name, value })) } : {}));
  };
  assert.deepEqual(await controllerEnvironment(values, fetcher), { WORKER_SECRET: 'remote-worker', UNRELATED: 'retain-me' });
  await applyController(values, fetcher);
  assert.deepEqual(new Set(calls.map((call) => call.url)), new Set(['http://127.0.0.1:3210/api/query', 'http://127.0.0.1:3210/api/update_environment_variables']));
  for (const call of calls) {
    assert.equal(call.redirect, 'error');
    assert.equal(call.headers.Authorization, 'Convex fixture-admin');
    assert.ok(call.signal instanceof AbortSignal);
  }
  const changes = calls.filter((call) => call.url.endsWith('/api/update_environment_variables')).flatMap((call) => call.body.changes);
  assert.ok(changes.some(({ name, value }) => name === 'WORKER_SECRET' && value === 'fixture-worker'));
  assert.ok(changes.every(({ name }) => !['OPENROUTER_API_TOKEN', 'CONVEX_SELF_HOSTED_ADMIN_KEY'].includes(name)));
  const made = calls.length;
  await assert.rejects(applyController({ ...values, CONVEX_SELF_HOSTED_URL: 'https://example.convex.cloud' }, fetcher), /Cloud/);
  assert.equal(calls.length, made);
  assert.equal(stored.UNRELATED, 'retain-me');
});

test('applying never replaces the token vault key the controller already uses', async () => {
  const stored = { FRED_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64') };
  const writes = [];
  const fetcher = async (url, options) => {
    if (url.endsWith('/api/update_environment_variables')) writes.push(options.body);
    return new Response(JSON.stringify(url.endsWith('/api/query') ? { status: 'success', value: Object.entries(stored).map(([name, value]) => ({ name, value })) } : {}));
  };
  await assert.rejects(applyController(values, fetcher), /FRED_TOKEN_KEY differs/);
  assert.equal(writes.length, 0);
});

test('reruns load saved values and report shared-value conflicts without revealing credentials', (t) => {
  const dir = temporary(t);
  for (const relative of Object.values(destinations)) mkdirSync(dirname(join(dir, relative)), { recursive: true });
  writeFileSync(join(dir, destinations.controller), 'WORKER_SECRET=controller-private\n');
  writeFileSync(join(dir, destinations.worker), 'WORKER_SECRET=worker-private\n');
  const path = join(dir, 'draft');
  const result = spawnSync(process.execPath, [script, 'init', dir, path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readDraft(path).WORKER_SECRET, 'worker-private');
  assert.match(result.stderr, /WORKER_SECRET/);
  assert.doesNotMatch(result.stderr + result.stdout, /controller-private|worker-private/);
});

test('final checks use the worker runtime schema without calling a provider or arming fixture mode', (t) => {
  const path = join(temporary(t), 'draft');
  draft(path, values);
  const check = () => spawnSync(process.execPath, [script, 'check', root, path], { encoding: 'utf8' });
  const good = check();
  assert.equal(good.status, 0, good.stderr);
  assert.equal(readDraft(path).AI_REVIEW_LIVE, '');
  draft(path, { ...values, OPENROUTER_API_TOKEN: '' });
  const missingToken = check();
  assert.equal(missingToken.status, 1);
  assert.match(missingToken.stderr, /OPENROUTER_API_TOKEN/);
  assert.doesNotMatch(missingToken.stderr, /fixture-router|fixture-admin/);
  draft(path, { ...values, CONVEX_URL: 'https://controller.internal' });
  assert.match(check().stderr, /localhost|this machine/);
});

test('invalid ports and organization settings produce actionable errors', () => {
  assert.throws(() => validateValue('PORT', '65536'), /port/);
  assert.throws(() => validateValue('SETUP_MONTHLY_BUDGET', '-1'), /nonnegative/);
  assert.throws(() => validateValue('FRED_MONTHLY_BUDGET', '3k'), /nonnegative/);
  assert.throws(() => validateValue('SETUP_TIMEZONE', 'not-a-timezone'), /timezone/);
  assert.throws(() => validateValue('GITLAB_URL', 'https://secret@gitlab.internal'), /credentials/);
  assert.throws(() => validateValue('DO_NOT_REQUIRE_SSL', 'false'), /TLS/);
  assert.doesNotThrow(() => validateValue('DO_NOT_REQUIRE_SSL', ''));
});

test('deploy creates a token vault key only for a controller without one', async () => {
  const stored = {};
  const fetcher = async (url, options) => {
    if (url.endsWith('/api/update_environment_variables')) for (const { name, value } of JSON.parse(options.body).changes) stored[name] = value;
    return new Response(JSON.stringify(url.endsWith('/api/query') ? { status: 'success', value: Object.entries(stored).map(([name, value]) => ({ name, value })) } : {}));
  };
  assert.equal(await ensureTokenKey(values, fetcher), true);
  const created = stored.FRED_TOKEN_KEY;
  assert.doesNotThrow(() => validateValue('FRED_TOKEN_KEY', created));
  assert.equal(await ensureTokenKey(values, fetcher), false);
  assert.equal(stored.FRED_TOKEN_KEY, created);
});

test('an unreachable controller reports a generic failure instead of the raw network error', async () => {
  const unreachable = async () => { throw new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.7:3210'); };
  await assert.rejects(controllerEnvironment(values, unreachable), { message: /^Controller request failed\. Check the target/ });
});
