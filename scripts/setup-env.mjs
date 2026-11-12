import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export const destinations = {
  backend: 'apps/controller/self-hosted/.env',
  deployment: 'apps/controller/.env.local',
  controller: 'apps/controller/.env.runtime',
  worker: 'apps/worker/.env',
};
const backendKeys = ['REV', 'DASHBOARD_REV', 'INSTANCE_SECRET', 'INSTANCE_NAME', 'PORT', 'SITE_PROXY_PORT', 'DASHBOARD_PORT', 'POSTGRES_URL', 'DISABLE_BEACON', 'CONVEX_CLOUD_ORIGIN', 'CONVEX_SITE_ORIGIN', 'NEXT_PUBLIC_DEPLOYMENT_URL', 'APPLICATION_MAX_CONCURRENT_MUTATIONS', 'APPLICATION_MAX_CONCURRENT_NODE_ACTIONS', 'APPLICATION_MAX_CONCURRENT_QUERIES', 'APPLICATION_MAX_CONCURRENT_V8_ACTIONS', 'DISABLE_METRICS_ENDPOINT', 'DOCUMENT_RETENTION_DELAY', 'DO_NOT_REQUIRE_SSL', 'RUST_LOG'];
const deploymentKeys = ['CONVEX_SELF_HOSTED_URL', 'CONVEX_SELF_HOSTED_ADMIN_KEY'];
// Controller variables both the wizard and the Docker deploy job set. The wizard adds FRED_TOKEN_KEY, which the deploy job only creates
// through ensureTokenKey. The deploy job adds ADMIN_SECRET from its .env; the wizard never asks for it, so it must not carry a copy that
// could undo a rotation.
export const controllerSettingKeys = ['WORKER_SECRET', 'GITLAB_WEBHOOK_SECRET', 'GITLAB_URL', 'BOT_USER_IDS_OTHER'];
const controllerKeys = [...controllerSettingKeys, 'FRED_TOKEN_KEY'];
const workerKeys = ['CONVEX_URL', 'WORKER_SECRET', 'GITLAB_URL', 'OPENROUTER_API_TOKEN', 'WORKER_MODE', 'WORKER_FIXTURE_PROJECT_IDS', 'AI_REVIEW_LIVE', 'WORKER_CONCURRENCY'];

const workerDirectory = fileURLToPath(new URL('../apps/worker/', import.meta.url));

// Loads the installed worker's TypeScript without launching its services or calling providers.
function workerScript(code, input) {
  const require = createRequire(join(workerDirectory, 'package.json'));
  let loader;
  try { loader = require.resolve('tsx/esm'); } catch { throw new Error('Install workspace dependencies with pnpm install before setup'); }
  return spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', code], { cwd: workerDirectory, input, encoding: 'utf8' });
}

// Reads dotenv as data. Existing files are never sourced or evaluated by a shell.
export function readEnv(path) {
  if (!existsSync(path)) return {};
  if (!lstatSync(path).isFile()) throw new Error(`Refusing a non-regular configuration file: ${path}`);
  return parseEnv(readFileSync(path, 'utf8'));
}

