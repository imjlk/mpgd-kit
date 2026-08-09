import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { build, type Plugin } from 'esbuild';

export const defaultOfflinePlaytestArtifactDir = 'artifacts/web-preview';
export const defaultOfflinePlaytestOutputDir = 'artifacts/offline-playtest';
export const defaultOfflinePlaytestMaximumBytes = 25 * 1024 * 1024;
export const offlinePlaytestSchemaVersion = '1';

export interface RunOfflinePlaytestPackagingInput {
  readonly gameRoot: string;
  readonly artifactDir?: string;
  readonly outputDir?: string;
  readonly maximumBytes?: number;
}

export interface OfflinePlaytestEvidence {
  readonly schemaVersion: typeof offlinePlaytestSchemaVersion;
  readonly purpose: 'test-play-only';
  readonly releaseTarget: false;
  readonly sourceTarget: 'web-preview';
  readonly sourceRuntime: 'web-preview';
  readonly networkPolicy: 'deny-network';
  readonly entryFile: 'index.html';
  readonly bytes: number;
  readonly sha256: string;
  readonly inlinedAssetCount: number;
  readonly limitations: readonly string[];
}

export interface RunOfflinePlaytestPackagingResult {
  readonly outputDir: string;
  readonly entryFile: string;
  readonly readmeFile: string;
  readonly evidenceFile: string;
  readonly evidence: OfflinePlaytestEvidence;
}

interface EffectivePreviewIdentity {
  readonly target: 'web-preview';
  readonly runtime: 'web-preview';
}

interface InliningContext {
  readonly artifactRoot: string;
  readonly assetDirectories: readonly string[];
  readonly inlinedAssets: Set<string>;
  readonly maximumBytes: number;
}

interface BundledEntry {
  readonly script: string;
  readonly stylesheet?: string;
}

const effectiveTargetConfigFileName = 'mpgd-effective-target.json';
const offlinePlaytestOutputFiles = new Set(['README.txt', 'index.html', 'offline-playtest.json']);
const noModuleAttributePattern = /(?:^|\s)nomodule(?=\s|=|$)/iu;
const javascriptScriptTypes = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-javascript',
  'module',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-javascript',
]);
const javascriptRegexPrefixKeywords = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);
const javascriptControlParenthesisKeywords = new Set([
  'catch',
  'for',
  'if',
  'switch',
  'while',
  'with',
]);
const javascriptBlockKeywords = new Set(['do', 'else', 'finally', 'try']);
const htmlAssetAttributesByTag: Readonly<Record<string, readonly string[]>> = {
  audio: ['src'],
  embed: ['src'],
  feimage: ['href', 'xlink:href'],
  image: ['href', 'xlink:href'],
  img: ['src', 'srcset'],
  input: ['src'],
  object: ['data'],
  source: ['src', 'srcset'],
  track: ['src'],
  use: ['href', 'xlink:href'],
  video: ['src', 'poster'],
};
const offlinePlaytestLimitations = [
  'Server-backed identity, purchases, ads, rewards, leaderboards, and cloud saves are unavailable.',
  'Browser storage opened from file:// is browser-dependent and best-effort only.',
  'Workers, service workers, WebAssembly streaming, and runtime-computed asset URLs are unsupported. Non-streaming embedded WebAssembly is allowed.',
  'glTF files must be self-contained with data URIs; otherwise use a GLB file.',
  'CSS @import rules are unsupported; include those rules in the built stylesheet before packaging.',
] as const;

