import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controllerChanges } from './container-deploy.mjs';

test('controller changes set differing stack values, remove cleared ones, and leave the token key alone', () => {
  const current = { WORKER_SECRET: 'same', ADMIN_SECRET: 'old', BOT_USER_IDS_OTHER: '5', FRED_TOKEN_KEY: 'sealed', FRED_MAINTENANCE_MODE: 'true' };
  const env = { WORKER_SECRET: 'same', ADMIN_SECRET: 'new', GITLAB_WEBHOOK_SECRET: 'hook', GITLAB_URL: 'https://gitlab.example', BOT_USER_IDS_OTHER: '', FRED_TOKEN_KEY: 'other' };
  assert.deepEqual(controllerChanges(env, current), [
    { name: 'ADMIN_SECRET', value: 'new' },
    { name: 'GITLAB_WEBHOOK_SECRET', value: 'hook' },
    { name: 'GITLAB_URL', value: 'https://gitlab.example' },
    { name: 'BOT_USER_IDS_OTHER', value: null },
  ]);
  assert.deepEqual(controllerChanges({ ...current, BOT_USER_IDS_OTHER: '5' }, current), []);
});
