try {
  const args = process.argv.slice(2);
  if (args[0] === '--version') {
    const { describeVersion, gitIn } = await import('./release.mjs');
    console.log(describeVersion(gitIn(process.cwd())));
  } else {
    const { develop, usage } = await import('./dev/index.mjs');
    if (args[0] !== 'dev') throw new Error(`Usage: pnpm fred --version\n${usage}`);
    await develop(args.slice(1));
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