const mimeTypes = new Map<string, string>([
  ['.aac', 'audio/aac'],
  ['.atlas', 'text/plain'],
  ['.avif', 'image/avif'],
  ['.bin', 'application/octet-stream'],
  ['.csv', 'text/csv'],
  ['.eot', 'application/vnd.ms-fontobject'],
  ['.fnt', 'text/plain'],
  ['.gif', 'image/gif'],
  ['.glb', 'model/gltf-binary'],
  ['.glsl', 'text/plain'],
  ['.gltf', 'model/gltf+json'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json'],
  ['.m4a', 'audio/mp4'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.ogv', 'video/ogg'],
  ['.otf', 'font/otf'],
  ['.opus', 'audio/opus'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain'],
  ['.wav', 'audio/wav'],
  ['.wasm', 'application/wasm'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml'],
]);

export async function runOfflinePlaytestPackaging(
  input: RunOfflinePlaytestPackagingInput,
): Promise<RunOfflinePlaytestPackagingResult> {
  const gameRoot = realpathDirectory(input.gameRoot, 'game root');
  const artifactDir = resolveContainedPath(
    gameRoot,
    input.artifactDir ?? defaultOfflinePlaytestArtifactDir,
    'artifact directory',
  );
  assertNoSymbolicLinkAncestors(gameRoot, artifactDir, 'artifact directory');
  const artifactRoot = realpathDirectory(artifactDir, 'artifact directory');

  if (!isPathWithin(gameRoot, artifactRoot)) {
    throw new Error(`Offline playtest artifact directory escapes the game root: ${artifactDir}`);
  }
  const outputDir = resolveContainedPath(
    gameRoot,
    input.outputDir ?? defaultOfflinePlaytestOutputDir,
    'output directory',
  );
  const maximumBytes = input.maximumBytes ?? defaultOfflinePlaytestMaximumBytes;

  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error('Offline playtest maximum bytes must be a positive safe integer.');
  }

  assertSeparateDirectories(artifactRoot, outputDir);
  assertSafeOutputDirectory(gameRoot, outputDir);
  assertReusableOutputDirectory(outputDir);
  const identity = readEffectivePreviewIdentity(artifactRoot);
  const sourceIndexFile = resolveArtifactFile(artifactRoot, 'index.html');
  const sourceHtml = readFileSync(sourceIndexFile, 'utf8');
  const context: InliningContext = {
    artifactRoot,
    assetDirectories: readArtifactAssetDirectories(artifactRoot),
    inlinedAssets: new Set<string>(),
    maximumBytes,
  };
  const { html: htmlWithoutEntry, entryFile } = extractModuleEntry(sourceHtml, context);
  const bundledEntry = await bundleEntry(entryFile, context);
  const htmlWithInlineScripts = inlineScriptElements(htmlWithoutEntry, sourceIndexFile, context);
  const htmlWithLinkedStyles = inlineStylesheets(htmlWithInlineScripts, sourceIndexFile, context);
  const htmlWithStyles = inlineStyleElements(htmlWithLinkedStyles, sourceIndexFile, context);
  const htmlWithAssets = inlineHtmlAssets(htmlWithStyles, sourceIndexFile, context);
  const finalHtml = assembleOfflineHtml(htmlWithAssets, bundledEntry);
  const htmlBytes = Buffer.byteLength(finalHtml);

  if (htmlBytes > maximumBytes) {
    throw new Error(
      `Offline playtest index.html is ${htmlBytes} bytes, exceeding the ${maximumBytes}-byte limit.`,
    );
  }

  const evidence: OfflinePlaytestEvidence = {
    schemaVersion: offlinePlaytestSchemaVersion,
    purpose: 'test-play-only',
    releaseTarget: false,
    sourceTarget: identity.target,
    sourceRuntime: identity.runtime,
    networkPolicy: 'deny-network',
    entryFile: 'index.html',
    bytes: htmlBytes,
    sha256: createHash('sha256').update(finalHtml).digest('hex'),
    inlinedAssetCount: context.inlinedAssets.size,
    limitations: offlinePlaytestLimitations,
  };

  mkdirSync(outputDir, { recursive: true });
  const entryFileOutput = path.join(outputDir, 'index.html');
  const readmeFile = path.join(outputDir, 'README.txt');
  const evidenceFile = path.join(outputDir, 'offline-playtest.json');
  writeFileSync(entryFileOutput, finalHtml);
  writeFileSync(readmeFile, renderOfflinePlaytestReadme(evidence));
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, undefined, 2)}\n`);

  return {
    outputDir,
    entryFile: entryFileOutput,
    readmeFile,
    evidenceFile,
    evidence,
  };
}

function readEffectivePreviewIdentity(artifactRoot: string): EffectivePreviewIdentity {
  const configFile = resolveArtifactFile(artifactRoot, effectiveTargetConfigFileName);
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid ${effectiveTargetConfigFileName}: ${errorMessage(error)}`);
  }

  if (!isRecord(parsed) || parsed.target !== 'web-preview' || parsed.runtime !== 'web-preview') {
    throw new Error(
      'Offline playtest packaging accepts only a web-preview artifact with matching effective target evidence.',
    );
  }

  return { target: 'web-preview', runtime: 'web-preview' };
}

function extractModuleEntry(
  html: string,
  context: InliningContext,
): { readonly html: string; readonly entryFile: string } {
  const scriptPattern = /<script\b([^>]*)>[\s\S]*?<\/script\s*>/giu;
  const matches = [...html.matchAll(scriptPattern)];
  const externalScripts = matches.filter(
    (match) => readHtmlAttribute(match[1] ?? '', 'src') !== undefined,
  );
  const moduleEntries = externalScripts.filter(
    (match) =>
      readHtmlAttribute(match[1] ?? '', 'type')?.toLowerCase() === 'module'
      && !hasNoModuleAttribute(match[1] ?? ''),
  );

  if (moduleEntries.length !== 1) {
    throw new Error('Offline playtest requires exactly one external module entry script.');
  }

  const match = moduleEntries[0];
  const source = readHtmlAttribute(match?.[1] ?? '', 'src');

  if (match?.[0] === undefined || source === undefined || match.index === undefined) {
    throw new Error('Unable to resolve the module entry script.');
  }

  const entryFile = resolveLocalReference(context.artifactRoot, context.artifactRoot, source);
  const removableScripts = new Set<RegExpMatchArray>([match]);

  for (const externalScript of externalScripts) {
    if (externalScript === match) {
      continue;
    }

    if (!hasNoModuleAttribute(externalScript[1] ?? '')) {
      throw new Error(
        'Offline playtest does not support additional external scripts beyond the module entry.',
      );
    }

    removableScripts.add(externalScript);
  }

  const output = removeHtmlMatches(html, removableScripts);

  return { html: output, entryFile };
}

function removeHtmlMatches(html: string, matches: ReadonlySet<RegExpMatchArray>): string {
  let cursor = 0;
  let output = '';

  for (const match of [...matches].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))) {
    if (match.index === undefined || match[0] === undefined) {
      throw new Error('Unable to remove an external script from the offline playtest document.');
    }

    output += html.slice(cursor, match.index);
    cursor = match.index + match[0].length;
  }

  return output + html.slice(cursor);
}

async function bundleEntry(entryFile: string, context: InliningContext): Promise<BundledEntry> {
  const result = await build({
    entryPoints: [entryFile],
    absWorkingDir: context.artifactRoot,
    bundle: true,
    write: false,
    outfile: 'offline-playtest.js',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    plugins: [offlineAssetInliningPlugin(context)],
    logLevel: 'silent',
  });
  const scriptOutput = result.outputFiles.find((file) => file.path.endsWith('.js'));

  if (scriptOutput === undefined) {
    throw new Error('The offline playtest bundler did not produce JavaScript.');
  }

  const script = scriptOutput.text;
  const stylesheetOutput = result.outputFiles.find((file) => file.path.endsWith('.css'));
  assertSupportedBundledRuntime(script);
  return {
    script,
    ...(stylesheetOutput === undefined ? {} : { stylesheet: stylesheetOutput.text }),
  };
}

