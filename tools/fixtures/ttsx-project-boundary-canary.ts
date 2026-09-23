// Keep this dynamic: the Vite config belongs to a different tsconfig and is
// loaded by ttsx's dependency-project path, not the entry project's emit.
const configUrl = new URL('../../examples/phaser-starter/vite.config.ts', import.meta.url);
const config = await import(configUrl.href) as { readonly default: unknown };

if (typeof config.default !== 'function') {
  throw new Error('Expected the starter Vite config factory.');
}

process.stdout.write('MPGD_PROJECT_BOUNDARY_CANARY_PASSED\n');
