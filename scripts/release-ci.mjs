import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { changeTypes, gitIn, parseTitle, planRelease, releaseNotes } from './release.mjs';

// GitLab CI steps of a release. `node scripts/release-ci.mjs <command>`:
// - lint-title: fails an MR pipeline whose title cannot become a release-notes line.
// - prepare: plans the deploy's version, stamps release.json into release.tar.gz, and writes release-notes.md. Fails without
//   deploying when a newer release already contains this commit, so GitLab never records it as the pilot's deployment.
// - publish: after a verified deploy, stores release.tar.gz in the package registry and creates the tag and GitLab Release.
//   Does nothing when the Release exists, so a retry finishes a partial publication.
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run this inside GitLab CI`);
  return value;
};

function lintTitle() {
  const title = env('CI_MERGE_REQUEST_TITLE');
  if (parseTitle(title)) return console.log(`MR title follows CONTRIBUTING.md: ${title}`);
  throw new Error(`MR title "${title}" must read <type>(<scope>): <summary> with type ${changeTypes.join(', ')}. Mark breaking changes with ! before the colon. Edit the title, then rerun the pipeline.`);
}

function prepare() {
  const plan = planRelease(gitIn(process.cwd()));
  if (plan.stale) throw new Error(`Nothing deployed: ${plan.previous} is newer and already contains this commit. To roll back, run a pipeline on a release tag.`);
  writeFileSync('release.json', `${JSON.stringify({ version: plan.version, sha: env('CI_COMMIT_SHA') })}\n`);
  execFileSync('gunzip', ['release.tar.gz']);
  execFileSync('tar', ['-rf', 'release.tar', 'release.json']);
  execFileSync('gzip', ['release.tar']);
  writeFileSync('release-notes.md', releaseNotes(plan, env('CI_PROJECT_URL')));
  console.log(plan.previous ? `Deploying v${plan.version} with ${plan.changes.length} changes since ${plan.previous}.` : `Deploying v${plan.version}, the first versioned release.`);
}

// Calls the project's GitLab API with the job token. A status in `accepted` other than 2xx is returned instead of thrown.
async function gitlab(path, init, accepted = []) {
  const response = await fetch(`${env('CI_API_V4_URL')}/projects/${env('CI_PROJECT_ID')}${path}`, { ...init, headers: { 'JOB-TOKEN': env('CI_JOB_TOKEN'), ...init.headers } });
  if (!response.ok && !accepted.includes(response.status)) throw new Error(`GitLab ${init.method} ${path} failed with ${response.status}: ${await response.text()}`);
  return response.status;
}

async function publish() {
  const { version, sha } = JSON.parse(readFileSync('release.json', 'utf8'));
  const tag = `v${version}`;
  if (await gitlab(`/releases/${tag}`, { method: 'GET' }, [404]) !== 404) return console.log(`${tag} is already released; nothing to publish.`);
  const packagePath = `/packages/generic/fred/${version}/release.tar.gz`;
  await gitlab(packagePath, { method: 'PUT', body: readFileSync('release.tar.gz') });
  await gitlab('/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: tag, tag_name: tag, ref: sha, description: readFileSync('release-notes.md', 'utf8'),
      assets: { links: [{ name: 'release.tar.gz', url: `${env('CI_API_V4_URL')}/projects/${env('CI_PROJECT_ID')}${packagePath}`, link_type: 'package' }] },
    }),
  });
  console.log(`Released ${tag}: ${env('CI_PROJECT_URL')}/-/releases/${tag}`);
}

const commands = { 'lint-title': lintTitle, prepare, publish };
try {
  const command = commands[process.argv[2]];
  if (!command) throw new Error(`Usage: node scripts/release-ci.mjs ${Object.keys(commands).join('|')}`);
  await command();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