function offlineAssetInliningPlugin(context: InliningContext): Plugin {
  return {
    name: 'mpgd-offline-playtest-assets',
    setup: (pluginBuild) => {
      pluginBuild.onLoad({ filter: /.*/ }, (args) => {
        if (args.namespace === 'file') {
          resolveArtifactFile(context.artifactRoot, args.path);
        }

        return undefined;
      });
      pluginBuild.onLoad({ filter: /\.(?:c|m)?js$/ }, (args) => {
        const source = readFileSync(resolveArtifactFile(context.artifactRoot, args.path), 'utf8');
        return {
          contents: inlineJavaScriptAssetReferences(source, args.path, context),
          loader: 'js',
          resolveDir: path.dirname(args.path),
        };
      });
      pluginBuild.onLoad({ filter: /\.css$/ }, (args) => {
        const cssFile = resolveArtifactFile(context.artifactRoot, args.path);
        const source = readFileSync(cssFile, 'utf8');
        context.inlinedAssets.add(cssFile);
        return {
          contents: inlineCssAssetReferences(source, cssFile, context),
          loader: 'css',
          resolveDir: path.dirname(args.path),
        };
      });
    },
  };
}

function inlineJavaScriptAssetReferences(
  source: string,
  sourceFile: string,
  context: InliningContext,
): string {
  const staticUrlPattern = /new\s+URL\(\s*(["'`])([^"'`]+)\1\s*,\s*import\.meta\.url\s*\)(\s*\.\s*href)?/gu;
  const sourceCodePositions = createCodePositionMap(source, true);
  let output = source.replace(
    staticUrlPattern,
    (match, _quote: string, reference: string, hrefAccess: string | undefined, offset: number) => {
      if (sourceCodePositions[offset] !== 1) {
        return match;
      }

      const dataUrl = readAssetDataUrl(sourceFile, reference, context);
      return hrefAccess === undefined
        ? `new URL(${JSON.stringify(dataUrl)})`
        : JSON.stringify(dataUrl);
    },
  );
  const assetDirectoryAlternative = context.assetDirectories.length === 0
    ? ''
    : `|(?:\\./)?(?:${context.assetDirectories.map(escapeRegExp).join('|')})/[^"'\`\\r\\n]+`;
  const literalPattern = new RegExp(
    `(["'\`])(/(?!/)[^"'\`\\r\\n]+${assetDirectoryAlternative})\\1`,
    'gu',
  );
  const documentFile = path.join(context.artifactRoot, 'index.html');
  const outputCodePositions = createCodePositionMap(output, true);
  output = output.replace(literalPattern, (match, quote: string, reference: string, offset: number) => {
    if (outputCodePositions[offset] !== 1) {
      return match;
    }

    const assetFile = resolveExistingAssetReference(documentFile, reference, context.artifactRoot);

    if (assetFile === undefined || isCodeAsset(assetFile)) {
      return match;
    }

    return `${quote}${escapeForQuote(readAssetDataUrl(documentFile, reference, context), quote)}${quote}`;
  });
  assertSupportedBundledRuntime(output);
  return output;
}

function inlineScriptElements(
  html: string,
  htmlFile: string,
  context: InliningContext,
): string {
  return html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu,
    (_tag, attributes: string, script: string) => {
      if (readHtmlAttribute(attributes, 'src') !== undefined) {
        throw new Error('Offline playtest cannot retain an external script after entry extraction.');
      }

      if (!isJavaScriptScriptType(readHtmlAttribute(attributes, 'type'))) {
        return `<script${attributes}>${script}</script>`;
      }

      const inlined = inlineJavaScriptAssetReferences(script, htmlFile, context);
      return `<script${attributes}>${escapeClosingTag(inlined, 'script')}</script>`;
    },
  );
}

function isJavaScriptScriptType(type: string | undefined): boolean {
  if (type === undefined || type.trim().length === 0) {
    return true;
  }

  const normalized = (type.split(';', 1)[0] ?? '').trim().toLowerCase();
  return javascriptScriptTypes.has(normalized);
}

function inlineStylesheets(
  html: string,
  htmlFile: string,
  context: InliningContext,
): string {
  return html.replace(/<link\b([^>]*)>/giu, (match, attributes: string) => {
    const rel = readHtmlAttribute(attributes, 'rel')?.toLowerCase();
    const href = readHtmlAttribute(attributes, 'href');

    if (rel === 'modulepreload') {
      return '';
    }

    if (rel !== 'stylesheet') {
      return match;
    }

    if (href === undefined) {
      throw new Error('Stylesheet link is missing href.');
    }

    const stylesheetFile = resolveLocalReference(context.artifactRoot, path.dirname(htmlFile), href);
    const stylesheet = readFileSync(stylesheetFile, 'utf8');
    const inlined = inlineCssAssetReferences(stylesheet, stylesheetFile, context);
    const media = readHtmlAttribute(attributes, 'media');
    const mediaAttribute = media === undefined ? '' : ` media="${escapeHtmlAttribute(media)}"`;
    context.inlinedAssets.add(stylesheetFile);
    return `<style${mediaAttribute}>${escapeClosingTag(inlined, 'style')}</style>`;
  });
}

function inlineCssAssetReferences(
  source: string,
  sourceFile: string,
  context: InliningContext,
): string {
  if (containsCssImportRule(source)) {
    throw new Error(`Offline playtest does not support CSS @import rules: ${sourceFile}`);
  }

  const cssUrlPattern = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*?))\s*\)/giu;
  const codePositions = createCodePositionMap(source, false);
  return source.replace(cssUrlPattern, (match, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined, offset: number) => {
    if (codePositions[offset] !== 1) {
      return match;
    }

    const reference = (doubleQuoted ?? singleQuoted ?? unquoted ?? '').trim();

    if (reference.startsWith('data:') || reference.startsWith('blob:') || reference.startsWith('#')) {
      return match;
    }

    return `url(${JSON.stringify(readAssetDataUrl(sourceFile, reference, context))})`;
  });
}

