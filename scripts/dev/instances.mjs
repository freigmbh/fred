import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function exists(path) {
  return access(path).then(() => true, () => false);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export async function planClean(stateRoot) {
  const plan = { remove: [], skipped: [] };
  let names;
  try { names = await readdir(stateRoot); }
  catch (error) { if (error.code === 'ENOENT') return plan; throw error; }
  for (const instance of names.sort()) {
    const directory = join(stateRoot, instance);
    const metadata = await readJson(join(directory, 'instance.json'));
    if (!metadata?.sourceRoot) { plan.skipped.push({ instance, directory, reason: 'no recorded worktree' }); continue; }
    if (await exists(metadata.sourceRoot)) continue;
    const pid = Number(await readFile(join(directory, 'lock', 'pid'), 'utf8').catch(() => ''));
    if (pid && alive(pid)) { plan.skipped.push({ instance, directory, sourceRoot: metadata.sourceRoot, reason: `owned by process ${pid}` }); continue; }
    plan.remove.push({ instance, directory, sourceRoot: metadata.sourceRoot, reason: 'worktree missing' });
  }
  return plan;
}
