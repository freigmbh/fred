import { spawnSync } from 'node:child_process';

// MR title types from CONTRIBUTING.md. Squash merges carry the title onto main, where it drives the version and release notes.
export const changeTypes = ['feat', 'fix', 'perf', 'refactor', 'chore', 'docs', 'test'];
const conventionalTitle = /^(?<type>[a-z]+)(?:\([^()\s]+\))?(?<breaking>!)?: \S/;
const draftPrefix = /^(?:Draft:|\[Draft\]|\(Draft\))\s*/i;
const releaseTag = /^v(\d+)\.(\d+)\.(\d+)$/;
const semver = /^\d+\.\d+\.\d+$/;
// The SemVer 2.0.0 grammar the worker accepts for FRED_VERSION, covering dev prereleases such as 0.3.2-dev.4+g1a2b3c4.
const semverGrammar = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

// Reads an MR or commit title. Returns undefined when it does not follow CONTRIBUTING.md. GitLab's revert titles count as patches.
export function parseTitle(title) {
  const text = title.trim().replace(draftPrefix, '');
  if (/^Revert ".+"$/.test(text)) return { type: 'revert', breaking: false };
  const match = conventionalTitle.exec(text);
  if (!match || !changeTypes.includes(match.groups.type)) return undefined;
  return { type: match.groups.type, breaking: Boolean(match.groups.breaking) };
}

// Picks the version after `previous` for the given changes. Before 1.0.0 breaking changes bump the minor version, so only a hand-cut tag reaches 1.0.0.
export function nextVersion(previous, changes) {
  const [major, minor, patch] = previous.split('.').map(Number);
  const breaking = changes.some((change) => change.breaking);
  if (breaking && major > 0) return `${major + 1}.0.0`;
  if (breaking || changes.some((change) => change.type === 'feat')) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const compareVersions = (a, b) => {
  const [x, y] = [a, b].map((tag) => releaseTag.exec(tag).slice(1).map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

// Runs git in `cwd` and returns its exit status and trimmed output.
export function gitIn(cwd) {
  return (args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout.trim() };
  };
}

const output = (git, args) => {
  const result = git(args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed with status ${result.status}`);
  return result.stdout;
};

// Lists the first-parent changes in `range`, oldest first. Merge commits take the MR title, reference, and the squashed author from GitLab's merge message.
export function collectChanges(git, range) {
  const log = output(git, ['log', '--first-parent', '--reverse', '--format=%H%x1f%P%x1f%an%x1f%B%x1e', range]);
  return log.split('\x1e').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [, parents, author, body] = entry.split('\x1f');
    const lines = body.trim().split('\n');
    const merged = parents.split(' ')[1];
    const title = (merged ? lines.slice(1).find((line) => line.trim()) ?? lines[0] : lines[0]).trim();
    return {
      title,
      ...(parseTitle(title) ?? { type: 'other', breaking: false }),
      author: merged ? output(git, ['log', '-1', '--format=%an', merged]) : author,
      mr: /See merge request \S*?(![0-9]+)/.exec(body)?.[1],
    };
  });
}

// Release tags oldest first, or with `['--merged', 'HEAD']` only those HEAD contains.
const releaseTags = (git, filter = []) => output(git, ['tag', '--list', 'v*', ...filter]).split('\n').filter((tag) => releaseTag.test(tag)).sort(compareVersions);

// The checkout's version for `pnpm fred --version`: its release tag, or the next version as a dev prerelease, such as
// 0.3.2-dev.4+g1a2b3c4 four changes past v0.3.1. Uncommitted changes add `.dirty` to the build metadata.
export function describeVersion(git) {
  const previous = releaseTags(git, ['--merged', 'HEAD']).at(-1);
  const changes = collectChanges(git, previous ? `${previous}..HEAD` : 'HEAD');
  const dirty = output(git, ['status', '--porcelain']) ? '.dirty' : '';
  if (previous && !changes.length && !dirty) return previous.slice(1);
  const next = previous ? nextVersion(previous.slice(1), changes) : '0.1.0';
  return `${next}-dev.${changes.length}+g${output(git, ['rev-parse', '--short=7', 'HEAD'])}${dirty}`;
}

/**
 * Plans the release for HEAD. Every deploy before 1.0.0 is a release.
 * - `stale`: a newer release already contains HEAD's successor, so this deploy must not run.
 * - When HEAD already carries the newest tag, the plan repeats that version with its original changes, so a retry can
 *   finish a publication that created the tag but not its Release.
 */
export function planRelease(git) {
  const tags = releaseTags(git);
  const newest = tags.at(-1);
  if (!newest) return { version: '0.1.0', changes: [] };
  if (git(['merge-base', '--is-ancestor', newest, 'HEAD']).status !== 0) return { stale: true, previous: newest };
  const changes = collectChanges(git, `${newest}..HEAD`);
  if (changes.length) return { version: nextVersion(newest.slice(1), changes), previous: newest, changes };
  const previous = tags.at(-2);
  return { version: newest.slice(1), previous, changes: previous ? collectChanges(git, `${previous}..HEAD`) : [] };
}

const sections = [
  ['Breaking changes', (change) => change.breaking],
  ['Features', (change) => change.type === 'feat'],
  ['Fixes', (change) => change.type === 'fix' || change.type === 'perf' || change.type === 'revert'],
  ['Other changes', () => true],
];

// Renders the admin UI's version.json, which carries the version to the browser. Throws unless the version is one the worker accepts.
export function uiVersionJson(version) {
  if (!semverGrammar.test(version)) throw new Error(`FRED_VERSION must be a SemVer 2.0.0 version such as 1.2.3, not ${JSON.stringify(version)}`);
  return `${JSON.stringify({ version })}\n`;
}

// Reads the release.json the deploy job stamps into release.tar.gz and checks it belongs to the deployed commit.
export function releaseStamp(json, sha) {
  const stamp = JSON.parse(json);
  if (!semver.test(stamp.version ?? '') || stamp.sha !== sha) throw new Error(`release.json does not stamp a version for ${sha}`);
  return stamp;
}

// Renders GitLab release notes: each change once, under the first section it matches, followed by the compare link.
export function releaseNotes({ version, previous, changes }, projectUrl) {
  if (!previous) return 'First versioned release of FRED.\n';
  let remaining = changes;
  const blocks = sections.flatMap(([heading, matches]) => {
    const listed = remaining.filter(matches);
    remaining = remaining.filter((change) => !matches(change));
    if (!listed.length) return [];
    return [`## ${heading}\n\n${listed.map((change) => `- ${change.title} by ${change.author}${change.mr ? ` in ${change.mr}` : ''}`).join('\n')}`];
  });
  return [...blocks, `**Full changelog:** ${projectUrl}/-/compare/${previous}...v${version}`].join('\n\n') + '\n';
}