function inlineStyleElements(
  html: string,
  htmlFile: string,
  context: InliningContext,
): string {
  return html.replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style>/giu,
    (_tag, attributes: string, stylesheet: string) => {
      const inlined = inlineCssAssetReferences(stylesheet, htmlFile, context);
      return `<style${attributes}>${escapeClosingTag(inlined, 'style')}</style>`;
    },
  );
}

function containsCssImportRule(source: string): boolean {
  let quote: '"' | "'" | undefined;
  let inComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (inComment) {
      if (character === '*' && nextCharacter === '/') {
        inComment = false;
        index += 1;
      }

      continue;
    }

    if (quote !== undefined) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }

      continue;
    }

    if (character === '/' && nextCharacter === '*') {
      inComment = true;
      index += 1;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (
      character === '@'
      && source.slice(index, index + 7).toLowerCase() === '@import'
      && !/[\w-]/u.test(source[index + 7] ?? '')
    ) {
      return true;
    }
  }

  return false;
}

function inlineHtmlAssets(
  html: string,
  htmlFile: string,
  context: InliningContext,
): string {
  return transformOutsideHtmlRawText(
    html,
    (fragment) => inlineHtmlAssetFragment(fragment, htmlFile, context),
  );
}

function inlineHtmlAssetFragment(
  html: string,
  htmlFile: string,
  context: InliningContext,
): string {
  return html.replace(/<(link|audio|embed|feimage|image|img|input|object|source|track|use|video)\b([^>]*)>/giu, (tag, name: string, attributes: string) => {
    const lowerName = name.toLowerCase();
    const rel = readHtmlAttribute(attributes, 'rel')?.toLowerCase();
    const allowedAttributes = [...(htmlAssetAttributesByTag[lowerName] ?? ['src'])];

    if (lowerName === 'link') {
      if (rel !== 'icon' && rel !== 'apple-touch-icon' && rel !== 'mask-icon') {
        return tag;
      }

      allowedAttributes.splice(0, allowedAttributes.length, 'href');
    }

    let output = tag;

    for (const attribute of allowedAttributes) {
      const reference = readHtmlAttribute(attributes, attribute);

      if (reference === undefined || reference.startsWith('#')) {
        continue;
      }

      let inlined: string;

      if (attribute === 'srcset') {
        inlined = inlineHtmlSrcset(htmlFile, reference, context);
      } else if (reference.startsWith('data:') || reference.startsWith('blob:')) {
        inlined = reference;
      } else {
        inlined = readAssetDataUrl(htmlFile, reference, context);
      }

      output = replaceHtmlAttribute(output, attribute, inlined);
    }

    return output;
  });
}

