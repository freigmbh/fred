import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controllerEnvironment, controllerSettingKeys, ensureTokenKey, updateControllerEnvironment, validateValue } from './setup-env.mjs';

const stackControllerKeys = ['ADMIN_SECRET', ...controllerSettingKeys];

export function controllerChanges(env, current) {
  return stackControllerKeys.flatMap((name) => {
    const value = env[name] || null;
    return value === (current[name] ?? null) ? [] : [{ name, value }];
  });
}

function convex(args, env) {
  const result = spawnSync('fred', ['convex', ...args], {
    stdio: 'inherit',
    env: { PATH: env.PATH, HOME: env.HOME, CONVEX_SELF_HOSTED_URL: env.CONVEX_SELF_HOSTED_URL, FRED_ADMIN_KEY_FILE: env.FRED_ADMIN_KEY_FILE },
  });
  if (result.status !== 0) throw new Error(`convex ${args[0]} failed with status ${result.status}`);
}

async function deploy(env) {
  validateValue('FRED_MONTHLY_BUDGET', env.FRED_MONTHLY_BUDGET);
  validateValue('FRED_TIMEZONE', env.FRED_TIMEZONE);
  const target = { CONVEX_SELF_HOSTED_URL: env.CONVEX_SELF_HOSTED_URL, CONVEX_SELF_HOSTED_ADMIN_KEY: readFileSync(env.FRED_ADMIN_KEY_FILE, 'utf8').trim() };
  if (await ensureTokenKey(target)) console.log('Created FRED_TOKEN_KEY on the controller for project access tokens.');
  const changes = controllerChanges(env, await controllerEnvironment(target));
  if (changes.length) {
    await updateControllerEnvironment(target, changes);
    console.log(`Updated controller variables: ${changes.map(({ name }) => name).join(', ')}.`);
  }
  convex(['deploy', '--yes', '--codegen', 'disable'], env);
  convex(['run', 'settings:ensure', JSON.stringify({ defaultBudgetUsd: Number(env.FRED_MONTHLY_BUDGET), orgTimezone: env.FRED_TIMEZONE })], env);
  console.log(`Controller deployed${env.FRED_VERSION ? ` at v${env.FRED_VERSION}` : ''}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deploy(process.env).catch((error) => {
    console.error(`Controller deploy failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