// Draft values are single-line literal strings, including hashes, quotes, and dollar signs.
export function readDraft(path) {
  return Object.fromEntries(readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf('=');
    if (at < 1) throw new Error('Invalid setup draft');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}

export function validateValue(key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${key}: use a single line without control characters`);
  if (value.includes("'")) throw new Error(`${key}: single quotes are not supported in setup values`);
  if (!value) return;
  if (['CONVEX_SELF_HOSTED_URL', 'CONVEX_URL', 'GITLAB_URL', 'CONVEX_CLOUD_ORIGIN', 'CONVEX_SITE_ORIGIN', 'NEXT_PUBLIC_DEPLOYMENT_URL', 'SETUP_DASHBOARD_URL', 'SETUP_SITE_URL'].includes(key)) {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${key}: enter a full HTTP(S) URL`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${key}: use HTTP(S), without embedded credentials, query, or fragment`);
    if (key !== 'GITLAB_URL' && /(^|\.)convex\.(cloud|site)$/i.test(url.hostname)) throw new Error(`${key}: Convex Cloud is not supported`);
  }
  if (['PORT', 'SITE_PROXY_PORT', 'DASHBOARD_PORT'].includes(key) && (!/^\d+$/.test(value) || +value < 1 || +value > 65535)) throw new Error(`${key}: enter a port from 1 to 65535`);
  if ((key.startsWith('APPLICATION_MAX_CONCURRENT_') || key === 'DOCUMENT_RETENTION_DELAY') && (!/^\d+$/.test(value) || !Number.isSafeInteger(+value) || +value < (key === 'DOCUMENT_RETENTION_DELAY' ? 0 : 1))) throw new Error(`${key}: enter a valid integer`);
  if (key === 'DISABLE_METRICS_ENDPOINT' && !['true', 'false'].includes(value)) throw new Error(`${key}: enter true or false`);
  if (key === 'DO_NOT_REQUIRE_SSL' && !['1', 'true'].includes(value)) throw new Error(`${key}: use true to allow database connections without TLS, or clear the value to require TLS`);
  if (key === 'WORKER_CONCURRENCY' && (!/^\d+$/.test(value) || !Number.isSafeInteger(+value) || +value < 1)) throw new Error(`${key}: enter a positive integer`);
  if (['BOT_USER_IDS_OTHER', 'WORKER_FIXTURE_PROJECT_IDS'].includes(key) && value && !/^\d+(\s*,\s*\d+)*$/.test(value)) throw new Error(`${key}: enter comma-separated numeric IDs`);
  if (key === 'INSTANCE_SECRET' && !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error(`${key}: expected 64 hex characters`);
  if (key === 'WORKER_MODE' && !['fixture', 'service'].includes(value)) throw new Error(`${key}: choose fixture or service`);
  if (key === 'SETUP_BACKEND' && !['existing', 'local'].includes(value)) throw new Error(`${key}: choose existing or local`);
  if (key === 'FRED_TOKEN_KEY' && (!/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, 'base64').length !== 32)) throw new Error(`${key}: expected 32 random bytes in base64, such as openssl rand -base64 32 prints`);
  if (['SETUP_MONTHLY_BUDGET', 'FRED_MONTHLY_BUDGET'].includes(key) && (!Number.isFinite(+value) || +value < 0)) throw new Error(`${key}: enter a nonnegative USD amount`);
  if (['SETUP_TIMEZONE', 'FRED_TIMEZONE'].includes(key)) { try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { throw new Error(`${key}: enter an IANA timezone, such as Europe/Berlin`); } }
}

// Quotes for both Node dotenv and Docker Compose without expanding shell expressions.
export function renderEnv(values) {
  return Object.entries(values).map(([key, value]) => {
    validateValue(key, value);
    if (parseEnv(`${key}='${value}'`)[key] !== value) throw new Error(`${key}: value cannot be represented losslessly in dotenv`);
    return `${key}='${value}'\n`;
  }).join('');
}

// Replaces a configuration file atomically, retaining unrelated values and restricting access to its owner.
export function saveEnv(path, updates) {
  const existing = readEnv(path);
  const text = renderEnv({ ...existing, ...updates });
  const temporary = `${path}.setup-${randomBytes(6).toString('hex')}`;
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function outputs(draft) {
  const pick = (keys) => Object.fromEntries(keys.filter((key) => draft[key] !== undefined).map((key) => [key, draft[key]]));
  return { backend: pick(backendKeys), deployment: pick(deploymentKeys), controller: pick(controllerKeys), worker: pick(workerKeys) };
}

const requestFailed = 'Controller request failed. Check the target, credentials, and network.';

// Makes explicit-target, bounded requests. Neither admin nor bot credentials follow redirects. Transport and parse failures
// reject with one generic message, so raw network errors never reach the terminal.
export async function request(url, headers, body, transport = fetch) {
  let response, text;
  try {
    response = await transport(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(10000) });
    text = await response.text();
  } catch (cause) { throw new Error(requestFailed, { cause }); }
  if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}`);
  try { return text ? JSON.parse(text) : undefined; } catch (cause) { throw new Error(requestFailed, { cause }); }
}

// Calls the self-hosted deployment API the installed Convex CLI uses, at `target.CONVEX_SELF_HOSTED_URL` with its admin key.
function deploymentApi(target, path, body, transport) {
  validateValue('CONVEX_SELF_HOSTED_URL', target.CONVEX_SELF_HOSTED_URL);
  return request(`${target.CONVEX_SELF_HOSTED_URL.replace(/\/$/, '')}/api/${path}`, { Authorization: `Convex ${target.CONVEX_SELF_HOSTED_ADMIN_KEY}` }, body, transport);
}

// Reads the controller's environment variables without printing their values.
export async function controllerEnvironment(target, transport = fetch) {
  const result = await deploymentApi(target, 'query', { path: '_system/cli/queryEnvironmentVariables', args: [{}], format: 'convex_encoded_json' }, transport);
  if (result?.status !== 'success' || !Array.isArray(result.value) || result.value.some((item) => typeof item?.name !== 'string' || typeof item?.value !== 'string')) throw new Error('Controller environment could not be read; verify URL and admin key');
  return Object.fromEntries(result.value.map(({ name, value }) => [name, value]));
}

// Sets each `{ name, value }` change on the controller; a null value removes the variable.
export function updateControllerEnvironment(target, changes, transport = fetch) {
  return deploymentApi(target, 'update_environment_variables', { changes }, transport);
}

// Writes and confirms the controller runtime variables. Throws when the controller already holds a different FRED_TOKEN_KEY.
export async function applyController(draft, transport = fetch) {
  const values = outputs(draft).controller;
  const current = await controllerEnvironment(draft, transport);
  if (current.FRED_TOKEN_KEY && current.FRED_TOKEN_KEY !== values.FRED_TOKEN_KEY) throw new Error('FRED_TOKEN_KEY differs from the controller value; load existing controller settings first so saved project tokens stay readable');
  await updateControllerEnvironment(draft, Object.entries(values).map(([name, value]) => ({ name, value })), transport);
  const stored = await controllerEnvironment(draft, transport);
  if (Object.entries(values).some(([key, value]) => stored[key] !== value)) throw new Error('Controller did not confirm all saved values; rerun setup to retry');
}