function transformOutsideHtmlRawText(
  html: string,
  transform: (fragment: string) => string,
): string {
  const rawTextPattern = /<(script|style|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
  let cursor = 0;
  let output = '';

  for (const match of html.matchAll(rawTextPattern)) {
    if (match.index === undefined || match[0] === undefined) {
      continue;
    }

    output += transform(html.slice(cursor, match.index));
    output += match[0];
    cursor = match.index + match[0].length;
  }

  return output + transform(html.slice(cursor));
}

function inlineHtmlSrcset(
  htmlFile: string,
  source: string,
  context: InliningContext,
): string {
  return parseHtmlSrcset(source, htmlFile).map(({ reference, descriptor }) => {
    const inlined = reference.startsWith('data:') || reference.startsWith('blob:')
      ? reference
      : readAssetDataUrl(htmlFile, reference, context);
    return descriptor.length === 0 ? inlined : `${inlined} ${descriptor}`;
  }).join(', ');
}

function parseHtmlSrcset(
  source: string,
  htmlFile: string,
): readonly Readonly<{ reference: string; descriptor: string }>[] {
  const candidates: Array<Readonly<{ reference: string; descriptor: string }>> = [];
  let index = 0;

  while (index < source.length) {
    while (index < source.length && (isHtmlSpace(source[index]) || source[index] === ',')) {
      index += 1;
    }

    if (index >= source.length) {
      break;
    }

    const referenceStart = index;

    while (index < source.length && !isHtmlSpace(source[index])) {
      index += 1;
    }

    let reference = source.slice(referenceStart, index);
    let endedByComma = false;

    while (reference.endsWith(',')) {
      reference = reference.slice(0, -1);
      endedByComma = true;
    }

    if (reference.length === 0) {
      throw new Error(`Invalid empty srcset candidate in ${htmlFile}.`);
    }

    if (endedByComma) {
      candidates.push({ reference, descriptor: '' });
      continue;
    }

    while (index < source.length && isHtmlSpace(source[index])) {
      index += 1;
    }

    const descriptorStart = index;

    while (index < source.length && source[index] !== ',') {
      index += 1;
    }

    const descriptor = source.slice(descriptorStart, index).trim();

    if (index < source.length) {
      index += 1;
    }

    candidates.push({ reference, descriptor });
  }

  if (candidates.length === 0) {
    throw new Error(`Invalid empty srcset in ${htmlFile}.`);
  }

  return candidates;
}

function assembleOfflineHtml(html: string, bundledEntry: BundledEntry): string {
  const csp = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; connect-src data: blob:; object-src data:; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'";
  const banner = '<!-- MPGD offline playtest: test-play-only, not a release target or store submission artifact. -->';
  const runtimeGuard = renderOfflineRuntimeGuard();
  const guardScript = `<script>${escapeClosingTag(runtimeGuard, 'script')}</script>`;
  const bundledStyle = bundledEntry.stylesheet === undefined
    ? ''
    : `\n<style>${escapeClosingTag(bundledEntry.stylesheet, 'style')}</style>`;
  const inlineScript = `<script type="module">${escapeClosingTag(bundledEntry.script, 'script')}</script>`;
  let output = removeExistingCharsetDeclaration(
    removeExistingContentSecurityPolicy(
      html.replace(/<link\b[^>]*\brel=["']manifest["'][^>]*>/giu, ''),
    ),
  );

  if (/<head\b[^>]*>/iu.test(output)) {
    output = output.replace(
      /<head\b([^>]*)>/iu,
      `<head$1>\n<meta charset="utf-8">\n${banner}\n<meta name="mpgd-purpose" content="test-play-only">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n${guardScript}${bundledStyle}`,
    );
  } else {
    throw new Error('Offline playtest source index.html must contain a head element.');
  }

  if (/<\/body>/iu.test(output)) {
    return `${output.replace(/<\/body>/iu, `${inlineScript}\n</body>`).trim()}\n`;
  }

  throw new Error('Offline playtest source index.html must contain a body element.');
}

function removeExistingContentSecurityPolicy(html: string): string {
  return html.replace(/<meta\b[^>]*>/giu, (tag) =>
    readHtmlAttribute(tag, 'http-equiv')?.toLowerCase() === 'content-security-policy' ? '' : tag,
  );
}

function removeExistingCharsetDeclaration(html: string): string {
  return html.replace(/<meta\b[^>]*>/giu, (tag) =>
    readHtmlAttribute(tag, 'charset') === undefined ? tag : '',
  );
}

function renderOfflineRuntimeGuard(): string {
  return `(()=>{const allowed=(value)=>{const raw=typeof value==='string'?value:typeof URL!=='undefined'&&value instanceof URL?value.href:typeof Request!=='undefined'&&value instanceof Request?value.url:String(value);return raw.startsWith('data:')||raw.startsWith('blob:')};const denied=(api,value)=>new TypeError('[mpgd offline playtest] '+api+' blocked network access: '+String(value));const originalFetch=globalThis.fetch?.bind(globalThis);if(originalFetch){globalThis.fetch=(input,init)=>{if(!allowed(input))return Promise.reject(denied('fetch',input));return originalFetch(input,init)}}if(globalThis.XMLHttpRequest){const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){if(!allowed(url))throw denied('XMLHttpRequest',url);return open.call(this,method,url,...rest)}}if(globalThis.WebSocket){globalThis.WebSocket=class{constructor(url){throw denied('WebSocket',url)}}}if(globalThis.EventSource){globalThis.EventSource=class{constructor(url){throw denied('EventSource',url)}}}if(typeof navigator!=='undefined'&&navigator.sendBeacon){navigator.sendBeacon=()=>false}})();`;
}

function assertSupportedBundledRuntime(source: string): void {
  const unsupported = [
    { pattern: /\bnew\s+(?:Shared)?Worker\s*\(/gu, label: 'Worker' },
    { pattern: /\bserviceWorker\s*\.\s*register\s*\(/gu, label: 'service worker registration' },
    { pattern: /\bWebAssembly\s*\.\s*instantiateStreaming\s*\(/gu, label: 'WebAssembly streaming' },
    { pattern: /\bnew\s+URL\([^;]*import\.meta/gu, label: 'runtime-computed import.meta asset URL' },
  ];
  const codePositions = createCodePositionMap(source, true);

  for (const candidate of unsupported) {
    for (const match of source.matchAll(candidate.pattern)) {
      if (match.index !== undefined && codePositions[match.index] === 1) {
        throw new Error(`Offline playtest does not support ${candidate.label}.`);
      }
    }
  }
}

function createCodePositionMap(source: string, allowLineComments: boolean): Uint8Array {
  const positions = new Uint8Array(source.length);
  positions.fill(1);

  if (allowLineComments) {
    scanJavaScriptCodePositions(source, positions, 0, false, false, 0);
  } else {
    scanCssCodePositions(source, positions);
  }

  return positions;
}

function scanCssCodePositions(source: string, positions: Uint8Array): void {
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (character === '/' && nextCharacter === '*') {
      index = markBlockComment(source, positions, index);
    } else if (character === '"' || character === "'") {
      index = markQuotedText(source, positions, index, character);
    }
  }
}

function scanJavaScriptCodePositions(
  source: string,
  positions: Uint8Array,
  start: number,
  stopAtClosingBrace: boolean,
  startsAsExpression: boolean,
  depth: number,
): number {
  if (depth > 64) {
    throw new Error('Offline playtest JavaScript exceeds the supported template nesting depth.');
  }

  let regexAllowed = true;
  let pendingControlParenthesis = false;
  let pendingClassBody = false;
  let nextBraceIsBlock = false;
  let previousToken: string | undefined;
  const parenthesisKinds: Array<'control' | 'normal'> = [];
  const braceKinds: boolean[] = [];

  for (let index = start; index < source.length; index += 1) {
    const character = source.charAt(index);
    const nextCharacter = source[index + 1];

    if (/\s/u.test(character)) {
      continue;
    }

    if (character === '/' && nextCharacter === '*') {
      index = markBlockComment(source, positions, index);
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      index = markLineComment(source, positions, index);
      continue;
    }

    const inheritedBraceIsBlock = nextBraceIsBlock;
    nextBraceIsBlock = false;

    if (character === '"' || character === "'") {
      index = markQuotedText(source, positions, index, character);
      regexAllowed = false;
      pendingControlParenthesis = false;
      previousToken = 'value';
      continue;
    }

    if (character === '`') {
      index = markTemplateLiteral(source, positions, index, depth + 1);
      regexAllowed = false;
      pendingControlParenthesis = false;
      previousToken = 'value';
      continue;
    }

    if (isJavaScriptIdentifierStart(character)) {
      const identifierCanStartExpression = regexAllowed;
      const identifierStart = index;

      while (isJavaScriptIdentifierPart(source[index + 1])) {
        index += 1;
      }

      const identifier = source.slice(identifierStart, index + 1);
      pendingControlParenthesis = javascriptControlParenthesisKeywords.has(identifier);
      pendingClassBody ||= identifier === 'class' && identifierCanStartExpression;
      nextBraceIsBlock = javascriptBlockKeywords.has(identifier);
      regexAllowed = javascriptRegexPrefixKeywords.has(identifier);
      previousToken = identifier;
      continue;
    }

    if (/\d/u.test(character)) {
      while (/[_\w.]/u.test(source[index + 1] ?? '')) {
        index += 1;
      }

      regexAllowed = false;
      pendingControlParenthesis = false;
      previousToken = 'value';
      continue;
    }

    if (character === '/' && regexAllowed) {
      const regexEnd = findJavaScriptRegexEnd(source, index);

      if (regexEnd !== undefined) {
        positions.fill(0, index + 1, regexEnd + 1);
        index = regexEnd;
        regexAllowed = false;
        pendingControlParenthesis = false;
        previousToken = 'value';
        continue;
      }
    }

    if (
      (character === '+' && nextCharacter === '+')
      || (character === '-' && nextCharacter === '-')
    ) {
      index += 1;
      regexAllowed = false;
      pendingControlParenthesis = false;
      previousToken = 'value';
      continue;
    }

    if (character === '(') {
      const parenthesisKind = pendingControlParenthesis ? 'control' : 'normal';
      parenthesisKinds.push(parenthesisKind);
      pendingControlParenthesis = false;
      regexAllowed = true;
      previousToken = '(';
      continue;
    }

    if (character === ')') {
      const parenthesisKind = parenthesisKinds.pop() ?? 'normal';
      regexAllowed = parenthesisKind === 'control';
      nextBraceIsBlock = true;
      pendingControlParenthesis = false;
      previousToken = ')';
      continue;
    }

    if (character === '=' && nextCharacter === '>') {
      index += 1;
      regexAllowed = true;
      nextBraceIsBlock = true;
      pendingControlParenthesis = false;
      previousToken = '=>';
      continue;
    }

    if (character === '{') {
      const isClassBody: boolean = pendingClassBody && parenthesisKinds.length === 0;
      const isBlock = inheritedBraceIsBlock
        || isClassBody
        || (!startsAsExpression && previousToken === undefined)
        || previousToken === ';'
        || previousToken === 'block-open'
        || previousToken === 'block-close';
      braceKinds.push(isBlock);
      pendingClassBody &&= !isClassBody;
      regexAllowed = true;
      pendingControlParenthesis = false;
      previousToken = isBlock ? 'block-open' : 'object-open';
      continue;
    }

    if (character === '}') {
      if (braceKinds.length === 0 && stopAtClosingBrace) {
        return index;
      }

      const isBlock = braceKinds.pop() ?? true;
      regexAllowed = isBlock;
      pendingControlParenthesis = false;
      previousToken = isBlock ? 'block-close' : 'object-close';
      continue;
    }

    if (character === ']' || character === '.') {
      regexAllowed = false;
      pendingControlParenthesis = false;
      previousToken = 'value';
      continue;
    }

    pendingControlParenthesis = false;
    if (character === ';' || character === ':') {
      pendingClassBody = false;
    }
    regexAllowed = true;
    previousToken = character;
  }

  return source.length - 1;
}

function markBlockComment(source: string, positions: Uint8Array, start: number): number {
  positions[start] = 0;
  positions[start + 1] = 0;

  for (let index = start + 2; index < source.length; index += 1) {
    positions[index] = 0;

    if (source[index] === '*' && source[index + 1] === '/') {
      positions[index + 1] = 0;
      return index + 1;
    }
  }

  return source.length - 1;
}

function markLineComment(source: string, positions: Uint8Array, start: number): number {
  let index = start;

  while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
    positions[index] = 0;
    index += 1;
  }

  return index - 1;
}

function markQuotedText(
  source: string,
  positions: Uint8Array,
  start: number,
  quote: '"' | "'",
): number {
  for (let index = start + 1; index < source.length; index += 1) {
    positions[index] = 0;

    if (source[index] === '\\' && index + 1 < source.length) {
      positions[index + 1] = 0;
      index += 1;
    } else if (source[index] === quote) {
      return index;
    }
  }

  return source.length - 1;
}

function markTemplateLiteral(
  source: string,
  positions: Uint8Array,
  start: number,
  depth: number,
): number {
  for (let index = start + 1; index < source.length; index += 1) {
    positions[index] = 0;

    if (source[index] === '\\' && index + 1 < source.length) {
      positions[index + 1] = 0;
      index += 1;
      continue;
    }

    if (source[index] === '`') {
      return index;
    }

    if (source[index] === '$' && source[index + 1] === '{') {
      positions[index + 1] = 0;
      const closingBrace = scanJavaScriptCodePositions(
        source,
        positions,
        index + 2,
        true,
        true,
        depth,
      );
      positions[closingBrace] = 0;
      index = closingBrace;
    }
  }

  return source.length - 1;
}

function findJavaScriptRegexEnd(source: string, start: number): number | undefined {
  let inCharacterClass = false;

  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];

    if (character === '\n' || character === '\r') {
      return undefined;
    }

    if (character === '\\') {
      index += 1;
      continue;
    }

    if (character === '[') {
      inCharacterClass = true;
      continue;
    }

    if (character === ']') {
      inCharacterClass = false;
      continue;
    }

    if (character === '/' && !inCharacterClass) {
      while (isJavaScriptIdentifierPart(source[index + 1])) {
        index += 1;
      }

      return index;
    }
  }

  return undefined;
}

function isJavaScriptIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && /[$A-Z_a-z]/u.test(value);
}

function isJavaScriptIdentifierPart(value: string | undefined): boolean {
  return value !== undefined && /[$\dA-Z_a-z]/u.test(value);
}

function readAssetDataUrl(
  sourceFile: string,
  reference: string,
  context: InliningContext,
): string {
  const fragmentIndex = reference.indexOf('#');
  const fragment = fragmentIndex === -1 ? '' : reference.slice(fragmentIndex);
  const assetFile = resolveLocalReference(
    context.artifactRoot,
    path.dirname(sourceFile),
    reference,
  );
  const extension = path.extname(assetFile).toLowerCase();
  const mimeType = mimeTypes.get(extension);

  if (mimeType === undefined) {
    throw new Error(
      `Unsupported offline asset type: ${path.relative(context.artifactRoot, assetFile)}`,
    );
  }

  const assetBytes = statSync(assetFile).size;

  if (assetBytes > context.maximumBytes) {
    throw new Error(
      `Offline asset ${path.relative(context.artifactRoot, assetFile)} is ${assetBytes} bytes, exceeding the ${context.maximumBytes}-byte limit.`,
    );
  }

  const asset = readFileSync(assetFile);

  if (extension === '.gltf') {
    assertSelfContainedGltf(assetFile, asset.toString('utf8'));
  }

  context.inlinedAssets.add(assetFile);
  return `data:${mimeType};base64,${asset.toString('base64')}${fragment}`;
}

function assertSelfContainedGltf(gltfFile: string, source: string): void {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid glTF JSON in ${gltfFile}: ${errorMessage(error)}`);
  }

  const externalUri = findExternalGltfUri(parsed);

  if (externalUri !== undefined) {
    throw new Error(
      `Offline playtest requires self-contained glTF data URIs or GLB: ${gltfFile} references ${externalUri}`,
    );
  }
}

function findExternalGltfUri(value: unknown): string | undefined {
  const pending: Array<Readonly<{ value: unknown; depth: number; key?: string }>> = [
    { value, depth: 0 },
  ];

  while (pending.length > 0) {
    const current = pending.pop();

    if (current === undefined) {
      break;
    }

    if (current.depth > 64) {
      throw new Error('Offline playtest glTF JSON exceeds the maximum nesting depth.');
    }

    if (
      current.key === 'uri'
      && typeof current.value === 'string'
      && !current.value.startsWith('data:')
    ) {
      return current.value;
    }

    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], depth: current.depth + 1 });
      }

      continue;
    }

    if (!isRecord(current.value)) {
      continue;
    }

    const entries = Object.entries(current.value).reverse();

    for (const [key, child] of entries) {
      pending.push({ key, value: child, depth: current.depth + 1 });
    }
  }

  return undefined;
}

function resolveExistingAssetReference(
  sourceFile: string,
  reference: string,
  artifactRoot: string,
): string | undefined {
  if (isNonLocalReference(reference) || reference.includes('${')) {
    return undefined;
  }

  try {
    const candidate = resolveReferencePath(artifactRoot, path.dirname(sourceFile), reference);
    return existsSync(candidate) && lstatSync(candidate).isFile()
      ? resolveArtifactFile(artifactRoot, candidate)
      : undefined;
  } catch {
    return undefined;
  }
}

function readArtifactAssetDirectories(artifactRoot: string): readonly string[] {
  return readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => escapeRegExp(entry.name));
}

function resolveLocalReference(artifactRoot: string, baseDir: string, reference: string): string {
  if (isNonLocalReference(reference)) {
    throw new Error(`Offline playtest cannot inline external URL: ${reference}`);
  }

  const candidate = resolveReferencePath(artifactRoot, baseDir, reference);
  return resolveArtifactFile(artifactRoot, candidate);
}

function resolveReferencePath(artifactRoot: string, baseDir: string, reference: string): string {
  const cleanReference = reference.split(/[?#]/u, 1)[0] ?? '';

  if (cleanReference.length === 0) {
    throw new Error(`Invalid empty local asset reference in ${baseDir}.`);
  }

  const decodedReference = decodeLocalReferencePath(cleanReference, baseDir);

  return decodedReference.startsWith('/')
    ? path.resolve(artifactRoot, `.${decodedReference}`)
    : path.resolve(baseDir, decodedReference);
}

function decodeLocalReferencePath(reference: string, baseDir: string): string {
  return reference.split('/').map((segment) => {
    let decoded: string;

    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`Invalid URL-escaped local asset reference in ${baseDir}: ${reference}`);
    }

    if (
      decoded.includes('/')
      || decoded.includes('\\')
      || decoded.includes('\0')
      || (segment.includes('%') && (decoded === '.' || decoded === '..'))
    ) {
      throw new Error(`Unsafe URL-escaped local asset reference in ${baseDir}: ${reference}`);
    }

    return decoded;
  }).join('/');
}

function resolveArtifactFile(artifactRoot: string, file: string): string {
  const candidate = path.isAbsolute(file) ? file : path.resolve(artifactRoot, file);

  if (!existsSync(candidate) || !lstatSync(candidate).isFile()) {
    throw new Error(`Missing offline playtest artifact file: ${candidate}`);
  }

  const canonical = realpathSync(candidate);

  if (!isPathWithin(artifactRoot, canonical)) {
    throw new Error(`Offline playtest artifact escapes its root: ${candidate}`);
  }

  return canonical;
}

function resolveContainedPath(root: string, value: string, label: string): string {
  const candidate = path.resolve(root, value);

  if (!isPathWithin(root, candidate) || candidate === root) {
    throw new Error(`Offline playtest ${label} must be a child of the game root: ${candidate}`);
  }

  return candidate;
}

function realpathDirectory(value: string, label: string): string {
  const candidate = path.resolve(value);

  if (!existsSync(candidate) || !lstatSync(candidate).isDirectory()) {
    throw new Error(`Missing offline playtest ${label}: ${candidate}`);
  }

  return realpathSync(candidate);
}

function assertSeparateDirectories(artifactRoot: string, outputDir: string): void {
  if (
    artifactRoot === outputDir
    || isPathWithin(artifactRoot, outputDir)
    || isPathWithin(outputDir, artifactRoot)
  ) {
    throw new Error('Offline playtest artifact and output directories must not overlap.');
  }
}

function assertSafeOutputDirectory(gameRoot: string, outputDir: string): void {
  const artifactsRoot = path.join(gameRoot, 'artifacts');

  if (!isPathWithin(artifactsRoot, outputDir)) {
    throw new Error(
      `Offline playtest output directory must stay under ${artifactsRoot}: ${outputDir}`,
    );
  }

  assertNoSymbolicLinkAncestors(gameRoot, outputDir, 'output directory');

  if (!existsSync(outputDir)) {
    return;
  }

  if (!lstatSync(outputDir).isDirectory()) {
    throw new Error(`Offline playtest output path must be a directory: ${outputDir}`);
  }

  const canonical = realpathSync(outputDir);

  if (!isPathWithin(gameRoot, canonical) || canonical === gameRoot) {
    throw new Error(`Offline playtest output directory escapes the game root: ${outputDir}`);
  }
}

function assertReusableOutputDirectory(outputDir: string): void {
  if (!existsSync(outputDir)) {
    return;
  }

  const entries = readdirSync(outputDir);

  if (entries.length === 0) {
    return;
  }

  for (const entry of entries) {
    const entryFile = path.join(outputDir, entry);
    const entryStats = lstatSync(entryFile);

    if (
      !offlinePlaytestOutputFiles.has(entry)
      || entryStats.isSymbolicLink()
      || !entryStats.isFile()
    ) {
      throw new Error(
        `Offline playtest refuses to overwrite a directory containing non-generated content: ${entryFile}`,
      );
    }
  }

  const evidenceFile = path.join(outputDir, 'offline-playtest.json');

  if (!existsSync(evidenceFile)) {
    throw new Error(
      `Offline playtest output is missing prior generation evidence: ${evidenceFile}`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(evidenceFile, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid prior offline playtest evidence: ${errorMessage(error)}`);
  }

  if (
    !isRecord(parsed)
    || parsed.schemaVersion !== offlinePlaytestSchemaVersion
    || parsed.purpose !== 'test-play-only'
    || parsed.releaseTarget !== false
    || parsed.entryFile !== 'index.html'
  ) {
    throw new Error(`Invalid prior offline playtest evidence: ${evidenceFile}`);
  }

  const entryFile = path.join(outputDir, 'index.html');

  if (!existsSync(entryFile) || !lstatSync(entryFile).isFile()) {
    throw new Error(`Offline playtest output is missing its prior generated entry: ${entryFile}`);
  }

  if (typeof parsed.sha256 !== 'string' || !/^[a-f\d]{64}$/u.test(parsed.sha256)) {
    throw new Error(`Invalid prior offline playtest evidence hash: ${evidenceFile}`);
  }

  const currentHash = createHash('sha256').update(readFileSync(entryFile)).digest('hex');

  if (currentHash !== parsed.sha256) {
    throw new Error(
      `Offline playtest refuses to overwrite a modified prior generated entry: ${entryFile}`,
    );
  }
}

