import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeVersion, gitIn, nextVersion, parseTitle, planRelease, releaseNotes, uiVersionJson } from './release.mjs';

test('breaking changes bump the minor version before 1.0.0 and the major version after it', () => {
  const fix = { type: 'fix', breaking: false };
  const feat = { type: 'feat', breaking: false };
  const breaking = { type: 'refactor', breaking: true };
  assert.equal(nextVersion('0.3.1', [fix]), '0.3.2');
  assert.equal(nextVersion('0.3.1', [{ type: 'docs', breaking: false }]), '0.3.2');
  assert.equal(nextVersion('0.3.1', [fix, feat]), '0.4.0');
  assert.equal(nextVersion('0.3.1', [breaking]), '0.4.0');
  assert.equal(nextVersion('1.2.3', [feat]), '1.3.0');
  assert.equal(nextVersion('1.2.3', [breaking, feat]), '2.0.0');
});

test('MR titles follow CONTRIBUTING.md, ignoring the draft prefix', () => {
  assert.deepEqual(parseTitle('feat(ui)!: filter reviews by model'), { type: 'feat', breaking: true });
  assert.deepEqual(parseTitle('Draft: fix: restore lease after reconnect'), { type: 'fix', breaking: false });
  assert.deepEqual(parseTitle('Revert "feat: give every bot an avatar"'), { type: 'revert', breaking: false });
  assert.equal(parseTitle('Update the README'), undefined);
  assert.equal(parseTitle('feature: filter reviews'), undefined);
  assert.equal(parseTitle('fix:missing space'), undefined);
});

test('a deploy releases the merged MRs since the newest tag, repeats a tagged release, and refuses a superseded commit', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fred-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const commit = (message, author) => {
    writeFileSync(join(directory, 'file'), `${message}\n`);
    git('add', 'file');
    git('-c', `user.name=${author}`, '-c', 'user.email=dev@example.com', 'commit', '-q', '-m', message);
  };
  // Squash merge as GitLab does it: the MR author's squashed commit, merged with GitLab's default merge message.
  const merge = (branch, title, author, iid) => {
    git('checkout', '-q', '-b', branch, 'main');
    commit(title, author);
    git('checkout', '-q', 'main');
    git('-c', 'user.name=Merger', '-c', 'user.email=merger@example.com', 'merge', '-q', '--no-ff', branch,
      '-m', `Merge branch '${branch}' into 'main'`, '-m', title, '-m', `See merge request shed/FRED!${iid}`);
  };
  git('init', '-q', '-b', 'main');
  commit('chore: start', 'Ada');
  assert.deepEqual(planRelease(gitIn(directory)), { version: '0.1.0', changes: [] });
  git('tag', 'v0.1.0');
  merge('fix/lease', 'fix(worker): restore lease after reconnect', 'Ada', 7);
  const superseded = git('rev-parse', 'HEAD');
  merge('feat/filter', 'feat(ui): filter reviews by model', 'Grace', 8);

  const plan = planRelease(gitIn(directory));
  assert.equal(plan.version, '0.2.0');
  assert.equal(releaseNotes(plan, 'https://gitlab.example/shed/FRED'), [
    '## Features\n\n- feat(ui): filter reviews by model by Grace in !8',
    '## Fixes\n\n- fix(worker): restore lease after reconnect by Ada in !7',
    '**Full changelog:** https://gitlab.example/shed/FRED/-/compare/v0.1.0...v0.2.0\n',
  ].join('\n\n'));
  assert.match(describeVersion(gitIn(directory)), /^0\.2\.0-dev\.2\+g[0-9a-f]{7,}$/);

  git('tag', 'v0.2.0');
  const repeated = planRelease(gitIn(directory));
  assert.equal(releaseNotes(repeated, 'https://gitlab.example/shed/FRED'), releaseNotes(plan, 'https://gitlab.example/shed/FRED'));
  git('checkout', '-q', superseded);
  assert.deepEqual(planRelease(gitIn(directory)), { stale: true, previous: 'v0.2.0' });
});

test('the admin UI version takes the versions the worker accepts and refuses a tag name', () => {
  assert.equal(uiVersionJson('0.3.2-dev.4+g1a2b3c4'), '{"version":"0.3.2-dev.4+g1a2b3c4"}\n');
  assert.throws(() => uiVersionJson('v1.2.3'), /SemVer/);
});
