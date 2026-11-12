import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installUi } from './deploy-ui.mjs';

test('rollback restores a previous UI or removes the first installed UI', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fred-ui-rollback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const release of ['old', 'new']) {
    const dist = join(root, release, 'apps/ui/dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), release);
    writeFileSync(join(dist, `${release}.js`), release);
  }
  installUi(root, join(root, 'new'));
  assert.equal(statSync(join(root, 'ui')).mode & 0o777, 0o755);
  installUi(root, join(root, 'old'), { allowMissing: true });
  assert.equal(statSync(join(root, 'ui')).mode & 0o777, 0o755);
  assert.equal(readFileSync(join(root, 'ui/index.html'), 'utf8'), 'old');
  assert.equal(existsSync(join(root, 'ui/new.js')), false);
  installUi(root, join(root, 'new'));
  assert.equal(statSync(join(root, 'ui')).mode & 0o777, 0o755);
  installUi(root, join(root, 'legacy'), { allowMissing: true });
  assert.equal(existsSync(join(root, 'ui')), false);
});

test('a missing forward bundle fails without changing the installed UI', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fred-ui-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'ui'));
  writeFileSync(join(root, 'ui/index.html'), 'existing');
  assert.throws(() => installUi(root, join(root, 'broken')), /missing the admin UI bundle/);
  assert.equal(readFileSync(join(root, 'ui/index.html'), 'utf8'), 'existing');
});