function assertNoSymbolicLinkAncestors(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  let current = root;

  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);

    if (!existsSync(current)) {
      break;
    }

    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Offline playtest ${label} cannot cross a symbolic link: ${current}`);
    }
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(
    `..${path.sep}`,
  ) && !path.isAbsolute(relative);
}

function isNonLocalReference(reference: string): boolean {
  const value = reference.trim();
  return value.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(value);
}

function isCodeAsset(file: string): boolean {
  return /\.(?:c|m)?js$/iu.test(file) || /\.css$/iu.test(file) || /\.html?$/iu.test(file);
}

function readHtmlAttribute(attributes: string, name: string): string | undefined {
  const escapedName = escapeRegExp(name);
  const match = new RegExp(
    `(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`,
    'iu',
  ).exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function hasNoModuleAttribute(attributes: string): boolean {
  return noModuleAttributePattern.test(attributes);
}

function replaceHtmlAttribute(tag: string, name: string, value: string): string {
  const escapedName = escapeRegExp(name);
  const pattern = new RegExp(
    `((?:^|\\s)${escapedName}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"'=<>\\x60]+)`,
    'iu',
  );
  return tag.replace(pattern, `$1"${escapeHtmlAttribute(value)}"`);
}

function isHtmlSpace(value: string | undefined): boolean {
  return value === ' ' || value === '\t' || value === '\n' || value === '\f' || value === '\r';
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/'/gu, '&#x27;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function escapeForQuote(value: string, quote: string): string {
  return value.replace(/\\/gu, '\\\\').replace(new RegExp(escapeRegExp(quote), 'gu'), `\\${quote}`);
}

