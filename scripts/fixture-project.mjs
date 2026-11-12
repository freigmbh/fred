import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Builds a temporary Convex project from the controller's functions plus one module from apps/controller/fixtures, such as
// `dev` or `e2e`, and drives the controller's Convex CLI against the disposable self-hosted backend at `url`.
// Call `remove()` when done. CLI failures reject with their stdout and stderr attached.
export async function fixtureProject(root, fixture, { url, adminKey }) {
  const controller = join(root, 'apps/controller');
  const directory = await mkdtemp(join(tmpdir(), `fred-${fixture}-controller-`));
  await cp(join(controller, 'convex'), join(directory, 'convex'), { recursive: true, filter: (path) => !path.endsWith('.test.ts') && !path.endsWith('test.setup.ts') });
  await cp(join(controller, 'fixtures', `${fixture}.ts`), join(directory, 'convex', `${fixture}.ts`));
  await cp(join(controller, 'package.json'), join(directory, 'package.json'));
  await symlink(join(controller, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'convex.json'), JSON.stringify({ functions: 'convex/' }));
  // Outside the checkout, TypeScript finds the workspace's @types only through typeRoots.
  await writeFile(join(directory, 'convex/tsconfig.json'), JSON.stringify({ extends: join(controller, 'tsconfig.json'),
    compilerOptions: { typeRoots: [join(root, 'node_modules/@types')] }, include: ['.'] }));
  // CI=1 keeps the Convex CLI's Sentry reporting off, the only egress it would add.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1', CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey };
  const convex = (...args) => exec(process.execPath, [join(controller, 'node_modules/convex/bin/main.js'), ...args], { cwd: directory, env, maxBuffer: 2 * 1024 * 1024 });
  return {
    // Sets `variables` on the backend, then pushes the functions. `typecheck` is the CLI's `enable` or `disable`.
    async deploy(variables, typecheck) {
      for (const [name, value] of Object.entries(variables)) await convex('env', 'set', name, value);
      await convex('deploy', '--yes', '--typecheck', typecheck, '--codegen', 'disable');
    },
    run: (name, args = {}) => convex('run', name, JSON.stringify(args)),
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}
