import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneReleases } from './deploy-releases.mjs';

test('pruning keeps the activated release and the newest three, and drops stale UI staging', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fred-releases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const names = ['aaa.oldest', 'bbb.old', 'ccc.mid', 'ddd.new', 'eee.newest'];
  names.forEach((name, index) => {
    const path = join(root, 'releases', name);
    mkdirSync(path, { recursive: true });
    utimesSync(path, 1_700_000_000 + index * 60, 1_700_000_000 + index * 60);
  });
  mkdirSync(join(root, 'ui-staged-abc123'));
  mkdirSync(join(root, 'ui'));
  const removed = pruneReleases(root, { current: join(root, 'releases', 'aaa.oldest') });
  assert.deepEqual(removed.sort(), [join(root, 'releases', 'bbb.old'), join(root, 'ui-staged-abc123')]);
  for (const name of ['aaa.oldest', 'ccc.mid', 'ddd.new', 'eee.newest']) assert.ok(existsSync(join(root, 'releases', name)), name);
  assert.ok(existsSync(join(root, 'ui')));
});
