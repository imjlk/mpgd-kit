import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const emittedRoot = realpathSync(process.env.MPGD_CI_EMIT_ROOT);
const sourceRoot = realpathSync(process.env.MPGD_CI_SOURCE_ROOT);
const esbuild = createRequire(join(sourceRoot, 'packages/cli/package.json'))('esbuild');

function emittedRelativePath(url) {
  if (!url?.startsWith('file:')) return undefined;
  const path = relative(emittedRoot, fileURLToPath(url));
  return path.startsWith('..') || isAbsolute(path) ? undefined : path;
}

export async function resolve(specifier, context, nextResolve) {
  const relativeParent = emittedRelativePath(context.parentURL);
  if (relativeParent === undefined) return nextResolve(specifier, context);
  const emittedParent = fileURLToPath(context.parentURL);
  const sourceParent = join(sourceRoot, relativeParent);

  if (specifier.startsWith('.')) {
    // ttsc preserves extensionless relative imports. First use transformed
    // output, then authored/generated JS that was not part of the TS emit.
    for (const root of [dirname(emittedParent), dirname(sourceParent)]) {
      const target = resolvePath(root, specifier);
      for (const candidate of [target, `${target}.js`, join(target, 'index.js')]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
  } else if (!specifier.startsWith('node:')) {
    // Resolve package imports from the original workspace package; its local
    // node_modules may contain dependencies absent from the monorepo root.
    const fromSource = { ...context, parentURL: pathToFileURL(sourceParent).href };
    try {
      return await nextResolve(specifier, fromSource);
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      try {
        return { url: pathToFileURL(createRequire(sourceParent).resolve(specifier)).href, shortCircuit: true };
      } catch {
        throw error;
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const relativePath = emittedRelativePath(url);
  if (relativePath === undefined || result.format !== 'module') return result;
  const source = String(result.source);
  if (!source.includes('import.meta.url')) return result;
  const originalJs = join(sourceRoot, relativePath);
  const originalTs = originalJs.replace(/\.js$/, '.ts');
  const original = existsSync(originalTs) ? originalTs : originalJs;
  // AST-based replacement leaves embedded JS fixture strings untouched.
  const transformed = esbuild.transformSync(source, {
    loader: 'js',
    format: 'esm',
    target: 'esnext',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(original).href) },
  });
  return { ...result, source: transformed.code, shortCircuit: true };
}
