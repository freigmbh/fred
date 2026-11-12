import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

// Decides whether a checkout path enters the snapshot. Root agent tooling (`.claude/`, `.agents/`) is not runtime source.
function included(path) {
  return !path.split('/').some((part) => ['.git', '.repos', 'node_modules', 'dist'].includes(part) ||
    ((part === '.env' || part.startsWith('.env.')) && !['.env.example', '.env.local.example'].includes(part)))
    && path !== 'release.tar.gz' && !['.claude', '.agents'].includes(path.split('/')[0]);
}

export async function snapshot(root, destination) {
  root = await realpath(root);
  const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'));
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  const hash = createHash('sha256');
  for (const path of [...new Set(paths.split('\0').filter(Boolean))].filter(included).sort()) {
    if (path.split('/').some((part) => part.startsWith('.env')) && !tracked.has(path)) continue;
    const source = join(root, path);
    let stat;
    try { stat = await lstat(source); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Source symlinks are not supported in local snapshots: ${path}`);
    const actual = await realpath(source);
    const inside = relative(root, actual);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`Source link leaves the worktree: ${path}`);
    if (!stat.isFile()) throw new Error(`Expected a source file: ${path}`);
    const content = await readFile(source);
    const mode = stat.mode & 0o111 ? 0o755 : 0o644;
    hash.update(`${path}\0${mode}\0${content.length}\0`).update(content);
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode });
  }
  return hash.digest('hex');
}
