import { existsSync, realpathSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const emitRoot = realpathSync(process.env.MPGD_CI_EMIT_ROOT);
const sourceEntry = resolve(repoRoot, process.argv[2]);
const relativeEntry = relative(repoRoot, sourceEntry);
if (relativeEntry.startsWith('..') || isAbsolute(relativeEntry) || !relativeEntry.endsWith('.ts')) {
  throw new Error(`Compiled entry must be a repository TypeScript file: ${sourceEntry}`);
}
const emittedEntry = join(emitRoot, relativeEntry.replace(/\.ts$/, '.js'));
if (!existsSync(emittedEntry)) throw new Error(`Missing CI-compiled entry: ${emittedEntry}`);

process.env.MPGD_CI_SOURCE_ROOT = repoRoot;
register(new URL('./compiled-loader.mjs', import.meta.url), import.meta.url);
// Entry guards and import.meta.url must observe the authored path, not outDir.
process.argv = [process.execPath, sourceEntry, ...process.argv.slice(3)];
await import(pathToFileURL(emittedEntry).href);