function escapeClosingTag(value: string, tag: 'script' | 'style'): string {
  return value.replace(new RegExp(`</${tag}`, 'giu'), `<\\/${tag}`);
}

function renderOfflinePlaytestReadme(evidence: OfflinePlaytestEvidence): string {
  return `MPGD OFFLINE PLAYTEST / 오프라인 테스트 플레이\n\nTEST PLAY ONLY / 테스트 플레이 전용\nThis directory is not a release target, deployable web artifact, PWA, or store-submission package.\n이 디렉터리는 출시 타깃, 웹 배포 산출물, PWA 또는 스토어 제출 패키지가 아닙니다.\n\nOpen index.html directly in a browser. Network APIs are intentionally blocked.\n브라우저에서 index.html을 직접 여세요. 네트워크 API는 의도적으로 차단됩니다.\n\nSource target: ${evidence.sourceTarget}\nSHA-256: ${evidence.sha256}\n\nLimitations / 제약 사항:\n${evidence.limitations.map((value) => `- ${value}`).join('\n')}\n\nA successful package does not prove that every game flow works offline. Games must handle unavailable server-backed features gracefully.\n패키징 성공은 모든 게임 흐름의 오프라인 동작을 보장하지 않습니다. 게임은 서버 기능이 없는 상태를 직접 처리해야 합니다.\n`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