// Creates FRED_TOKEN_KEY on the controller when it has none and never replaces an existing one. Returns whether it created a key.
export async function ensureTokenKey(draft, transport = fetch) {
  if ((await controllerEnvironment(draft, transport)).FRED_TOKEN_KEY) return false;
  await updateControllerEnvironment(draft, [{ name: 'FRED_TOKEN_KEY', value: randomBytes(32).toString('base64') }], transport);
  if (!(await controllerEnvironment(draft, transport)).FRED_TOKEN_KEY) throw new Error('Controller did not confirm FRED_TOKEN_KEY');
  return true;
}

async function main([command, root, draftPath, ...args]) {
  const draft = draftPath && existsSync(draftPath) ? readDraft(draftPath) : {};
  if (command === 'init') {
    const defaults = { DO_NOT_REQUIRE_SSL: 'true', ...readEnv(join(root, 'apps/controller/self-hosted/.env.example')), ...readEnv(join(root, 'apps/worker/.env.example')), SETUP_BACKEND: 'existing', BOT_USER_IDS_OTHER: '' };
    const sources = Object.values(destinations).map((path) => readEnv(join(root, path)));
    const conflicts = Object.keys(sources[2]).filter((key) => sources[3][key] !== undefined && sources[2][key] !== sources[3][key]);
    if (conflicts.length) console.error(`Shared values differ in saved controller and worker files: ${conflicts.join(', ')}. The worker values are offered initially; loading controller values replaces them.`);
    const values = { ...defaults, ...Object.assign({}, ...sources) };
    writeFileSync(draftPath, Object.entries(values).map(([key, value]) => { validateValue(key, value); return `${key}=${value}\n`; }).join(''), { mode: 0o600 });
  } else if (command === 'validate') {
    const value = readFileSync(0, 'utf8');
    validateValue(args[0], value);
  } else if (command === 'import-controller') {
    const values = await controllerEnvironment(draft);
    for (const [key, value] of Object.entries(values)) if (controllerKeys.includes(key)) { validateValue(key, value); draft[key] = value; }
    writeFileSync(draftPath, Object.entries(draft).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
    console.log('Loaded controller values without displaying secrets.');
  } else if (command === 'save') {
    const files = outputs(draft);
    for (const name of args.length ? args : ['deployment', 'controller', 'worker']) saveEnv(join(root, destinations[name]), files[name]);
  } else if (command === 'apply') {
    await applyController(draft);
    console.log('Controller runtime variables applied.');
  } else if (command === 'check') {
    const required = [...deploymentKeys, 'WORKER_SECRET', 'GITLAB_WEBHOOK_SECRET', 'GITLAB_URL', 'FRED_TOKEN_KEY'];
    for (const key of required) if (!draft[key]) throw new Error(`${key}: required value is missing`);
    for (const [key, value] of Object.entries(draft)) validateValue(key, value);
    const result = workerScript(
      'import {readFileSync} from "node:fs"; import {Effect} from "effect"; import {readConfig} from "./src/config.ts"; const env=JSON.parse(readFileSync(0,"utf8")); Effect.runPromise(readConfig(env)).catch(e=>{console.error(e.message);process.exitCode=1})',
      JSON.stringify({ ...outputs(draft).worker, ...(draft.WORKER_MODE === 'fixture' && !draft.AI_REVIEW_LIVE ? { AI_REVIEW_LIVE: '1' } : {}) }));
    if (result.status !== 0) { process.stderr.write(result.stderr || 'Worker configuration validation failed.\n'); process.exitCode = 1; }
    else {
      console.log('Worker settings checked against the runtime schema. OpenRouter access and project permissions still need the supervised pilot.');
      if (draft.WORKER_MODE === 'fixture' && !draft.AI_REVIEW_LIVE) console.log('Fixture startup remains disabled until you set AI_REVIEW_LIVE=1.');
    }
  } else if (command === 'initial-settings') {
    console.log(JSON.stringify({ globalEnabled: false, defaultBudgetUsd: +(draft.SETUP_MONTHLY_BUDGET || 3000), orgTimezone: draft.SETUP_TIMEZONE || 'Europe/Berlin' }));
  } else if (command === 'summary') {
    for (const [name, values] of Object.entries(outputs(draft))) {
      if (args.length && !args.includes(name)) continue;
      if (name === 'backend' && draft.SETUP_BACKEND !== 'local') continue;
      console.log(`\n${destinations[name]}`);
      for (const [key, value] of Object.entries(values)) console.log(`  ${key}: ${/KEY|TOKEN|SECRET|POSTGRES_URL/.test(key) ? (value ? '[set, hidden]' : '[empty]') : value || '[empty]'}`);
    }
  } else throw new Error('Unknown setup operation');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
