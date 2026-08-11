import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { decodeHTMLAttribute } from 'entities';
import { build, type Metafile, type Plugin } from 'esbuild';

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
  readonly assetDataUrls: Map<string, string>;
  readonly bundledAssetCandidates: Set<string>;
  readonly inlinedAssets: Set<string>;
  readonly maximumBytes: number;
  inlinedAssetBytes: number;
}

type DeferredJavaScriptAsset =
  | {
    readonly externalError?: string;
    readonly reference: string;
    readonly sourceFile: string;
  }
  | { readonly retainedError: string };

type AssetDataUrlReader = (
  sourceFile: string,
  reference: string,
  externalError?: string,
) => string;

type JavaScriptErrorDeferrer = (error: string) => string;

interface BundledEntry {
  readonly script: string;
  readonly stylesheet?: string;
}

interface HtmlAttributeToken {
  readonly name: string;
  readonly value?: string;
  readonly rawValueStart?: number;
  readonly rawValueEnd?: number;
}

interface HtmlTagToken {
  readonly attributes: readonly HtmlAttributeToken[];
  readonly closing: boolean;
  readonly end: number;
  readonly name: string;
  readonly start: number;
}

type HtmlNamespace = 'html' | 'mathml' | 'svg';

interface CssUrlToken {
  readonly start: number;
  readonly end: number;
  readonly reference: string;
}

interface SourceRange {
  readonly start: number;
  readonly end: number;
}

interface SourceReplacement extends SourceRange {
  readonly value: string;
}

interface PhaserManifestUrlRange extends SourceRange {
  readonly traceIdentifiers: boolean;
}

interface PhaserManifestProof {
  readonly initializerRange: SourceRange;
  readonly propertyName: string;
}

interface JavaScriptIdentifierBinding {
  readonly bindingPath: readonly number[];
  readonly initializerRange?: SourceRange;
  readonly kind: 'class' | 'const' | 'function' | 'let' | 'parameter' | 'unknown' | 'var';
  readonly start: number;
}

interface JavaScriptAssignmentResolution {
  readonly ambiguous: boolean;
  readonly range?: SourceRange;
}

interface LocationAliasAssignment {
  readonly expression: string;
  readonly expressionRange: SourceRange;
  readonly identifier: string;
  readonly start: number;
}

const effectiveTargetConfigFileName = 'mpgd-effective-target.json';
const offlineCharsetDeclaration = '<meta charset="utf-8">';
const offlineEntryPlaceholder = '<!-- MPGD_OFFLINE_PLAYTEST_ENTRY -->';
const offlinePlaytestOutputFiles = new Set(['README.txt', 'index.html', 'offline-playtest.json']);
const htmlAttributeNameTerminators = new Set(['"', "'", '=', '<', '>', '/']);
const htmlVoidElementNames = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const nonEventHtmlAttributeNamesStartingWithOn = new Set(['ontology']);
const inlineEntryExcludedAttributeNames = new Set(['src']);
const svgResourceAttributeNames = new Set([
  'action',
  'background',
  'data',
  'formaction',
  'href',
  'poster',
  'src',
  'xlink:href',
]);
const svgFunctionalUrlAttributeNames = new Set([
  'clip-path',
  'color-profile',
  'cursor',
  'fill',
  'filter',
  'marker',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'stroke',
]);
const htmlResourceHintRelNames = new Set([
  'dns-prefetch',
  'modulepreload',
  'preconnect',
  'prefetch',
  'preload',
  'prerender',
]);
const phaserManifestUrlPropertyNames = new Set([
  'atlasURL',
  'atlasUrl',
  'audioURL',
  'audioUrl',
  'fontDataURL',
  'fontDataUrl',
  'jsonURL',
  'jsonUrl',
  'normalMap',
  'path',
  'textureURL',
  'textureUrl',
  'url',
  'urls',
]);
const phaserManifestKinds = new Set(['atlas', 'audio', 'binary', 'image', 'json', 'spritesheet']);
const phaserLoaderUrlArgumentIndexes: Readonly<Record<string, readonly number[]>> = {
  animation: [1],
  aseprite: [1, 2],
  atlas: [1, 2],
  atlasPCT: [1],
  atlasXML: [1, 2],
  audio: [1],
  audioSprite: [1, 2],
  binary: [1],
  bitmapFont: [1, 2],
  font: [1],
  glsl: [1],
  html: [1],
  htmlTexture: [1],
  image: [1],
  json: [1],
  plugin: [1],
  sceneFile: [1],
  scenePlugin: [1],
  script: [1],
  scripts: [1],
  spritesheet: [1],
  svg: [1],
  text: [1],
  tilemapCSV: [1],
  tilemapImpact: [1],
  unityAtlas: [1, 2],
  video: [1],
  xml: [1],
};
const unsupportedPhaserLoaderMethods = new Set([
  'css',
  'multiatlas',
  'pack',
  'plugin',
  'sceneFile',
  'scenePlugin',
  'script',
  'scripts',
  'tilemapTiledJSON',
]);
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
const javascriptIdentifierPatternSource = '[$_\\p{ID_Start}][$\\u200C\\u200D\\p{ID_Continue}]*';
const javascriptTriviaPatternSource = String.raw`(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\r\n]*(?:\r\n?|\n|$))*`;
const exactJavaScriptIdentifierPattern = new RegExp(`^${javascriptIdentifierPatternSource}$`, 'u');
const importDefaultBindingPattern = new RegExp(
  `^(${javascriptIdentifierPatternSource})(?:\\s*,|$)`,
  'u',
);
const importNamespaceBindingPattern = new RegExp(
  `\\*\\s*as\\s+(${javascriptIdentifierPatternSource})`,
  'u',
);
const importNamedBindingPattern = new RegExp(
  `^(${javascriptIdentifierPatternSource})(?:\\s+as\\s+(${javascriptIdentifierPatternSource}))?$`,
  'u',
);
const htmlAssetAttributesByTag: Readonly<Record<string, readonly string[]>> = {
  audio: ['src'],
  body: ['background'],
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
  'Dynamic imports, import maps, and HTML base elements are unsupported.',
  'Retained inline modules cannot import other modules, and script-driven navigation is unsupported.',
  'Iframe documents and non-fragment hyperlinks are unsupported.',
  'Phaser loader base URL and path prefixes are unsupported; pass complete artifact-relative URLs.',
  'Phaser CSS, executable script, and composite manifest loaders are unsupported.',
  'Subresource-integrity-protected entry scripts and stylesheets are unsupported.',
  'Alternate stylesheets are unsupported.',
] as const;

const mimeTypes = new Map<string, string>([
  ['.aac', 'audio/aac'],
  ['.atlas', 'text/plain'],
  ['.avif', 'image/avif'],
  ['.bin', 'application/octet-stream'],
  ['.csv', 'text/csv'],
  ['.dat', 'application/octet-stream'],
  ['.eot', 'application/vnd.ms-fontobject'],
  ['.fnt', 'text/plain'],
  ['.frag', 'text/plain'],
  ['.gif', 'image/gif'],
  ['.glb', 'model/gltf-binary'],
  ['.glsl', 'text/plain'],
  ['.gltf', 'model/gltf+json'],
  ['.htm', 'text/html'],
  ['.html', 'text/html'],
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
  ['.vert', 'text/plain'],
  ['.vtt', 'text/vtt'],
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
  assertSupportedHtmlDocument(sourceHtml);
  const context: InliningContext = {
    artifactRoot,
    assetDataUrls: new Map<string, string>(),
    bundledAssetCandidates: new Set<string>(),
    inlinedAssets: new Set<string>(),
    inlinedAssetBytes: 0,
    maximumBytes,
  };
  const { entryAttributes, html: htmlWithoutEntry, entryFile } = extractModuleEntry(
    sourceHtml,
    context,
  );
  const bundledEntry = await bundleEntry(entryFile, context);
  const htmlWithInlineScripts = inlineScriptElements(htmlWithoutEntry, sourceIndexFile, context);
  const htmlWithLinkedStyles = inlineStylesheets(htmlWithInlineScripts, sourceIndexFile, context);
  const htmlWithStyles = inlineStyleElements(htmlWithLinkedStyles, sourceIndexFile, context);
  const htmlWithAssets = inlineHtmlAssets(htmlWithStyles, sourceIndexFile, context);
  const finalHtml = assembleOfflineHtml(htmlWithAssets, bundledEntry, entryAttributes);
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

  const entryFileOutput = path.join(outputDir, 'index.html');
  const readmeFile = path.join(outputDir, 'README.txt');
  const evidenceFile = path.join(outputDir, 'offline-playtest.json');
  writeOfflinePlaytestOutput(outputDir, {
    'README.txt': renderOfflinePlaytestReadme(evidence),
    'index.html': finalHtml,
    'offline-playtest.json': `${JSON.stringify(evidence, undefined, 2)}\n`,
  });

  return {
    outputDir,
    entryFile: entryFileOutput,
    readmeFile,
    evidenceFile,
    evidence,
  };
}

function writeOfflinePlaytestOutput(
  outputDir: string,
  files: Readonly<Record<'README.txt' | 'index.html' | 'offline-playtest.json', string>>,
): void {
  const parentDir = path.dirname(outputDir);
  const outputName = path.basename(outputDir);
  mkdirSync(parentDir, { recursive: true });
  const stagingDir = mkdtempSync(path.join(parentDir, `.${outputName}.staging-`));

  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(stagingDir, name), content);
    }

    replaceGeneratedOutputDirectory(outputDir, stagingDir);
  } catch (error) {
    if (existsSync(stagingDir)) {
      rmSync(stagingDir, { force: true, recursive: true });
    }

    throw error;
  }
}

function replaceGeneratedOutputDirectory(outputDir: string, stagingDir: string): void {
  if (!existsSync(outputDir)) {
    renameSync(stagingDir, outputDir);
    return;
  }

  const parentDir = path.dirname(outputDir);
  const outputName = path.basename(outputDir);
  const backupDir = mkdtempSync(path.join(parentDir, `.${outputName}.backup-`));
  rmSync(backupDir, { recursive: true });
  renameSync(outputDir, backupDir);

  try {
    renameSync(stagingDir, outputDir);
  } catch (error) {
    try {
      renameSync(backupDir, outputDir);
    } catch (restoreError) {
      throw new Error(
        `Offline playtest failed to replace ${outputDir}; the previous output remains recoverable at ${backupDir}. Replacement error: ${errorMessage(error)}. Restore error: ${errorMessage(restoreError)}.`,
      );
    }

    throw error;
  }

  rmSync(backupDir, { recursive: true });
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
): {
  readonly entryAttributes: readonly HtmlAttributeToken[];
  readonly html: string;
  readonly entryFile: string;
} {
  if (html.includes(offlineEntryPlaceholder)) {
    throw new Error('Offline playtest source index.html contains the reserved entry marker.');
  }

  const matches = findHtmlScriptElements(html);
  const scripts = matches.map((match) => ({
    attributes: tokenizeHtmlAttributes(match[2] ?? ''),
    match,
  }));
  const externalScripts = scripts.filter(
    (script) => readHtmlAttributeToken(script.attributes, 'src') !== undefined,
  );
  const moduleEntries = externalScripts.filter(
    (script) =>
      readHtmlAttributeToken(script.attributes, 'type')?.trim().toLowerCase() === 'module'
      && !hasHtmlAttributeToken(script.attributes, 'nomodule'),
  );

  const entry = moduleEntries[0];

  if (entry === undefined || moduleEntries.length !== 1) {
    throw new Error('Offline playtest requires exactly one external module entry script.');
  }

  const match = entry.match;
  const source = readHtmlAttributeToken(entry.attributes, 'src');

  if (match?.[0] === undefined || source === undefined || match.index === undefined) {
    throw new Error('Unable to resolve the module entry script.');
  }

  const entryFile = resolveLocalReference(context.artifactRoot, context.artifactRoot, source);

  if (hasHtmlAttributeToken(entry.attributes, 'integrity')) {
    throw new Error('Offline playtest does not support integrity-protected entry scripts.');
  }

  for (const externalScript of externalScripts) {
    if (externalScript === entry) {
      continue;
    }

    if (!hasHtmlAttributeToken(externalScript.attributes, 'nomodule')) {
      throw new Error(
        'Offline playtest does not support additional external scripts beyond the module entry.',
      );
    }
  }

  const output = rewriteExternalScripts(
    html,
    externalScripts.map((script) => script.match),
    match,
  );

  return { entryAttributes: entry.attributes, html: output, entryFile };
}

function findHtmlScriptElements(html: string): readonly RegExpMatchArray[] {
  return findHtmlRawTextElements(html, 'script');
}

function findHtmlRawTextElements(
  html: string,
  elementName: 'script' | 'style',
): readonly RegExpMatchArray[] {
  const activeHtml = maskInertHtmlTemplateContents(html);
  return [...activeHtml.matchAll(createHtmlRawTextPattern())].filter(
    (match) => match[1]?.toLowerCase() === elementName,
  );
}

function maskInertHtmlTemplateContents(html: string): string {
  const structure = html.replace(
    createHtmlRawTextPattern(),
    (match) => maskTextPreservingLines(match),
  );
  const ranges: SourceRange[] = [];
  const stack: Array<{
    readonly childNamespace: HtmlNamespace;
    readonly name: string;
    readonly namespace: HtmlNamespace;
  }> = [];
  let depth = 0;
  let start: number | undefined;

  for (const tag of findHtmlTagTokens(structure)) {
    if (tag.closing) {
      let matchingIndex = -1;

      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]?.name === tag.name) {
          matchingIndex = index;
          break;
        }
      }

      if (matchingIndex === -1) {
        continue;
      }

      const removed = stack.splice(matchingIndex);
      const closedHtmlTemplates = removed.filter(
        (entry) => entry.name === 'template' && entry.namespace === 'html',
      ).length;

      if (closedHtmlTemplates === 0 || depth === 0) {
        continue;
      }

      depth = Math.max(0, depth - closedHtmlTemplates);

      if (depth === 0 && start !== undefined) {
        ranges.push({ start, end: tag.start });
        start = undefined;
      }

      continue;
    }

    const parentNamespace = stack.at(-1)?.childNamespace ?? 'html';
    const namespace = resolveHtmlTagNamespace(parentNamespace, tag.name);
    const childNamespace = resolveHtmlChildNamespace(namespace, tag);

    if (tag.name === 'template' && namespace === 'html') {
      start ??= tag.end;
      depth += 1;
    }

    const rawTag = structure.slice(tag.start, tag.end);

    if (
      !/\/\s*>$/u.test(rawTag)
      && !(namespace === 'html' && htmlVoidElementNames.has(tag.name))
    ) {
      stack.push({ childNamespace, name: tag.name, namespace });
    }
  }

  if (start !== undefined) {
    ranges.push({ start, end: html.length });
  }

  let cursor = 0;
  let output = '';

  for (const range of ranges) {
    output += html.slice(cursor, range.start);
    output += maskTextPreservingLines(html.slice(range.start, range.end));
    cursor = range.end;
  }

  return output + html.slice(cursor);
}

function resolveHtmlTagNamespace(
  parentNamespace: HtmlNamespace,
  tagName: string,
): HtmlNamespace {
  if (parentNamespace !== 'html') {
    return parentNamespace;
  }

  if (tagName === 'svg') {
    return 'svg';
  }

  if (tagName === 'math') {
    return 'mathml';
  }

  return 'html';
}

function resolveHtmlChildNamespace(
  namespace: HtmlNamespace,
  tag: HtmlTagToken,
): HtmlNamespace {
  if (namespace === 'svg' && ['desc', 'foreignobject', 'title'].includes(tag.name)) {
    return 'html';
  }

  if (
    namespace === 'mathml'
    && tag.name === 'annotation-xml'
    && ['application/xhtml+xml', 'text/html'].includes(
      readHtmlAttributeToken(tag.attributes, 'encoding')?.trim().toLowerCase() ?? '',
    )
  ) {
    return 'html';
  }

  return namespace;
}

function findHtmlTagTokens(source: string): readonly HtmlTagToken[] {
  const pattern = /<!--[\s\S]*?--!?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<(\/?)(([a-z][\w:-]*))(?=[\t\n\f\r \/>])((?:"[^"]*"|'[^']*'|[^'">])*)>/giu;
  const tokens: HtmlTagToken[] = [];

  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined || match[3] === undefined) {
      continue;
    }

    tokens.push({
      attributes: tokenizeHtmlAttributes(match[0]),
      closing: match[1] === '/',
      end: match.index + match[0].length,
      name: match[3].toLowerCase(),
      start: match.index,
    });
  }

  return tokens;
}

function findActiveHtmlStartTag(html: string, name: string): HtmlTagToken | undefined {
  const activeHtml = maskInertHtmlTemplateContents(html);
  const structure = activeHtml.replace(
    createHtmlRawTextPattern(),
    (match) => maskTextPreservingLines(match),
  );
  return findHtmlTagTokens(structure).find((tag) => !tag.closing && tag.name === name);
}

function maskTextPreservingLines(value: string): string {
  return value.replace(/[^\r\n]/gu, ' ');
}

function rewriteExternalScripts(
  html: string,
  matches: readonly RegExpMatchArray[],
  entry: RegExpMatchArray,
): string {
  let cursor = 0;
  let output = '';

  for (const match of [...matches].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))) {
    if (match.index === undefined || match[0] === undefined) {
      throw new Error('Unable to rewrite an external script in the offline playtest document.');
    }

    output += html.slice(cursor, match.index);
    output += match === entry ? offlineEntryPlaceholder : '';
    cursor = match.index + match[0].length;
  }

  return output + html.slice(cursor);
}

async function bundleEntry(entryFile: string, context: InliningContext): Promise<BundledEntry> {
  const deferredAssets = new Map<string, DeferredJavaScriptAsset>();
  const result = await build({
    entryPoints: [entryFile],
    absWorkingDir: context.artifactRoot,
    bundle: true,
    write: false,
    outfile: 'offline-playtest.js',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    keepNames: true,
    minify: true,
    metafile: true,
    sourcemap: false,
    legalComments: 'none',
    plugins: [offlineAssetInliningPlugin(context, deferredAssets)],
    logLevel: 'silent',
  });
  const scriptOutput = result.outputFiles.find((file) => file.path.endsWith('.js'));

  if (scriptOutput === undefined) {
    throw new Error('The offline playtest bundler did not produce JavaScript.');
  }

  recordRetainedBundledAssets(result.metafile, context);
  const script = resolveDeferredJavaScriptAssets(scriptOutput.text, deferredAssets, context);
  const stylesheetOutput = result.outputFiles.find((file) => file.path.endsWith('.css'));
  assertNoEntryImportMetaUrl(script);
  assertSupportedBundledRuntime(script);
  return {
    script,
    ...(stylesheetOutput === undefined ? {} : { stylesheet: stylesheetOutput.text }),
  };
}

function recordRetainedBundledAssets(
  metafile: Metafile,
  context: InliningContext,
): void {
  const retainedInputs = new Set<string>();

  for (const output of Object.values(metafile.outputs)) {
    for (const [input, metadata] of Object.entries(output.inputs)) {
      if (metadata.bytesInOutput <= 0) {
        continue;
      }

      const inputFile = path.resolve(context.artifactRoot, input);
      retainedInputs.add(existsSync(inputFile) ? realpathSync(inputFile) : inputFile);
    }
  }

  for (const candidate of context.bundledAssetCandidates) {
    if (retainedInputs.has(candidate)) {
      context.inlinedAssets.add(candidate);
    }
  }
}

function deferJavaScriptAsset(
  sourceFile: string,
  reference: string,
  deferredAssets: Map<string, DeferredJavaScriptAsset>,
  externalError?: string,
): string {
  // Keep source-relative provenance in a valid data URL until esbuild removes dead code.
  // Only markers retained in the final bundle are resolved, validated, and charged to limits.
  const marker = `data:application/x-mpgd-deferred;id=${randomUUID()},`;
  deferredAssets.set(marker, {
    reference,
    sourceFile,
    ...(externalError === undefined ? {} : { externalError }),
  });
  return marker;
}

function deferJavaScriptError(
  error: string,
  deferredAssets: Map<string, DeferredJavaScriptAsset>,
): string {
  const marker = `data:application/x-mpgd-deferred;id=${randomUUID()},`;
  deferredAssets.set(marker, { retainedError: error });
  return marker;
}

function resolveDeferredJavaScriptAssets(
  source: string,
  deferredAssets: ReadonlyMap<string, DeferredJavaScriptAsset>,
  context: InliningContext,
): string {
  let output = source;

  for (const [marker, asset] of deferredAssets) {
    if (!output.includes(marker)) {
      continue;
    }

    if ('retainedError' in asset) {
      throw new Error(asset.retainedError);
    }

    if (asset.externalError !== undefined && isNonLocalReference(asset.reference)) {
      throw new Error(asset.externalError);
    }

    const occurrenceCount = output.split(marker).length - 1;
    let dataUrl = '';

    for (let occurrence = 0; occurrence < occurrenceCount; occurrence += 1) {
      dataUrl = readAssetDataUrl(asset.sourceFile, asset.reference, context);
    }
    const safeDataUrl = dataUrl.replace(/["'`\\$\r\n]/gu, (character) =>
      `%${(character.codePointAt(0) ?? 0).toString(16).padStart(2, '0').toUpperCase()}`,
    );
    output = output.replaceAll(marker, safeDataUrl);
  }

  return output;
}

function offlineAssetInliningPlugin(
  context: InliningContext,
  deferredAssets: Map<string, DeferredJavaScriptAsset>,
): Plugin {
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
          contents: inlineJavaScriptAssetReferences(source, args.path, context, deferredAssets),
          loader: 'js',
          resolveDir: path.dirname(args.path),
        };
      });
      pluginBuild.onLoad({ filter: /\.json$/ }, (args) => {
        const jsonFile = resolveArtifactFile(context.artifactRoot, args.path);
        const source = readFileSync(jsonFile, 'utf8');
        context.bundledAssetCandidates.add(jsonFile);
        return {
          contents: source,
          loader: 'json',
          resolveDir: path.dirname(args.path),
        };
      });
      pluginBuild.onLoad({ filter: /\.css$/ }, (args) => {
        const cssFile = resolveArtifactFile(context.artifactRoot, args.path);
        const source = readFileSync(cssFile, 'utf8');
        context.bundledAssetCandidates.add(cssFile);
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
  deferredAssets?: Map<string, DeferredJavaScriptAsset>,
): string {
  const readAsset: AssetDataUrlReader = deferredAssets === undefined
    ? (assetSourceFile, reference, externalError) => {
        if (externalError !== undefined && isNonLocalReference(reference)) {
          throw new Error(externalError);
        }

        return readAssetDataUrl(assetSourceFile, reference, context);
      }
    : (assetSourceFile, reference, externalError) => deferJavaScriptAsset(
        assetSourceFile,
        reference,
        deferredAssets,
        externalError,
      );
  const deferError: JavaScriptErrorDeferrer | undefined = deferredAssets === undefined
    ? undefined
    : (error) => deferJavaScriptError(error, deferredAssets);
  const staticUrlPattern = /(?<![$\u200C\u200D\p{ID_Continue}])new\s+(?:(globalThis|self|window)\s*\.\s*)?URL\(\s*(?:"((?:\\(?:\r\n|[\s\S])|[^"\\\r\n])*)"|'((?:\\(?:\r\n|[\s\S])|[^'\\\r\n])*)'|`((?:\\(?:\r\n|[\s\S])|[^`\\\r\n])*)`)\s*,\s*import\.meta\.url\s*\)(\s*\.\s*href)?/gu;
  const sourceCodePositions = createCodePositionMap(source, true);
  let output = source.replace(
    staticUrlPattern,
    (
      match,
      qualifier: string | undefined,
      doubleQuotedReference: string | undefined,
      singleQuotedReference: string | undefined,
      templateReference: string | undefined,
      hrefAccess: string | undefined,
      offset: number,
    ) => {
      if (
        sourceCodePositions[offset] !== 1
        || hasEscapedJavaScriptIdentifierContinuationBefore(source, offset, sourceCodePositions)
        || findVisibleJavaScriptIdentifierBinding(
          source,
          qualifier ?? 'URL',
          offset,
          sourceCodePositions,
        ) !== undefined
      ) {
        return match;
      }

      if (
        templateReference !== undefined
        && containsUnescapedTemplateInterpolation(templateReference)
      ) {
        return match;
      }

      const rawReference = doubleQuotedReference ?? singleQuotedReference ?? templateReference ?? '';
      const reference = decodeJavaScriptStringLiteral(rawReference);

      if (isDataUrlReference(reference)) {
        return hrefAccess === undefined
          ? `new ${qualifier === undefined ? '' : `${qualifier}.`}URL(${JSON.stringify(reference)})`
          : JSON.stringify(reference);
      }

      const dataUrl = readAsset(sourceFile, reference);
      return hrefAccess === undefined
        ? `new ${qualifier === undefined ? '' : `${qualifier}.`}URL(${JSON.stringify(dataUrl)})`
        : JSON.stringify(dataUrl);
    },
  );
  const documentFile = path.join(context.artifactRoot, 'index.html');
  const staticFetchPattern = /((?<![$.\u200C\u200D\p{ID_Continue}])(?:(?:globalThis|self|window)\s*\.\s*)?fetch\s*(?:\?\.\s*)?\((?:(?:\s+)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*)(?:"((?:\\(?:\r\n|[\s\S])|[^"\\\r\n])*)"|'((?:\\(?:\r\n|[\s\S])|[^'\\\r\n])*)'|`((?:\\(?:\r\n|[\s\S])|[^`\\\r\n])*)`)/gu;
  const fetchCodePositions = createCodePositionMap(output, true);
  output = output.replace(
    staticFetchPattern,
    (
      match,
      prefix: string,
      doubleQuotedReference: string | undefined,
      singleQuotedReference: string | undefined,
      templateReference: string | undefined,
      offset: number,
    ) => {
      const qualifier = /\b(globalThis|self|window)\s*\.\s*fetch\s*(?:\?\.\s*)?\(/u.exec(
        prefix,
      )?.[1];

      if (
        fetchCodePositions[offset] !== 1
        || hasEscapedJavaScriptIdentifierContinuationBefore(
          output,
          offset,
          fetchCodePositions,
        )
        || (
          templateReference !== undefined
          && containsUnescapedTemplateInterpolation(templateReference)
        )
        || (
          qualifier === undefined
            ? findVisibleJavaScriptIdentifierBinding(
              output,
              'fetch',
              offset,
              fetchCodePositions,
            ) !== undefined
            : findVisibleJavaScriptIdentifierBinding(
              output,
              qualifier,
              offset,
              fetchCodePositions,
            ) !== undefined
        )
      ) {
        return match;
      }

      let quote = '`';

      if (doubleQuotedReference !== undefined) {
        quote = '"';
      } else if (singleQuotedReference !== undefined) {
        quote = "'";
      }
      const rawReference = doubleQuotedReference ?? singleQuotedReference ?? templateReference ?? '';
      const reference = decodeJavaScriptStringLiteral(rawReference);

      if (isDataUrlReference(reference)) {
        // Data URLs are portable; serialized blob URLs belong to another document's URL store.
        return match;
      }

      const dataUrl = escapeForQuote(
        readAsset(
          documentFile,
          reference,
          `Offline playtest does not support network fetch URL: ${reference}`,
        ),
        quote,
      );
      return `${prefix}${quote}${dataUrl}${quote}`;
    },
  );
  output = inlineStaticFetchArguments(output, documentFile, readAsset);
  const staticAudioPattern = /((?<![$.\u200C\u200D\p{ID_Continue}])new\s+(?:(?:globalThis|self|window)\s*\.\s*)?Audio\s*\((?:(?:\s+)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*)(?:"((?:\\(?:\r\n|[\s\S])|[^"\\\r\n])*)"|'((?:\\(?:\r\n|[\s\S])|[^'\\\r\n])*)'|`((?:\\(?:\r\n|[\s\S])|[^`\\\r\n])*)`)/gu;
  const audioCodePositions = createCodePositionMap(output, true);
  output = output.replace(
    staticAudioPattern,
    (
      match,
      prefix: string,
      doubleQuotedReference: string | undefined,
      singleQuotedReference: string | undefined,
      templateReference: string | undefined,
      offset: number,
    ) => {
      const qualifier = /\bnew\s+(globalThis|self|window)\s*\.\s*Audio\s*\(/u.exec(prefix)?.[1];

      if (
        audioCodePositions[offset] !== 1
        || (
          templateReference !== undefined
          && containsUnescapedTemplateInterpolation(templateReference)
        )
        || (
          qualifier === undefined
            ? findVisibleJavaScriptIdentifierBinding(
              output,
              'Audio',
              offset,
              audioCodePositions,
            ) !== undefined
            : findVisibleJavaScriptIdentifierBinding(
              output,
              qualifier,
              offset,
              audioCodePositions,
            ) !== undefined
        )
      ) {
        return match;
      }

      let quote = '`';

      if (doubleQuotedReference !== undefined) {
        quote = '"';
      } else if (singleQuotedReference !== undefined) {
        quote = "'";
      }
      const rawReference = doubleQuotedReference ?? singleQuotedReference ?? templateReference ?? '';
      const reference = decodeJavaScriptStringLiteral(rawReference);

      if (isDataUrlReference(reference)) {
        return match;
      }

      const dataUrl = escapeForQuote(
        readAsset(
          documentFile,
          reference,
          `Offline playtest does not support network Audio URL: ${reference}`,
        ),
        quote,
      );
      return `${prefix}${quote}${dataUrl}${quote}`;
    },
  );
  output = inlineStaticFontFaceSources(output, documentFile, context, readAsset);
  output = inlineStaticElementSourceAssignments(output, documentFile, readAsset);
  output = inlineStaticXmlHttpRequestOpenCalls(output, documentFile, readAsset, deferError);
  output = inlinePhaserAssetReferences(output, documentFile, readAsset);
  return output;
}

function inlineStaticFetchArguments(
  source: string,
  documentFile: string,
  readAsset: AssetDataUrlReader,
): string {
  const pattern = /(?<![$.\u200C\u200D\p{ID_Continue}])(?:(globalThis|self|window)\s*\.\s*)?(fetch)\s*(?:\?\.\s*)?\(/gu;
  const codePositions = createCodePositionMap(source, true);
  const replacements: SourceReplacement[] = [];

  for (const match of source.matchAll(pattern)) {
    if (
      match.index === undefined
      || match[2] === undefined
      || codePositions[match.index] !== 1
      || hasEscapedJavaScriptIdentifierContinuationBefore(source, match.index, codePositions)
    ) {
      continue;
    }

    const bindingIdentifier = match[1] ?? match[2];

    if (
      findVisibleJavaScriptIdentifierBinding(
        source,
        bindingIdentifier,
        match.index,
        codePositions,
      ) !== undefined
    ) {
      continue;
    }

    const openingParenthesis = match.index + match[0].length - 1;
    const argument = splitJavaScriptArguments(source, openingParenthesis, codePositions)[0];

    if (argument === undefined) {
      continue;
    }

    const reference = resolveStaticJavaScriptStringExpression(source, argument, codePositions);

    if (reference === undefined || isDataUrlReference(reference)) {
      continue;
    }

    replacements.push({
      start: argument.start,
      end: argument.end,
      value: JSON.stringify(
        readAsset(
          documentFile,
          reference,
          `Offline playtest does not support network fetch URL: ${reference}`,
        ),
      ),
    });
  }

  let output = source;

  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }

  return output;
}

function inlineStaticFontFaceSources(
  source: string,
  documentFile: string,
  context: InliningContext,
  readAsset: AssetDataUrlReader,
): string {
  const fontFacePattern = /((?<![$.\u200C\u200D\p{ID_Continue}])new\s+(?:(globalThis|self|window)\s*\.\s*)?FontFace\s*\(\s*(?:"(?:\\(?:\r\n|[\s\S])|[^"\\\r\n])*"|'(?:\\(?:\r\n|[\s\S])|[^'\\\r\n])*'|`(?:\\(?:\r\n|[\s\S])|[^`\\\r\n])*`)\s*,\s*)(?:"((?:\\(?:\r\n|[\s\S])|[^"\\\r\n])*)"|'((?:\\(?:\r\n|[\s\S])|[^'\\\r\n])*)'|`((?:\\(?:\r\n|[\s\S])|[^`\\\r\n])*)`)/gu;
  const codePositions = createCodePositionMap(source, true);

  return source.replace(
    fontFacePattern,
    (
      match,
      prefix: string,
      qualifier: string | undefined,
      doubleQuotedSource: string | undefined,
      singleQuotedSource: string | undefined,
      templateSource: string | undefined,
      offset: number,
    ) => {
      if (
        codePositions[offset] !== 1
        || hasEscapedJavaScriptIdentifierContinuationBefore(source, offset, codePositions)
        || (
          templateSource !== undefined
          && containsUnescapedTemplateInterpolation(templateSource)
        )
        || (
          qualifier === undefined
            ? findVisibleJavaScriptIdentifierBinding(
              source,
              'FontFace',
              offset,
              codePositions,
            ) !== undefined
            : findVisibleJavaScriptIdentifierBinding(
              source,
              qualifier,
              offset,
              codePositions,
            ) !== undefined
        )
      ) {
        return match;
      }

      const rawSource = doubleQuotedSource ?? singleQuotedSource ?? templateSource ?? '';
      const descriptor = decodeJavaScriptStringLiteral(rawSource);
      const inlinedDescriptor = inlineCssAssetReferences(
        descriptor,
        documentFile,
        context,
        readAsset,
      );
      return `${prefix}${JSON.stringify(inlinedDescriptor)}`;
    },
  );
}

function inlineStaticElementSourceAssignments(
  source: string,
  documentFile: string,
  readAsset: AssetDataUrlReader,
): string {
  const assignmentPattern = new RegExp(
    `(?<![$.\\u200C\\u200D\\p{ID_Continue}])(${javascriptIdentifierPatternSource})${javascriptTriviaPatternSource}\\.${javascriptTriviaPatternSource}src${javascriptTriviaPatternSource}=`,
    'gu',
  );
  const computedAssignmentPattern = new RegExp(
    `(?<![$.\\u200C\\u200D\\p{ID_Continue}])(${javascriptIdentifierPatternSource})${javascriptTriviaPatternSource}\\[`,
    'gu',
  );
  const setAttributePattern = new RegExp(
    `(?<![$.\\u200C\\u200D\\p{ID_Continue}])(${javascriptIdentifierPatternSource})${javascriptTriviaPatternSource}(?:\\.${javascriptTriviaPatternSource}|\\?\\.${javascriptTriviaPatternSource})setAttribute${javascriptTriviaPatternSource}(?:\\?\\.${javascriptTriviaPatternSource})?\\(`,
    'gu',
  );
  const codePositions = createCodePositionMap(source, true);
  const replacements: SourceReplacement[] = [];
  const hasMemberReceiverPrefix = (offset: number): boolean => {
    const previousCode = findPreviousJavaScriptCodeIndex(source, offset - 1, codePositions);
    return previousCode !== undefined && source[previousCode] === '.';
  };

  const addReplacement = (
    identifier: string,
    offset: number,
    referenceRange: SourceRange,
  ): void => {
    const proof = findStaticNativeElementBinding(source, identifier, offset, codePositions);

    if (proof === undefined) {
      return;
    }

    if (proof.binding.kind !== 'const') {
      throw new Error(
        `Offline playtest requires an immutable ${proof.constructorName} binding before rewriting src.`,
      );
    }

    const reference = resolveStaticJavaScriptStringExpression(
      source,
      referenceRange,
      codePositions,
    );

    if (reference === undefined) {
      throw new Error(`Offline playtest requires a static ${proof.constructorName} src value.`);
    }

    if (isDataUrlReference(reference)) {
      return;
    }

    replacements.push({
      start: referenceRange.start,
      end: referenceRange.end,
      value: JSON.stringify(readAsset(
        documentFile,
        reference,
        `Offline playtest does not support network ${proof.constructorName} URL: ${reference}`,
      )),
    });
  };

  for (const match of source.matchAll(assignmentPattern)) {
    if (
      match.index === undefined
      || match[1] === undefined
      || codePositions[match.index] !== 1
      || hasEscapedJavaScriptIdentifierContinuationBefore(source, match.index, codePositions)
      || hasMemberReceiverPrefix(match.index)
      || ['=', '>'].includes(source[match.index + match[0].length] ?? '')
    ) {
      continue;
    }

    const referenceRange = findJavaScriptExpressionRange(
      source,
      match.index + match[0].length,
      source.length,
      codePositions,
      true,
    );
    addReplacement(match[1], match.index, referenceRange);
  }

  for (const match of source.matchAll(computedAssignmentPattern)) {
    if (
      match.index === undefined
      || match[1] === undefined
      || codePositions[match.index] !== 1
      || hasEscapedJavaScriptIdentifierContinuationBefore(source, match.index, codePositions)
      || hasMemberReceiverPrefix(match.index)
    ) {
      continue;
    }

    const openingBracket = match.index + match[0].length - 1;
    const propertyRange = findJavaScriptExpressionRange(
      source,
      openingBracket + 1,
      source.length,
      codePositions,
      false,
      true,
    );
    let closingBracket = propertyRange.end;

    while (
      closingBracket < source.length
      && (codePositions[closingBracket] !== 1 || /\s/u.test(source[closingBracket] ?? ''))
    ) {
      closingBracket += 1;
    }

    if (source[closingBracket] !== ']') {
      continue;
    }

    let equals = closingBracket + 1;

    while (
      equals < source.length
      && (codePositions[equals] !== 1 || /\s/u.test(source[equals] ?? ''))
    ) {
      equals += 1;
    }

    if (source[equals] !== '=' || ['=', '>'].includes(source[equals + 1] ?? '')) {
      continue;
    }

    const property = resolveStaticJavaScriptStringExpression(source, propertyRange, codePositions);

    if (property !== 'src') {
      const nativeElementProof = property === undefined
        ? findStaticNativeElementBinding(source, match[1], match.index, codePositions)
        : undefined;

      if (nativeElementProof !== undefined) {
        throw new Error('Offline playtest requires a static native element property assignment.');
      }

      continue;
    }

    const referenceRange = findJavaScriptExpressionRange(
      source,
      equals + 1,
      source.length,
      codePositions,
      true,
    );
    addReplacement(match[1], match.index, referenceRange);
  }

  for (const match of source.matchAll(setAttributePattern)) {
    if (
      match.index === undefined
      || match[1] === undefined
      || codePositions[match.index] !== 1
      || hasEscapedJavaScriptIdentifierContinuationBefore(source, match.index, codePositions)
      || hasMemberReceiverPrefix(match.index)
    ) {
      continue;
    }

    const openingParenthesis = match.index + match[0].length - 1;
    const arguments_ = splitJavaScriptArguments(source, openingParenthesis, codePositions);
    const attribute = arguments_[0] === undefined
      ? undefined
      : readStaticJavaScriptStringWithTrivia(source, arguments_[0], codePositions);
    const referenceRange = arguments_[1];

    if (attribute?.toLowerCase() !== 'src' || referenceRange === undefined) {
      continue;
    }

    addReplacement(match[1], match.index, referenceRange);
  }

  let output = source;

  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }

  return output;
}

function findStaticNativeElementBinding(
  source: string,
  identifier: string,
  position: number,
  codePositions: Uint8Array,
): Readonly<{
  binding: JavaScriptIdentifierBinding;
  constructorName: string;
}> | undefined {
  const binding = findVisibleJavaScriptIdentifierBinding(
    source,
    identifier,
    position,
    codePositions,
  );
  const rawInitializer = binding?.initializerRange === undefined
    ? undefined
    : source.slice(binding.initializerRange.start, binding.initializerRange.end).trim();
  const initializer = binding?.initializerRange === undefined
    ? undefined
    : maskNonCode(
      source.slice(binding.initializerRange.start, binding.initializerRange.end),
      codePositions.slice(binding.initializerRange.start, binding.initializerRange.end),
    ).trim();
  const constructor = initializer === undefined
    ? undefined
    : parseStaticElementConstructor(initializer, rawInitializer ?? initializer);
  const qualifier = constructor?.qualifier;
  const constructorName = constructor?.constructorName;

  if (
    binding === undefined
    || initializer === undefined
    || binding.start >= position
    || constructorName === undefined
    || (
      qualifier === undefined
        ? findVisibleJavaScriptIdentifierBinding(
          source,
          constructorName,
          binding.initializerRange?.start ?? position,
          codePositions,
        ) !== undefined
        : findVisibleJavaScriptIdentifierBinding(
          source,
          qualifier,
          binding.initializerRange?.start ?? position,
          codePositions,
        ) !== undefined
    )
  ) {
    return undefined;
  }

  return { binding, constructorName };
}

function resolveStaticJavaScriptStringExpression(
  source: string,
  expressionRange: SourceRange,
  codePositions: Uint8Array,
): string | undefined {
  const direct = readStaticJavaScriptStringWithTrivia(source, expressionRange, codePositions);

  if (direct !== undefined) {
    return direct;
  }

  const expression = maskNonCode(
    source.slice(expressionRange.start, expressionRange.end),
    codePositions.slice(expressionRange.start, expressionRange.end),
  ).trim();

  if (!exactJavaScriptIdentifierPattern.test(expression)) {
    return undefined;
  }

  let identifierOffset = expressionRange.start;

  while (
    identifierOffset < expressionRange.end
    && (codePositions[identifierOffset] !== 1 || /\s/u.test(source[identifierOffset] ?? ''))
  ) {
    identifierOffset += 1;
  }

  if (source.slice(identifierOffset, identifierOffset + expression.length) !== expression) {
    return undefined;
  }

  const binding = findVisibleJavaScriptIdentifierBinding(
    source,
    expression,
    identifierOffset,
    codePositions,
  );

  if (
    binding?.kind !== 'const'
    || binding.initializerRange === undefined
    || binding.start >= identifierOffset
  ) {
    return undefined;
  }

  return readStaticJavaScriptStringWithTrivia(source, binding.initializerRange, codePositions);
}

function parseStaticElementConstructor(
  initializer: string,
  rawInitializer: string,
): Readonly<{ constructorName: string; qualifier: string | undefined }> | undefined {
  const constructor = /^new\s+(?:(globalThis|self|window)\s*\.\s*)?(Audio|Image)(?=\s|\(|$)/u.exec(
    initializer,
  );

  if (constructor?.[2] === undefined) {
    const initializerCodePositions = createCodePositionMap(rawInitializer, true);
    const normalizedInitializer = maskNonCode(
      rawInitializer,
      initializerCodePositions,
    ).trim();
    const createdElement = /^(?:(globalThis|self|window)\s*\.\s*)?document\s*\.\s*createElement\s*\(\s*\)\s*$/u.exec(
      normalizedInitializer,
    );
    let openingParenthesis = -1;

    for (let index = 0; index < rawInitializer.length; index += 1) {
      if (rawInitializer[index] === '(' && initializerCodePositions[index] === 1) {
        openingParenthesis = index;
        break;
      }
    }
    const arguments_ = openingParenthesis === -1
      ? []
      : splitJavaScriptArguments(rawInitializer, openingParenthesis, initializerCodePositions);
    const tagName = arguments_[0] === undefined || arguments_.length !== 1
      ? undefined
      : readStaticJavaScriptStringWithTrivia(
          rawInitializer,
          arguments_[0],
          initializerCodePositions,
        )?.toLowerCase();
    const supportedTagNames = new Set(['audio', 'img', 'source', 'track', 'video']);

    return createdElement === null || tagName === undefined || !supportedTagNames.has(tagName)
      ? undefined
      : {
          constructorName: `HTML ${tagName} element`,
          qualifier: createdElement[1] ?? 'document',
        };
  }

  const result = { constructorName: constructor[2], qualifier: constructor[1] };
  const suffix = initializer.slice(constructor[0].length).trim();

  if (suffix.length === 0) {
    return result;
  }

  if (suffix[0] !== '(') {
    return undefined;
  }

  let depth = 0;

  for (let index = 0; index < suffix.length; index += 1) {
    if (suffix[index] === '(') {
      depth += 1;
    } else if (suffix[index] === ')') {
      depth -= 1;

      if (depth === 0) {
        return suffix.slice(index + 1).trim().length === 0 ? result : undefined;
      }
    }
  }

  return undefined;
}

function inlineStaticXmlHttpRequestOpenCalls(
  source: string,
  documentFile: string,
  readAsset: AssetDataUrlReader,
  deferError: JavaScriptErrorDeferrer | undefined,
): string {
  const pattern = new RegExp(
    `(?<![$.\\u200C\\u200D\\p{ID_Continue}])(${javascriptIdentifierPatternSource})\\s*\\.\\s*open\\s*\\(`,
    'gu',
  );
  const codePositions = createCodePositionMap(source, true);
  const replacements: SourceReplacement[] = [];

  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined || codePositions[match.index] !== 1 || match[1] === undefined) {
      continue;
    }

    const receiver = match[1];
    const openingParenthesis = match.index + match[0].length - 1;
    const arguments_ = splitJavaScriptArguments(source, openingParenthesis, codePositions);
    const urlArgument = arguments_[1];
    const binding = findVisibleJavaScriptIdentifierBinding(
      source,
      receiver,
      match.index,
      codePositions,
    );
    const assignment = binding === undefined
      ? undefined
      : resolveLastDirectJavaScriptAssignment(
          source,
          receiver,
          binding,
          match.index,
          codePositions,
        );
    const assignmentProof = assignment?.range;

    if (assignment?.ambiguous === true) {
      const error = 'Offline playtest requires an unambiguous XMLHttpRequest assignment before rewriting open.';

      if (deferError !== undefined && urlArgument !== undefined) {
        replacements.push({
          start: urlArgument.start,
          end: urlArgument.end,
          value: JSON.stringify(deferError(error)),
        });
        continue;
      }

      throw new Error(error);
    }

    const isNativeXmlHttpRequest = assignmentProof === undefined
      ? isXmlHttpRequestBinding(source, binding, codePositions)
      : isNativeXmlHttpRequestExpression(source, assignmentProof, codePositions);

    if (
      binding === undefined
      || binding.start >= match.index
      || !isNativeXmlHttpRequest
    ) {
      continue;
    }

    if (binding.kind !== 'const') {
      const error = 'Offline playtest requires an immutable XMLHttpRequest binding before rewriting open.';

      if (deferError !== undefined && urlArgument !== undefined) {
        replacements.push({
          start: urlArgument.start,
          end: urlArgument.end,
          value: JSON.stringify(deferError(error)),
        });
        continue;
      }

      throw new Error(error);
    }

    if (urlArgument === undefined) {
      continue;
    }

    const reference = resolveStaticJavaScriptStringExpression(source, urlArgument, codePositions);

    if (reference === undefined || isDataUrlReference(reference)) {
      continue;
    }

    replacements.push({
      start: urlArgument.start,
      end: urlArgument.end,
      value: JSON.stringify(readAsset(
        documentFile,
        reference,
        `Offline playtest does not support network XMLHttpRequest URL: ${reference}`,
      )),
    });
  }

  let output = source;

  for (const replacement of replacements.reverse()) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }

  return output;
}

function isXmlHttpRequestBinding(
  source: string,
  binding: JavaScriptIdentifierBinding | undefined,
  codePositions: Uint8Array,
): boolean {
  if (
    binding?.initializerRange === undefined
    || binding.start < 0
  ) {
    return false;
  }

  return isNativeXmlHttpRequestExpression(source, binding.initializerRange, codePositions);
}

function resolveLastDirectJavaScriptAssignment(
  source: string,
  identifier: string,
  binding: JavaScriptIdentifierBinding,
  position: number,
  codePositions: Uint8Array,
): JavaScriptAssignmentResolution {
  const identifierPattern = new RegExp(
    `(?<![$.\\u200C\\u200D\\p{ID_Continue}])${escapeRegExp(identifier)}(?![$\\u200C\\u200D\\p{ID_Continue}])`,
    'gu',
  );

  const assignments: {
    readonly range: SourceRange;
    readonly scopePath: readonly number[];
    readonly standalone: boolean;
  }[] = [];
  const scopePath = [...findJavaScriptScopePath(source, binding.start, codePositions)];
  let scopeCursor = binding.start;

  const advanceScopePath = (end: number): void => {
    for (let index = scopeCursor; index < end; index += 1) {
      if (codePositions[index] !== 1) {
        continue;
      }

      if (source[index] === '{') {
        scopePath.push(index);
      } else if (source[index] === '}') {
        scopePath.pop();
      }
    }

    scopeCursor = end;
  };

  for (const match of source.slice(binding.start, position).matchAll(identifierPattern)) {
    if (match.index === undefined) {
      continue;
    }

    const assignmentStart = binding.start + match.index;
    let equals = assignmentStart + match[0].length;

    while (
      equals < position
      && (codePositions[equals] !== 1 || /\s/u.test(source[equals] ?? ''))
    ) {
      equals += 1;
    }

    if (
      codePositions[assignmentStart] !== 1
      || source[equals] !== '='
      || source[equals + 1] === '='
      || source[equals + 1] === '>'
      || findVisibleJavaScriptIdentifierBinding(
        source,
        identifier,
        assignmentStart,
        codePositions,
      )?.start !== binding.start
    ) {
      continue;
    }

    const expressionStart = equals + 1;
    const expressionRange = findJavaScriptExpressionRange(
      source,
      expressionStart,
      position,
      codePositions,
      true,
    );

    advanceScopePath(assignmentStart);

    let previous = assignmentStart - 1;

    while (
      previous >= binding.start
      && (codePositions[previous] !== 1 || /\s/u.test(source[previous] ?? ''))
    ) {
      previous -= 1;
    }

    assignments.push({
      range: expressionRange,
      scopePath: [...scopePath],
      standalone: binding.initializerRange?.start === expressionRange.start
        || previous < binding.start
        || /[;{}]/u.test(source[previous] ?? ''),
    });
  }

  advanceScopePath(position);

  let ambiguous = false;
  let range: SourceRange | undefined;

  // A standalone assignment in the loader call's exact block path dominates earlier
  // candidates. A later nested or control-expression assignment can execute only on
  // some paths, so keep the resolution ambiguous until another direct assignment wins.
  for (const assignment of assignments) {
    const isDirect = assignment.standalone
      && assignment.scopePath.length === scopePath.length
      && assignment.scopePath.every((scope, index) => scopePath[index] === scope);

    if (isDirect) {
      range = assignment.range;
      ambiguous = false;
    } else {
      ambiguous = true;
    }
  }

  return range === undefined ? { ambiguous } : { ambiguous, range };
}

function isNativeXmlHttpRequestExpression(
  source: string,
  expressionRange: SourceRange,
  codePositions: Uint8Array,
): boolean {
  const initializer = maskNonCode(
    source.slice(expressionRange.start, expressionRange.end),
    codePositions.slice(expressionRange.start, expressionRange.end),
  ).trim();
  const match = /^new\s+(?:(globalThis|self|window)\s*\.\s*)?XMLHttpRequest\s*(?:\(\s*\))?$/u.exec(
    initializer,
  );

  if (match === null) {
    return false;
  }

  if (match[1] !== undefined) {
    return findVisibleJavaScriptIdentifierBinding(
      source,
      match[1],
      expressionRange.start,
      codePositions,
    ) === undefined;
  }

  let constructorOffset = source.indexOf('XMLHttpRequest', expressionRange.start);

  while (
    constructorOffset >= expressionRange.start
    && constructorOffset < expressionRange.end
    && codePositions[constructorOffset] !== 1
  ) {
    constructorOffset = source.indexOf('XMLHttpRequest', constructorOffset + 1);
  }

  return constructorOffset >= expressionRange.start
    && constructorOffset < expressionRange.end
    && findVisibleJavaScriptIdentifierBinding(
      source,
      'XMLHttpRequest',
      constructorOffset,
      codePositions,
    ) === undefined;
}

function readStaticJavaScriptString(source: string, range: SourceRange): string | undefined {
  const value = source.slice(range.start, range.end).trim();
  const match = /^(?:"((?:\\(?:\r\n|[\s\S])|[^"\\\r\n])*)"|'((?:\\(?:\r\n|[\s\S])|[^'\\\r\n])*)'|`((?:\\(?:\r\n|[\s\S])|[^`\\\r\n])*)`)$/u.exec(
    value,
  );
  const rawReference = match?.[1] ?? match?.[2] ?? match?.[3];

  if (rawReference === undefined || (match?.[3] !== undefined && containsUnescapedTemplateInterpolation(
    rawReference,
  ))) {
    return undefined;
  }

  return normalizeUrlReference(decodeJavaScriptStringLiteral(rawReference));
}

function readStaticJavaScriptStringWithTrivia(
  source: string,
  range: SourceRange,
  codePositions: Uint8Array,
): string | undefined {
  let start = range.start;

  while (
    start < range.end
    && (/\s/u.test(source[start] ?? '') || codePositions[start] === 0)
  ) {
    start += 1;
  }

  const quote = source[start];

  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return undefined;
  }

  let end: number | undefined;

  for (let index = start + 1; index < range.end; index += 1) {
    if (source[index] === '\\') {
      index += 1;
    } else if (source[index] === quote) {
      end = index + 1;
      break;
    }
  }

  if (end === undefined) {
    return undefined;
  }

  for (let index = end; index < range.end; index += 1) {
    if (codePositions[index] === 1 && !/\s/u.test(source[index] ?? '')) {
      return undefined;
    }
  }

  return readStaticJavaScriptString(source, { start, end });
}

function inlinePhaserAssetReferences(
  source: string,
  documentFile: string,
  readAsset: AssetDataUrlReader,
): string {
  const normalizedSource = normalizeStaticJavaScriptPropertyKeys(source);
  const discoveryCodePositions = createCodePositionMap(normalizedSource, true);
  assertSupportedPhaserLoaderConfiguration(normalizedSource);
  const loaderRanges = findPhaserLoaderUrlRanges(normalizedSource, discoveryCodePositions);
  const manifestProofs = findProvenPhaserManifestProperties(
    normalizedSource,
    loaderRanges,
    discoveryCodePositions,
  );
  const manifestRanges = findPhaserManifestUrlRanges(
    normalizedSource,
    discoveryCodePositions,
    manifestProofs,
  );
  const codePositions = createCodePositionMap(source, true);
  const ranges: SourceRange[] = [...manifestRanges, ...loaderRanges];
  const identifierRanges = [
    ...manifestRanges.filter((range) => range.traceIdentifiers),
    ...loaderRanges,
  ];
  let identifierUses = collectJavaScriptIdentifierUses(source, identifierRanges, codePositions);

  for (let pass = 0; pass < 4; pass += 1) {
    const initializerRanges = findIdentifierInitializerRanges(source, identifierUses, codePositions)
      .filter((range) => !ranges.some((candidate) => rangesOverlap(candidate, range)));

    if (initializerRanges.length === 0) {
      break;
    }

    ranges.push(...initializerRanges);
    identifierUses = collectJavaScriptIdentifierUses(source, initializerRanges, codePositions);

    if (identifierUses.length === 0) {
      break;
    }
  }

  const literalPattern = /"((?:\\(?:\r\n|[\s\S])|[^"\\\r\n])*)"|'((?:\\(?:\r\n|[\s\S])|[^'\\\r\n])*)'|`((?:\\(?:\r\n|[\s\S])|[^`\\\r\n])*)`/gu;
  const replacements: SourceReplacement[] = [];

  for (const range of ranges) {
    literalPattern.lastIndex = range.start;
    let match = literalPattern.exec(source);

    while (match !== null && match.index < range.end) {
      const previousIndex = match.index - 1;

      if (
        match.index + match[0].length <= range.end
        && (previousIndex < range.start || codePositions[previousIndex] === 1)
      ) {
        const rawReference = match[1] ?? match[2] ?? match[3] ?? '';
        const isTemplateLiteral = match[3] !== undefined;

        if (!isTemplateLiteral || !containsUnescapedTemplateInterpolation(rawReference)) {
          const reference = normalizeUrlReference(decodeJavaScriptStringLiteral(rawReference));

          if (!isDataUrlReference(reference)) {
            replacements.push({
              start: match.index,
              end: match.index + match[0].length,
              value: JSON.stringify(readAsset(documentFile, reference)),
            });
          }
        }
      }

      match = literalPattern.exec(source);
    }
  }

  const uniqueReplacements = new Map<string, SourceReplacement>();

  for (const replacement of replacements) {
    uniqueReplacements.set(`${replacement.start}:${replacement.end}`, replacement);
  }
  let output = source;

  for (const replacement of [...uniqueReplacements.values()].sort(
    (left, right) => right.start - left.start,
  )) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }

  return output;
}

function assertSupportedPhaserLoaderConfiguration(source: string): void {
  const normalizedSource = normalizeStaticJavaScriptPropertyAccess(source);
  const codePositions = createCodePositionMap(normalizedSource, true);
  const receiverPattern = `(?<![$.\\u200C\\u200D\\p{ID_Continue}])(${javascriptIdentifierPatternSource})`;
  const pattern = new RegExp(
    `${receiverPattern}\\s*\\.\\s*load\\s*\\.\\s*(?:setBaseURL|setPath)\\s*\\(`,
    'gu',
  );

  for (const match of normalizedSource.matchAll(pattern)) {
    if (
      match.index !== undefined
      && match[1] !== undefined
      && codePositions[match.index] === 1
      && isProvenPhaserLoaderReceiver(normalizedSource, match[1], match.index, codePositions)
    ) {
      throw new Error('Offline playtest does not support Phaser loader base URL or path prefixes.');
    }
  }

  const unsupportedMethods = [...unsupportedPhaserLoaderMethods]
    .map(escapeRegExp)
    .join('|');
  const unsupportedPattern = new RegExp(
    `${receiverPattern}\\s*\\.\\s*load\\s*\\.\\s*(${unsupportedMethods})\\s*\\(`,
    'gu',
  );

  for (const match of normalizedSource.matchAll(unsupportedPattern)) {
    if (
      match.index !== undefined
      && match[1] !== undefined
      && codePositions[match.index] === 1
      && isProvenPhaserLoaderReceiver(normalizedSource, match[1], match.index, codePositions)
    ) {
      throw new Error(`Offline playtest does not support Phaser ${match[2]} loader assets.`);
    }
  }
}

function findPhaserManifestUrlRanges(
  source: string,
  codePositions: Uint8Array,
  proofs: readonly PhaserManifestProof[],
): PhaserManifestUrlRange[] {
  const propertyPattern = new RegExp(
    `\\b(${[...phaserManifestUrlPropertyNames].map(escapeRegExp).join('|')})\\s*:`,
    'gu',
  );
  const ranges: PhaserManifestUrlRange[] = [];

  for (const match of source.matchAll(propertyPattern)) {
    if (match.index === undefined || codePositions[match.index] !== 1) {
      continue;
    }

    const propertyName = match[1] ?? '';

    if (!phaserManifestUrlPropertyNames.has(propertyName)) {
      continue;
    }

    const objectRange = findContainingJavaScriptObject(source, match.index, codePositions);

    if (objectRange === undefined) {
      continue;
    }

    const objectCode = maskNonCode(
      source.slice(objectRange.start, objectRange.end),
      codePositions.slice(objectRange.start, objectRange.end),
    );

    const hasSupportedKind = hasSupportedPhaserManifestKind(source, objectRange, codePositions);
    const hasLoaderProof = proofs.some(
      (proof) =>
        proof.propertyName === propertyName
        && objectRange.start >= proof.initializerRange.start
        && objectRange.end <= proof.initializerRange.end,
    );

    if (!/\bkey\s*:/u.test(objectCode) || (!hasSupportedKind && !hasLoaderProof)) {
      continue;
    }

    const colon = source.indexOf(':', match.index);
    const valueRange = findJavaScriptExpressionRange(
      source,
      colon + 1,
      objectRange.end - 1,
      codePositions,
    );
    ranges.push({ ...valueRange, traceIdentifiers: true });
  }

  return ranges;
}

function hasSupportedPhaserManifestKind(
  source: string,
  objectRange: SourceRange,
  codePositions: Uint8Array,
): boolean {
  const kindPattern = /\bkind\s*:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)')/gu;
  kindPattern.lastIndex = objectRange.start;
  let match = kindPattern.exec(source);

  while (match !== null && match.index < objectRange.end) {
    if (codePositions[match.index] === 1) {
      const containingObject = findContainingJavaScriptObject(source, match.index, codePositions);

      if (
        containingObject?.start === objectRange.start
        && containingObject.end === objectRange.end
        && phaserManifestKinds.has(match[1] ?? match[2] ?? '')
      ) {
        return true;
      }
    }

    match = kindPattern.exec(source);
  }

  return false;
}

function findProvenPhaserManifestProperties(
  source: string,
  loaderRanges: readonly SourceRange[],
  codePositions: Uint8Array,
): readonly PhaserManifestProof[] {
  // Legacy manifests omit `kind`, so constrain them to the nearest array binding whose
  // for-of element property is passed directly to a recognized Phaser loader URL argument.
  const memberPattern = new RegExp(
    `^\\s*(${javascriptIdentifierPatternSource})\\s*\\.\\s*(${javascriptIdentifierPatternSource})\\s*$`,
    'u',
  );
  const loopPattern = new RegExp(
    `\\bfor\\s*\\(\\s*(?:const|let|var)\\s+(${javascriptIdentifierPatternSource})\\s+of\\s+(${javascriptIdentifierPatternSource})\\s*\\)`,
    'gu',
  );
  const proofs = new Map<string, PhaserManifestProof>();

  for (const loaderRange of loaderRanges) {
    const member = memberPattern.exec(
      normalizeStaticJavaScriptPropertyAccess(source.slice(loaderRange.start, loaderRange.end)),
    );
    memberPattern.lastIndex = 0;
    const loopVariable = member?.[1];
    const propertyName = member?.[2];

    if (
      loopVariable === undefined
      || propertyName === undefined
      || !phaserManifestUrlPropertyNames.has(propertyName)
    ) {
      continue;
    }

    let nearestLoop:
      | { readonly bodyRange: SourceRange; readonly iterableIdentifier: string; readonly start: number }
      | undefined;

    for (const loop of source.matchAll(loopPattern)) {
      if (
        loop.index === undefined
        || codePositions[loop.index] !== 1
        || loop[1] !== loopVariable
        || loop[2] === undefined
      ) {
        continue;
      }

      const bodyRange = findJavaScriptLoopBodyRange(
        source,
        loop.index + loop[0].length,
        codePositions,
      );

      if (
        bodyRange === undefined
        || loaderRange.start < bodyRange.start
        || loaderRange.end > bodyRange.end
      ) {
        continue;
      }

      if (nearestLoop === undefined || bodyRange.start > nearestLoop.bodyRange.start) {
        nearestLoop = {
          bodyRange,
          iterableIdentifier: loop[2],
          start: loop.index,
        };
      }
    }

    if (nearestLoop === undefined) {
      continue;
    }

    const initializerRange = findLexicallyVisibleArrayInitializerRange(
      source,
      nearestLoop.iterableIdentifier,
      nearestLoop.start,
      codePositions,
    );

    if (initializerRange !== undefined) {
      proofs.set(`${propertyName}:${initializerRange.start}:${initializerRange.end}`, {
        initializerRange,
        propertyName,
      });
    }
  }

  return [...proofs.values()];
}

function findLexicallyVisibleArrayInitializerRange(
  source: string,
  identifier: string,
  position: number,
  codePositions: Uint8Array,
): SourceRange | undefined {
  // Legacy manifests are rewritten only when one concrete binding is visible at the loop.
  // A nearer block declaration or parameter must win over a same-named outer array.
  const declaration = findVisibleJavaScriptIdentifierBinding(
    source,
    identifier,
    position,
    codePositions,
  );

  if (
    declaration === undefined
    || declaration.initializerRange === undefined
    || declaration.kind === 'parameter'
    || declaration.start >= position
    || !source.slice(
      declaration.initializerRange.start,
      declaration.initializerRange.end,
    ).trimStart().startsWith('[')
  ) {
    return undefined;
  }

  return declaration.initializerRange;
}

function findVisibleJavaScriptIdentifierBinding(
  source: string,
  identifier: string,
  position: number,
  codePositions: Uint8Array,
): JavaScriptIdentifierBinding | undefined {
  // Resolve only bindings that are lexically visible at the use site. Ambiguous or
  // destructured bindings intentionally return an opaque result so callers do not rewrite.
  const targetScopePath = findJavaScriptScopePath(source, position, codePositions);
  const variablePattern = new RegExp(
    `\\b(const|let|var)\\s+(${javascriptIdentifierPatternSource})(\\s*=\\s*)?`,
    'gu',
  );
  const namedDeclarationPattern = new RegExp(
    `\\b(class|function)\\s*\\*?\\s+(${javascriptIdentifierPatternSource})`,
    'gu',
  );
  const destructuringPattern = /\b(const|let|var)\s*([\{\[])/gu;
  const importPattern = /\bimport\s+(?!["'`(])([\s\S]*?)\s+from\s*(?=["'`])/dgu;
  const declarations: JavaScriptIdentifierBinding[] = [];

  for (const match of source.matchAll(variablePattern)) {
    if (
      match.index === undefined
      || codePositions[match.index] !== 1
      || match[2] !== identifier
    ) {
      continue;
    }

    const declarationScopePath = findJavaScriptScopePath(source, match.index, codePositions);
    const kind = match[1] as 'const' | 'let' | 'var';
    const bindingPath = kind === 'var'
      ? declarationScopePath.slice(
          0,
          findJavaScriptFunctionScopeDepth(source, declarationScopePath, codePositions),
        )
      : declarationScopePath;

    if (!isJavaScriptScopePathPrefix(bindingPath, targetScopePath)) {
      continue;
    }

    const initializerStart = match[3] === undefined ? undefined : match.index + match[0].length;
    const declaration: JavaScriptIdentifierBinding = {
      bindingPath,
      kind,
      start: match.index,
    };

    declarations.push(initializerStart === undefined
      ? declaration
      : {
        ...declaration,
        initializerRange: findJavaScriptExpressionRange(
          source,
          initializerStart,
          source.length,
          codePositions,
          true,
        ),
      });
  }

  for (const match of source.matchAll(namedDeclarationPattern)) {
    if (
      match.index === undefined
      || codePositions[match.index] !== 1
      || match[2] !== identifier
    ) {
      continue;
    }

    const namedDeclaration = isJavaScriptNamedDeclaration(
      source,
      match.index,
      match[1] as 'class' | 'function',
      codePositions,
    );
    const expressionBody = namedDeclaration
      ? undefined
      : findJavaScriptNamedExpressionBody(source, match.index + match[0].length, codePositions);
    const bindingPath = expressionBody === undefined
      ? findJavaScriptScopePath(source, match.index, codePositions)
      : findJavaScriptScopePath(source, expressionBody + 1, codePositions);

    if (
      expressionBody !== undefined
      && !targetScopePath.includes(expressionBody)
    ) {
      continue;
    }

    if (isJavaScriptScopePathPrefix(bindingPath, targetScopePath)) {
      declarations.push({
        bindingPath,
        kind: match[1] as 'class' | 'function',
        start: match.index,
      });
    }
  }

  for (const match of source.matchAll(destructuringPattern)) {
    if (match.index === undefined || codePositions[match.index] !== 1) {
      continue;
    }

    const openingDelimiter = match.index + match[0].length - 1;
    const closingDelimiter = match[2] === '{' ? '}' : ']';
    const bindingInterior = findJavaScriptExpressionRange(
      source,
      openingDelimiter + 1,
      source.length,
      codePositions,
      false,
      true,
    );
    let bindingEnd = bindingInterior.end;

    while (
      bindingEnd < source.length
      && (codePositions[bindingEnd] !== 1 || /\s/u.test(source[bindingEnd] ?? ''))
    ) {
      bindingEnd += 1;
    }

    if (source[bindingEnd] !== closingDelimiter) {
      continue;
    }

    let equals = bindingEnd + 1;

    while (
      equals < source.length
      && (codePositions[equals] !== 1 || /\s/u.test(source[equals] ?? ''))
    ) {
      equals += 1;
    }

    if (source[equals] !== '=') {
      continue;
    }

    const bindingNames = collectJavaScriptBindingIdentifiers(
      source,
      { start: openingDelimiter, end: bindingEnd + 1 },
      codePositions,
    );

    if (!bindingNames.has(identifier)) {
      continue;
    }

    const declarationScopePath = findJavaScriptScopePath(source, match.index, codePositions);
    const bindingPath = match[1] === 'var'
      ? declarationScopePath.slice(
          0,
          findJavaScriptFunctionScopeDepth(source, declarationScopePath, codePositions),
        )
      : declarationScopePath;

    if (isJavaScriptScopePathPrefix(bindingPath, targetScopePath)) {
      declarations.push({ bindingPath, kind: 'unknown', start: match.index });
    }
  }

  for (const match of source.matchAll(importPattern)) {
    if (
      match.index === undefined
      || match[1] === undefined
      || match.indices?.[1] === undefined
      || codePositions[match.index] !== 1
    ) {
      continue;
    }

    const clauseIndices = match.indices[1];
    const importedNames = collectJavaScriptImportBindingNames(
      source,
      { start: clauseIndices[0], end: clauseIndices[1] },
      codePositions,
    );

    if (importedNames.has(identifier)) {
      declarations.push({ bindingPath: [], kind: 'unknown', start: match.index });
    }
  }

  const declarationDepth = declarations.reduce(
    (depth, declaration) => Math.max(depth, declaration.bindingPath.length),
    -1,
  );
  const parameterDepth = findJavaScriptParameterBindingDepth(
    source,
    targetScopePath,
    identifier,
    codePositions,
  );

  if (parameterDepth >= declarationDepth && parameterDepth >= 0) {
    return {
      bindingPath: targetScopePath.slice(0, parameterDepth),
      kind: 'parameter',
      start: -1,
    };
  }

  if (declarationDepth < 0) {
    return undefined;
  }

  const nearestDeclarations = declarations.filter(
    (declaration) => declaration.bindingPath.length === declarationDepth,
  );
  const lexicalDeclarations = nearestDeclarations.filter(
    (declaration) => declaration.kind !== 'var',
  );

  if (lexicalDeclarations.length === 1) {
    return lexicalDeclarations[0];
  }

  if (lexicalDeclarations.length > 1) {
    return {
      bindingPath: targetScopePath.slice(0, declarationDepth),
      kind: 'unknown',
      start: -1,
    };
  }

  return nearestDeclarations
    .filter((candidate) => candidate.start < position)
    .sort((left, right) => right.start - left.start)[0]
    ?? nearestDeclarations[0];
}

function isJavaScriptNamedDeclaration(
  source: string,
  keywordStart: number,
  kind: 'class' | 'function',
  codePositions: Uint8Array,
): boolean {
  // A declaration name belongs to the surrounding scope. An expression name is private to
  // that function or class, so peel only declaration modifiers before checking the boundary.
  let boundary = keywordStart - 1;

  while (true) {
    const previousCode = findPreviousJavaScriptCodeIndex(source, boundary, codePositions);

    if (previousCode === undefined || [';', '{', '}'].includes(source[previousCode] ?? '')) {
      return true;
    }

    if (!/[$\u200C\u200D\p{ID_Continue}]/u.test(source[previousCode] ?? '')) {
      return false;
    }

    const identifierStart = findJavaScriptIdentifierStart(source, previousCode, codePositions);
    const modifier = source.slice(identifierStart, previousCode + 1);

    if (
      modifier !== 'export'
      && modifier !== 'default'
      && (modifier !== 'async' || kind !== 'function')
    ) {
      return false;
    }

    boundary = identifierStart - 1;
  }
}

function findJavaScriptNamedExpressionBody(
  source: string,
  start: number,
  codePositions: Uint8Array,
): number | undefined {
  let roundDepth = 0;
  let squareDepth = 0;

  for (let index = start; index < source.length; index += 1) {
    if (codePositions[index] !== 1) {
      continue;
    }

    const character = source[index] ?? '';

    if (character === '(') {
      roundDepth += 1;
    } else if (character === ')') {
      roundDepth -= 1;
    } else if (character === '[') {
      squareDepth += 1;
    } else if (character === ']') {
      squareDepth -= 1;
    } else if (character === '{' && roundDepth === 0 && squareDepth === 0) {
      return index;
    }
  }

  return undefined;
}

function findJavaScriptScopePath(
  source: string,
  position: number,
  codePositions: Uint8Array,
): readonly number[] {
  const scopes: number[] = [];

  for (let index = 0; index < position; index += 1) {
    if (codePositions[index] !== 1) {
      continue;
    }

    if (source[index] === '{') {
      scopes.push(index);
    } else if (source[index] === '}') {
      scopes.pop();
    }
  }

  return scopes;
}

function isJavaScriptScopePathPrefix(
  candidate: readonly number[],
  target: readonly number[],
): boolean {
  return candidate.length <= target.length
    && candidate.every((scope, index) => target[index] === scope);
}

function findJavaScriptFunctionScopeDepth(
  source: string,
  scopePath: readonly number[],
  codePositions: Uint8Array,
): number {
  for (let index = scopePath.length - 1; index >= 0; index -= 1) {
    if (findJavaScriptBlockBindingHeader(
      source,
      scopePath[index] ?? 0,
      codePositions,
    )?.kind === 'function') {
      return index + 1;
    }
  }

  return 0;
}

function findJavaScriptParameterBindingDepth(
  source: string,
  scopePath: readonly number[],
  identifier: string,
  codePositions: Uint8Array,
): number {
  for (let index = scopePath.length - 1; index >= 0; index -= 1) {
    const header = findJavaScriptBlockBindingHeader(source, scopePath[index] ?? 0, codePositions);
    const parameterRanges = header === undefined
      ? []
      : splitJavaScriptTopLevelRanges(source, header.parameters, ',', codePositions);

    if (
      parameterRanges.some((range) =>
        collectJavaScriptBindingIdentifiers(source, range, codePositions).has(identifier),
      )
    ) {
      return index + 1;
    }
  }

  return -1;
}

function collectJavaScriptBindingIdentifiers(
  source: string,
  range: SourceRange,
  codePositions: Uint8Array,
): ReadonlySet<string> {
  // Defaults are expressions, not bindings; recursively inspect only the pattern to
  // distinguish `options = manifests` from `{ manifests }` and `{ key: manifests }`.
  let binding = trimSourceRange(source, range);

  if (source.slice(binding.start, binding.start + 3) === '...') {
    binding = trimSourceRange(source, { start: binding.start + 3, end: binding.end });
  }

  const equals = findJavaScriptTopLevelCharacter(source, binding, '=', codePositions);

  if (equals !== undefined) {
    binding = trimSourceRange(source, { start: binding.start, end: equals });
  }

  const firstCharacter = source[binding.start];
  const closingCharacter = source[binding.end - 1];
  const identifiers = new Set<string>();

  if (
    (firstCharacter === '{' && closingCharacter === '}')
    || (firstCharacter === '[' && closingCharacter === ']')
  ) {
    const entries = splitJavaScriptTopLevelRanges(
      source,
      { start: binding.start + 1, end: binding.end - 1 },
      ',',
      codePositions,
    );

    for (const entry of entries) {
      let nestedBinding = entry;

      if (firstCharacter === '{') {
        const colon = findJavaScriptTopLevelCharacter(source, entry, ':', codePositions);

        if (colon !== undefined) {
          nestedBinding = { start: colon + 1, end: entry.end };
        }
      }

      for (const identifier of collectJavaScriptBindingIdentifiers(
        source,
        nestedBinding,
        codePositions,
      )) {
        identifiers.add(identifier);
      }
    }

    return identifiers;
  }

  const identifierPattern = new RegExp(`^${javascriptIdentifierPatternSource}$`, 'u');
  const identifier = source.slice(binding.start, binding.end).trim();

  if (identifierPattern.test(identifier)) {
    identifiers.add(identifier);
  }

  return identifiers;
}

function splitJavaScriptTopLevelRanges(
  source: string,
  range: SourceRange,
  delimiter: string,
  codePositions: Uint8Array,
  terminator?: string,
): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  let start = range.start;
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = range.start; index <= range.end; index += 1) {
    if (index < range.end && codePositions[index] !== 1) {
      continue;
    }

    const character = source[index] ?? '';
    const atTopLevel = roundDepth === 0 && squareDepth === 0 && curlyDepth === 0;

    if (
      index === range.end
      || (atTopLevel && (character === delimiter || character === terminator))
    ) {
      const candidate = trimSourceRange(source, { start, end: index });

      if (candidate.start < candidate.end) {
        ranges.push(candidate);
      }

      if (character === terminator) {
        break;
      }

      start = index + 1;
      continue;
    }

    if (character === '(') {
      roundDepth += 1;
    } else if (character === ')') {
      roundDepth -= 1;
    } else if (character === '[') {
      squareDepth += 1;
    } else if (character === ']') {
      squareDepth -= 1;
    } else if (character === '{') {
      curlyDepth += 1;
    } else if (character === '}') {
      curlyDepth -= 1;
    }
  }

  return ranges;
}

function findJavaScriptTopLevelCharacter(
  source: string,
  range: SourceRange,
  target: string,
  codePositions: Uint8Array,
): number | undefined {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = range.start; index < range.end; index += 1) {
    if (codePositions[index] !== 1) {
      continue;
    }

    const character = source[index] ?? '';

    if (
      character === target
      && roundDepth === 0
      && squareDepth === 0
      && curlyDepth === 0
    ) {
      return index;
    }

    if (character === '(') {
      roundDepth += 1;
    } else if (character === ')') {
      roundDepth -= 1;
    } else if (character === '[') {
      squareDepth += 1;
    } else if (character === ']') {
      squareDepth -= 1;
    } else if (character === '{') {
      curlyDepth += 1;
    } else if (character === '}') {
      curlyDepth -= 1;
    }
  }

  return undefined;
}

function collectJavaScriptImportBindingNames(
  source: string,
  clauseRange: SourceRange,
  codePositions: Uint8Array,
): ReadonlySet<string> {
  const clause = maskNonCode(
    source.slice(clauseRange.start, clauseRange.end),
    codePositions.slice(clauseRange.start, clauseRange.end),
  ).trim().replace(/^type\s+/u, '');
  const names = new Set<string>();
  const defaultImport = importDefaultBindingPattern.exec(clause)?.[1];

  if (defaultImport !== undefined) {
    names.add(defaultImport);
  }

  const namespaceImport = importNamespaceBindingPattern.exec(clause)?.[1];

  if (namespaceImport !== undefined) {
    names.add(namespaceImport);
  }

  const namedStart = clause.indexOf('{');
  const namedEnd = clause.lastIndexOf('}');

  if (namedStart === -1 || namedEnd <= namedStart) {
    return names;
  }

  for (const rawSpecifier of clause.slice(namedStart + 1, namedEnd).split(',')) {
    const specifier = rawSpecifier.trim().replace(/^type\s+/u, '');
    const match = importNamedBindingPattern.exec(specifier);
    const localName = match?.[2] ?? match?.[1];

    if (localName !== undefined) {
      names.add(localName);
    }
  }

  return names;
}

function findJavaScriptBlockBindingHeader(
  source: string,
  blockStart: number,
  codePositions: Uint8Array,
): Readonly<{ kind: 'catch' | 'function'; parameters: SourceRange }> | undefined {
  const headerEnd = findPreviousJavaScriptCodeIndex(source, blockStart - 1, codePositions);

  if (headerEnd === undefined) {
    return undefined;
  }

  if (source[headerEnd] === '>') {
    const equals = findPreviousJavaScriptCodeIndex(source, headerEnd - 1, codePositions);

    if (equals === undefined || source[equals] !== '=') {
      return undefined;
    }

    const parameterEnd = findPreviousJavaScriptCodeIndex(source, equals - 1, codePositions);

    if (parameterEnd === undefined) {
      return undefined;
    }

    if (source[parameterEnd] === ')') {
      const parameterStart = findMatchingJavaScriptOpeningParenthesis(
        source,
        parameterEnd,
        codePositions,
      );
      return parameterStart === undefined
        ? undefined
        : { kind: 'function', parameters: { start: parameterStart + 1, end: parameterEnd } };
    }

    const parameterStart = findJavaScriptIdentifierStart(source, parameterEnd, codePositions);
    return { kind: 'function', parameters: { start: parameterStart, end: parameterEnd + 1 } };
  }

  if (source[headerEnd] !== ')') {
    return undefined;
  }

  const parameterStart = findMatchingJavaScriptOpeningParenthesis(source, headerEnd, codePositions);

  if (parameterStart === undefined) {
    return undefined;
  }

  const precedingToken = readPreviousJavaScriptIdentifier(
    source,
    parameterStart - 1,
    codePositions,
  );

  if (precedingToken === 'catch') {
    return { kind: 'catch', parameters: { start: parameterStart + 1, end: headerEnd } };
  }

  if (
    precedingToken !== undefined
    && (javascriptControlParenthesisKeywords.has(precedingToken) || precedingToken === 'await')
  ) {
    return undefined;
  }

  return { kind: 'function', parameters: { start: parameterStart + 1, end: headerEnd } };
}

function findPreviousJavaScriptCodeIndex(
  source: string,
  start: number,
  codePositions: Uint8Array,
): number | undefined {
  for (let index = start; index >= 0; index -= 1) {
    if (codePositions[index] === 1 && !/\s/u.test(source[index] ?? '')) {
      return index;
    }
  }

  return undefined;
}

function findMatchingJavaScriptOpeningParenthesis(
  source: string,
  closingParenthesis: number,
  codePositions: Uint8Array,
): number | undefined {
  let depth = 0;

  for (let index = closingParenthesis; index >= 0; index -= 1) {
    if (codePositions[index] !== 1) {
      continue;
    }

    if (source[index] === ')') {
      depth += 1;
    } else if (source[index] === '(') {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return undefined;
}

function findJavaScriptIdentifierStart(
  source: string,
  end: number,
  codePositions: Uint8Array,
): number {
  let start = end;

  while (
    start > 0
    && codePositions[start - 1] === 1
    && /[$\u200C\u200D\p{ID_Continue}]/u.test(source[start - 1] ?? '')
  ) {
    start -= 1;
  }

  return start;
}

function readPreviousJavaScriptIdentifier(
  source: string,
  start: number,
  codePositions: Uint8Array,
): string | undefined {
  const end = findPreviousJavaScriptCodeIndex(source, start, codePositions);

  if (end === undefined || !/[$\u200C\u200D\p{ID_Continue}]/u.test(source[end] ?? '')) {
    return undefined;
  }

  const identifierStart = findJavaScriptIdentifierStart(source, end, codePositions);
  return source.slice(identifierStart, end + 1);
}

function hasEscapedJavaScriptIdentifierContinuationBefore(
  source: string,
  position: number,
  codePositions: Uint8Array,
): boolean {
  const prefixStart = Math.max(0, position - 12);
  const match = /\\u\{([\dA-Fa-f]{1,6})\}$/u.exec(source.slice(prefixStart, position));

  if (match?.index === undefined) {
    return false;
  }

  const escapeStart = prefixStart + match.index;
  const codePoint = Number.parseInt(match[1] ?? '', 16);

  if (codePositions[escapeStart] !== 1 || codePoint > 0x10FFFF) {
    return false;
  }

  return /[$\u200C\u200D\p{ID_Continue}]/u.test(String.fromCodePoint(codePoint));
}

function findJavaScriptLoopBodyRange(
  source: string,
  start: number,
  codePositions: Uint8Array,
): SourceRange | undefined {
  let bodyStart = start;

  while (bodyStart < source.length && /\s/u.test(source[bodyStart] ?? '')) {
    bodyStart += 1;
  }

  if (source[bodyStart] !== '{') {
    return findJavaScriptExpressionRange(source, bodyStart, source.length, codePositions, true);
  }

  let depth = 0;

  for (let index = bodyStart; index < source.length; index += 1) {
    if (codePositions[index] !== 1) {
      continue;
    }

    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;

      if (depth === 0) {
        return { start: bodyStart, end: index + 1 };
      }
    }
  }

  return undefined;
}

function findPhaserLoaderUrlRanges(
  source: string,
  codePositions: Uint8Array,
): SourceRange[] {
  const loaderMethods = Object.keys(phaserLoaderUrlArgumentIndexes)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|');
  const loaderPattern = new RegExp(
    `(?<![$.\\u200C\\u200D\\p{ID_Continue}])(${javascriptIdentifierPatternSource})\\s*\\.\\s*load\\s*\\.\\s*(${loaderMethods})\\s*\\(`,
    'gu',
  );
  const ranges: SourceRange[] = [];

  for (const match of source.matchAll(loaderPattern)) {
    if (
      match.index === undefined
      || match[1] === undefined
      || codePositions[match.index] !== 1
      || !isProvenPhaserLoaderReceiver(source, match[1], match.index, codePositions)
    ) {
      continue;
    }

    const method = match[2] ?? '';
    const openingParenthesis = source.indexOf('(', match.index);
    const arguments_ = splitJavaScriptArguments(source, openingParenthesis, codePositions);
    const configArgument = arguments_[0];

    if (configArgument !== undefined) {
      ranges.push(...findPhaserLoaderConfigUrlRanges(
        source,
        configArgument,
        match.index,
        codePositions,
      ));
    }

    for (const argumentIndex of phaserLoaderUrlArgumentIndexes[method] ?? []) {
      const argument = arguments_[argumentIndex];

      if (argument !== undefined) {
        ranges.push(argument);
      }
    }
  }

  return ranges;
}

function isProvenPhaserLoaderReceiver(
  source: string,
  receiver: string,
  position: number,
  codePositions: Uint8Array,
): boolean {
  if (receiver === 'this') {
    return isInsidePhaserSceneSubclass(source, position, codePositions);
  }

  const binding = findVisibleJavaScriptIdentifierBinding(source, receiver, position, codePositions);

  if (binding?.initializerRange === undefined || binding.start >= position) {
    return false;
  }

  const initializer = maskNonCode(
    source.slice(binding.initializerRange.start, binding.initializerRange.end),
    codePositions.slice(binding.initializerRange.start, binding.initializerRange.end),
  ).trim();
  const phaserScene = new RegExp(
    `^new\\s+(${javascriptIdentifierPatternSource})\\s*\\.\\s*Scene\\s*(?:\\(|$)`,
    'u',
  ).exec(initializer);

  if (phaserScene?.[1] === undefined) {
    return false;
  }

  const namespace = phaserScene[1];
  return isProvenPhaserNamespace(
    source,
    namespace,
    binding.initializerRange.start + initializer.indexOf(namespace),
    codePositions,
  );
}

function isInsidePhaserSceneSubclass(
  source: string,
  position: number,
  codePositions: Uint8Array,
): boolean {
  const classPattern = new RegExp(
    `\\bclass(?:\\s+${javascriptIdentifierPatternSource})?\\s+extends\\s+(${javascriptIdentifierPatternSource})\\s*\\.\\s*Scene\\s*$`,
    'u',
  );

  for (const blockStart of [...findJavaScriptScopePath(source, position, codePositions)].reverse()) {
    const headerStart = Math.max(0, blockStart - 512);
    const header = maskNonCode(
      source.slice(headerStart, blockStart),
      codePositions.slice(headerStart, blockStart),
    ).trimEnd();

    const match = classPattern.exec(header);

    if (
      match?.[1] !== undefined
      && isProvenPhaserNamespace(
        source,
        match[1],
        headerStart + match.index + match[0].lastIndexOf(match[1]),
        codePositions,
      )
    ) {
      return true;
    }
  }

  return false;
}

function isProvenPhaserNamespace(
  source: string,
  namespace: string,
  position: number,
  codePositions: Uint8Array,
): boolean {
  const namespaceBinding = findVisibleJavaScriptIdentifierBinding(
    source,
    namespace,
    position,
    codePositions,
  );

  if (namespace === 'Phaser' && namespaceBinding === undefined) {
    return true;
  }

  // Production minifiers rename the imported Phaser namespace. Require the same
  // lexical binding to construct both Game and Scene before applying loader rules.
  const gameConstructorPattern = new RegExp(
    `\\bnew\\s+${escapeRegExp(namespace)}\\s*\\.\\s*Game\\s*\\(`,
    'gu',
  );

  for (const match of source.matchAll(gameConstructorPattern)) {
    if (
      match.index === undefined
      || codePositions[match.index] !== 1
    ) {
      continue;
    }

    const candidateBinding = findVisibleJavaScriptIdentifierBinding(
      source,
      namespace,
      match.index + match[0].indexOf(namespace),
      codePositions,
    );

    if (
      namespaceBinding !== undefined
      && namespaceBinding.start >= 0
      && candidateBinding?.start === namespaceBinding.start
    ) {
      return true;
    }
  }

  return false;
}

function findPhaserLoaderConfigUrlRanges(
  source: string,
  argumentRange: SourceRange,
  loaderCallPosition: number,
  codePositions: Uint8Array,
): SourceRange[] {
  const argument = trimSourceRange(source, argumentRange);
  const firstCharacter = source[argument.start];

  if (firstCharacter !== '{' && firstCharacter !== '[') {
    const identifier = source.slice(argument.start, argument.end);

    if (new RegExp(`^${javascriptIdentifierPatternSource}$`, 'u').test(identifier)) {
      const binding = findVisibleJavaScriptIdentifierBinding(
        source,
        identifier,
        argument.start,
        codePositions,
      );

      if (binding !== undefined && binding.start < loaderCallPosition) {
        const assignment = resolveLastDirectJavaScriptAssignment(
          source,
          identifier,
          binding,
          loaderCallPosition,
          codePositions,
        );

        if (assignment.ambiguous) {
          throw new Error(
            'Offline playtest does not support conditionally assigned Phaser loader configurations.',
          );
        }

        const configRange = assignment.range ?? binding.initializerRange;

        if (configRange !== undefined) {
          const initializer = trimSourceRange(source, configRange);
          const initializerStart = source[initializer.start];

          if (initializerStart === '{' || initializerStart === '[') {
            return findPhaserLoaderConfigUrlRanges(
              source,
              initializer,
              loaderCallPosition,
              codePositions,
            );
          }
        }
      }
    }

    return [];
  }

  const configObjectRanges = firstCharacter === '{'
    ? [argument]
    : splitJavaScriptTopLevelRanges(
        source,
        { start: argument.start + 1, end: argument.end - 1 },
        ',',
        codePositions,
      ).map((range) => trimSourceRange(source, range)).filter((range) =>
        source[range.start] === '{' && source[range.end - 1] === '}',
      );
  const isDirectConfigObject = (objectRange: SourceRange | undefined): objectRange is SourceRange =>
    objectRange !== undefined
    && configObjectRanges.some((candidate) =>
      candidate.start === objectRange.start && candidate.end === objectRange.end,
    );
  const keyPattern = /\bkey\b/gu;
  const hasDirectConfigKey = (objectRange: SourceRange): boolean => {
    keyPattern.lastIndex = objectRange.start + 1;
    let keyMatch = keyPattern.exec(source);

    while (keyMatch !== null && keyMatch.index < objectRange.end - 1) {
      const containingObject = findContainingJavaScriptObject(
        source,
        keyMatch.index,
        codePositions,
      );
      const previous = findAdjacentJavaScriptCodeCharacter(
        source,
        keyMatch.index - 1,
        -1,
        codePositions,
      );
      const next = findAdjacentJavaScriptCodeCharacter(
        source,
        keyMatch.index + keyMatch[0].length,
        1,
        codePositions,
      );

      if (
        containingObject?.start === objectRange.start
        && containingObject.end === objectRange.end
        && (previous === '{' || previous === ',')
        && (next === ':' || next === ',' || next === '}')
      ) {
        return true;
      }

      keyMatch = keyPattern.exec(source);
    }

    return false;
  };

  const propertyPattern = new RegExp(
    `\\b(${[...phaserManifestUrlPropertyNames].map(escapeRegExp).join('|')})\\s*:`,
    'gu',
  );
  propertyPattern.lastIndex = argument.start;
  const ranges: SourceRange[] = [];
  let match = propertyPattern.exec(source);

  while (match !== null && match.index < argument.end) {
    if (codePositions[match.index] === 1) {
      const objectRange = findContainingJavaScriptObject(source, match.index, codePositions);

      if (isDirectConfigObject(objectRange) && hasDirectConfigKey(objectRange)) {
        const colon = source.indexOf(':', match.index);
        const valueRange = findJavaScriptExpressionRange(
          source,
          colon + 1,
          objectRange.end - 1,
          codePositions,
        );
        ranges.push(valueRange);
      }
    }

    match = propertyPattern.exec(source);
  }

  const shorthandPattern = new RegExp(
    `\\b(${[...phaserManifestUrlPropertyNames].map(escapeRegExp).join('|')})\\b`,
    'gu',
  );
  shorthandPattern.lastIndex = argument.start;
  match = shorthandPattern.exec(source);

  while (match !== null && match.index < argument.end) {
    const propertyName = match[1];
    const previous = findAdjacentJavaScriptCodeCharacter(
      source,
      match.index - 1,
      -1,
      codePositions,
    );
    const next = findAdjacentJavaScriptCodeCharacter(
      source,
      match.index + match[0].length,
      1,
      codePositions,
    );

    if (
      propertyName !== undefined
      && (previous === '{' || previous === ',')
      && (next === ',' || next === '}')
      && codePositions[match.index] === 1
    ) {
      const objectRange = findContainingJavaScriptObject(source, match.index, codePositions);

      if (isDirectConfigObject(objectRange) && hasDirectConfigKey(objectRange)) {
        ranges.push({ start: match.index, end: match.index + propertyName.length });
      }
    }

    match = shorthandPattern.exec(source);
  }

  return ranges;
}

function findAdjacentJavaScriptCodeCharacter(
  source: string,
  start: number,
  direction: -1 | 1,
  codePositions: Uint8Array,
): string | undefined {
  for (let index = start; index >= 0 && index < source.length; index += direction) {
    if (codePositions[index] === 1 && !/\s/u.test(source[index] ?? '')) {
      return source[index];
    }
  }

  return undefined;
}

function findContainingJavaScriptObject(
  source: string,
  position: number,
  codePositions: Uint8Array,
): SourceRange | undefined {
  let depth = 0;
  let start: number | undefined;

  for (let index = position - 1; index >= 0; index -= 1) {
    if (codePositions[index] !== 1) {
      continue;
    }

    if (source[index] === '}') {
      depth += 1;
    } else if (source[index] === '{') {
      if (depth === 0) {
        start = index;
        break;
      }

      depth -= 1;
    }
  }

  if (start === undefined) {
    return undefined;
  }

  depth = 0;

  for (let index = start; index < source.length; index += 1) {
    if (codePositions[index] !== 1) {
      continue;
    }

    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;

      if (depth === 0) {
        return { start, end: index + 1 };
      }
    }
  }

  return undefined;
}

function splitJavaScriptArguments(
  source: string,
  openingParenthesis: number,
  codePositions: Uint8Array,
): readonly SourceRange[] {
  return splitJavaScriptTopLevelRanges(
    source,
    { start: openingParenthesis + 1, end: source.length },
    ',',
    codePositions,
    ')',
  );
}

function findJavaScriptExpressionRange(
  source: string,
  start: number,
  limit: number,
  codePositions: Uint8Array,
  stopAtAutomaticSemicolon = false,
  stopAtUnmatchedClosingDelimiter = false,
): SourceRange {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let hasTopLevelToken = false;

  for (let index = start; index < limit; index += 1) {
    if (codePositions[index] !== 1) {
      continue;
    }

    const character = source[index] ?? '';

    if (
      stopAtAutomaticSemicolon
      && (character === '\n' || character === '\r')
      && roundDepth === 0
      && squareDepth === 0
      && curlyDepth === 0
      && hasTopLevelToken
      && isJavaScriptAutomaticSemicolonBoundary(source, index, limit, codePositions)
    ) {
      return trimSourceRange(source, { start, end: index });
    }

    if (character === '(') {
      roundDepth += 1;
    } else if (character === '[') {
      squareDepth += 1;
    } else if (character === '{') {
      curlyDepth += 1;
    } else if (character === ')') {
      if (roundDepth > 0) {
        roundDepth -= 1;
      } else if (stopAtUnmatchedClosingDelimiter) {
        return trimSourceRange(source, { start, end: index });
      }
    } else if (character === ']') {
      if (squareDepth > 0) {
        squareDepth -= 1;
      } else if (stopAtUnmatchedClosingDelimiter) {
        return trimSourceRange(source, { start, end: index });
      }
    } else if (character === '}') {
      if (curlyDepth > 0) {
        curlyDepth -= 1;
      } else if (stopAtUnmatchedClosingDelimiter || stopAtAutomaticSemicolon) {
        return trimSourceRange(source, { start, end: index });
      }
    } else if (
      (character === ',' || character === ';')
      && roundDepth === 0
      && squareDepth === 0
      && curlyDepth === 0
    ) {
      return trimSourceRange(source, { start, end: index });
    }

    if (!/\s/u.test(character)) {
      hasTopLevelToken = true;
    }
  }

  return trimSourceRange(source, { start, end: limit });
}

function isJavaScriptAutomaticSemicolonBoundary(
  source: string,
  lineBreak: number,
  limit: number,
  codePositions: Uint8Array,
): boolean {
  let previous = lineBreak - 1;

  while (previous >= 0 && (codePositions[previous] !== 1 || /\s/u.test(source[previous] ?? ''))) {
    previous -= 1;
  }

  let next = lineBreak + 1;

  while (next < limit && (codePositions[next] !== 1 || /\s/u.test(source[next] ?? ''))) {
    next += 1;
  }

  const previousCharacter = source[previous] ?? '';
  const nextCharacter = source[next] ?? '';

  const previousIsRegexLiteral = previousCharacter === '/' && codePositions[previous + 1] === 0;

  if (
    !previousIsRegexLiteral
    && previousCharacter.length > 0
    && '!%&(*+,-./:<=>?[\\^|~'.includes(previousCharacter)
  ) {
    return false;
  }

  if (nextCharacter.length > 0 && '!%&(*+,-./:<=>?[\\^|`~'.includes(nextCharacter)) {
    return false;
  }

  const previousCode = maskNonCode(source.slice(0, lineBreak), codePositions.slice(0, lineBreak));
  return !/(?:\bin|\binstanceof)\s*$/u.test(previousCode);
}

function collectJavaScriptIdentifierUses(
  source: string,
  ranges: readonly SourceRange[],
  codePositions: Uint8Array,
): readonly Readonly<{ identifier: string; position: number }>[] {
  const uses = new Map<string, Readonly<{ identifier: string; position: number }>>();
  const pattern = new RegExp(javascriptIdentifierPatternSource, 'gu');

  for (const range of ranges) {
    const sourceSlice = source.slice(range.start, range.end);
    const code = maskNonCode(sourceSlice, codePositions.slice(range.start, range.end));
    const nonIdentifierSyntax = code.replace(pattern, '').replace(/[\s,\[\]]/gu, '');

    if (nonIdentifierSyntax.length > 0) {
      continue;
    }

    pattern.lastIndex = range.start;
    let match = pattern.exec(source);

    while (match !== null && match.index < range.end) {
      if (codePositions[match.index] === 1) {
        const previous = source.slice(range.start, match.index).trimEnd().at(-1);
        const next = source.slice(match.index + match[0].length, range.end).trimStart()[0];

        if (previous !== '.' && next !== ':') {
          uses.set(`${match[0]}:${match.index}`, {
            identifier: match[0],
            position: match.index,
          });
        }
      }

      match = pattern.exec(source);
    }
  }

  return [...uses.values()];
}

function findIdentifierInitializerRanges(
  source: string,
  uses: readonly Readonly<{ identifier: string; position: number }>[],
  codePositions: Uint8Array,
): SourceRange[] {
  const ranges = new Map<string, SourceRange>();

  for (const use of uses) {
    const binding = findVisibleJavaScriptIdentifierBinding(
      source,
      use.identifier,
      use.position,
      codePositions,
    );

    if (
      binding?.initializerRange !== undefined
      && binding.start < use.position
      && binding.kind !== 'parameter'
    ) {
      ranges.set(
        `${binding.initializerRange.start}:${binding.initializerRange.end}`,
        binding.initializerRange,
      );
    }
  }

  return [...ranges.values()];
}

function trimSourceRange(source: string, range: SourceRange): SourceRange {
  let { start, end } = range;

  while (start < end && /\s/u.test(source[start] ?? '')) {
    start += 1;
  }

  while (end > start && /\s/u.test(source[end - 1] ?? '')) {
    end -= 1;
  }

  return { start, end };
}

function rangesOverlap(left: SourceRange, right: SourceRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function inlineScriptElements(
  html: string,
  htmlFile: string,
  context: InliningContext,
): string {
  let cursor = 0;
  let output = '';

  for (const match of findHtmlScriptElements(html)) {
    const attributes = match[2] ?? '';
    const attributeTokens = tokenizeHtmlAttributes(attributes);
    const script = match[3] ?? '';

    if (match.index === undefined || match[0] === undefined) {
      throw new Error('Unable to rewrite an inline script in the offline playtest document.');
    }

    output += html.slice(cursor, match.index);

    if (readHtmlAttributeToken(attributeTokens, 'src') !== undefined) {
      throw new Error('Offline playtest cannot retain an external script after entry extraction.');
    }

    const scriptType = readHtmlAttributeToken(attributeTokens, 'type');

    if (!isJavaScriptScriptType(scriptType)) {
      output += match[0];
    } else {
      const inlined = inlineJavaScriptAssetReferences(script, htmlFile, context);
      assertSupportedBundledRuntime(inlined);

      if (isModuleScriptType(scriptType)) {
        assertNoRetainedModuleDependencies(inlined);
      }

      output += `<script${attributes}>${escapeClosingTag(inlined, 'script')}</script>`;
    }

    cursor = match.index + match[0].length;
  }

  return output + html.slice(cursor);
}

function isJavaScriptScriptType(type: string | undefined): boolean {
  if (type === undefined || type.trim().length === 0) {
    return true;
  }

  const normalized = (type.split(';', 1)[0] ?? '').trim().toLowerCase();
  return javascriptScriptTypes.has(normalized);
}

function isModuleScriptType(type: string | undefined): boolean {
  return type?.trim().toLowerCase() === 'module';
}

function assertNoRetainedModuleDependencies(source: string): void {
  const codeOnlySource = maskNonCode(source, createCodePositionMap(source, true));

  if (
    /\bimport(?![$\w])\s*(?![.(])/gu.test(codeOnlySource)
    || /\bexport(?![$\w])\s*(?:\*|\{)[^;]*\bfrom\s*/gu.test(codeOnlySource)
  ) {
    throw new Error('Offline playtest does not support imports in retained inline modules.');
  }
}

function inlineStylesheets(
  html: string,
  htmlFile: string,
  context: InliningContext,
): string {
  return transformOutsideHtmlRawText(html, (fragment) =>
    fragment.replace(/<link\b((?:"[^"]*"|'[^']*'|[^'">])*)>/giu, (match, attributes: string) => {
      const attributeTokens = tokenizeHtmlAttributes(attributes);
      const rel = readHtmlRelTokenSet(attributeTokens);
      const href = readHtmlAttributeToken(attributeTokens, 'href');

      if (!rel.has('stylesheet')) {
        return [...rel].some((name) => htmlResourceHintRelNames.has(name)) ? '' : match;
      }

      if (rel.has('alternate')) {
        throw new Error('Offline playtest does not support alternate stylesheets.');
      }

      if (href === undefined) {
        throw new Error('Stylesheet link is missing href.');
      }

      if (hasHtmlAttributeToken(attributeTokens, 'integrity')) {
        throw new Error('Offline playtest does not support integrity-protected stylesheets.');
      }

      const stylesheetFile = resolveLocalReference(context.artifactRoot, path.dirname(htmlFile), href);
      const stylesheet = readFileSync(stylesheetFile, 'utf8');
      const inlined = inlineCssAssetReferences(stylesheet, stylesheetFile, context);
      context.inlinedAssets.add(stylesheetFile);
      const style = `<style${renderInlinedStylesheetAttributes(attributeTokens)}>${escapeClosingTag(inlined, 'style')}</style>`;
      return hasHtmlAttributeToken(attributeTokens, 'disabled')
        ? `${style}<script>document.currentScript.previousElementSibling.sheet.disabled=true</script>`
        : style;
    }),
  );
}

function renderInlinedStylesheetAttributes(attributes: readonly HtmlAttributeToken[]): string {
  const rendered: string[] = [];

  for (const name of ['id', 'class', 'media', 'title', 'nonce', 'type']) {
    const value = readHtmlAttributeToken(attributes, name);

    if (value !== undefined) {
      rendered.push(`${name}="${escapeHtmlAttribute(value)}"`);
    }
  }

  if (hasHtmlAttributeToken(attributes, 'disabled')) {
    rendered.push('disabled');
  }

  return rendered.length === 0 ? '' : ` ${rendered.join(' ')}`;
}

function renderHtmlAttributes(
  attributes: readonly HtmlAttributeToken[],
  excludedNames: ReadonlySet<string>,
): string {
  const rendered = attributes
    .filter((attribute) => !excludedNames.has(attribute.name))
    .map((attribute) => attribute.value === undefined
      ? attribute.name
      : `${attribute.name}="${escapeHtmlAttribute(decodeHtmlCharacterReferences(attribute.value))}"`);
  return rendered.length === 0 ? '' : ` ${rendered.join(' ')}`;
}

function readHtmlRelTokens(attributes: string): ReadonlySet<string> {
  return readHtmlRelTokenSet(tokenizeHtmlAttributes(attributes));
}

function readHtmlRelTokenSet(attributes: readonly HtmlAttributeToken[]): ReadonlySet<string> {
  const rel = readHtmlAttributeToken(attributes, 'rel');

  if (rel === undefined) {
    return new Set<string>();
  }

  return new Set(rel.toLowerCase().split(/[\t\n\f\r ]+/u).filter((token) => token.length > 0));
}

function inlineCssAssetReferences(
  source: string,
  sourceFile: string,
  context: InliningContext,
  readAsset: AssetDataUrlReader = (assetSourceFile, reference) =>
    readAssetDataUrl(assetSourceFile, reference, context),
): string {
  if (containsCssImportRule(source)) {
    throw new Error(`Offline playtest does not support CSS @import rules: ${sourceFile}`);
  }

  const output = inlineCssImageSetStringReferences(source, sourceFile, readAsset);
  let cursor = 0;
  let inlined = '';

  for (const token of findCssUrlTokens(output)) {
    inlined += output.slice(cursor, token.start);

    const reference = token.reference;
    if (
      isDataUrlReference(reference)
      || reference.startsWith('#')
    ) {
      inlined += output.slice(token.start, token.end);
    } else {
      inlined += `url(${JSON.stringify(readAsset(sourceFile, reference))})`;
    }

    cursor = token.end;
  }

  return inlined + output.slice(cursor);
}

function inlineCssImageSetStringReferences(
  source: string,
  sourceFile: string,
  readAsset: AssetDataUrlReader,
): string {
  let cursor = 0;
  let output = '';

  for (const token of findCssImageSetFunctionTokens(source)) {
    output += source.slice(cursor, token.openingParenthesis + 1);
    output += inlineCssImageSetOptions(
      source.slice(token.openingParenthesis + 1, token.closingParenthesis),
      sourceFile,
      readAsset,
    );
    cursor = token.closingParenthesis;
  }

  return output + source.slice(cursor);
}

function findCssImageSetFunctionTokens(
  source: string,
): readonly Readonly<{
  closingParenthesis: number;
  openingParenthesis: number;
}>[] {
  const cssIdentifierCharacter = String.raw`(?:[a-z]|\\(?:[\dA-Fa-f]{1,6}[\t\n\f\r ]?|[^\n\f\r]))`;
  const pattern = new RegExp(`(?<![-\\w])((?:-|${cssIdentifierCharacter})+)\\s*\\(`, 'giu');
  const codePositions = createCodePositionMap(source, false);
  const tokens: Array<Readonly<{
    closingParenthesis: number;
    openingParenthesis: number;
  }>> = [];
  let match = pattern.exec(source);

  while (match !== null) {
    if (
      codePositions[match.index] !== 1
      || !['image-set', '-webkit-image-set'].includes(
        decodeCssEscapes(match[1] ?? '').toLowerCase(),
      )
    ) {
      match = pattern.exec(source);
      continue;
    }

    const openingParenthesis = source.indexOf('(', match.index);
    const closingParenthesis = findCssFunctionEnd(source, openingParenthesis);

    if (closingParenthesis === undefined) {
      match = pattern.exec(source);
      continue;
    }

    tokens.push({ openingParenthesis, closingParenthesis });
    pattern.lastIndex = closingParenthesis + 1;
    match = pattern.exec(source);
  }

  return tokens;
}

function findCssFunctionEnd(source: string, openingParenthesis: number): number | undefined {
  let depth = 1;
  let inComment = false;
  let quote: '"' | "'" | undefined;

  for (let index = openingParenthesis + 1; index < source.length; index += 1) {
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

    if (character === '\\') {
      index += 1;
    } else if (character === '/' && nextCharacter === '*') {
      inComment = true;
      index += 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return undefined;
}

function inlineCssImageSetOptions(
  source: string,
  sourceFile: string,
  readAsset: AssetDataUrlReader,
): string {
  return splitCssImageSetOptions(source)
    .map((option) => inlineCssImageSetOption(option, sourceFile, readAsset))
    .join(',');
}

function splitCssImageSetOptions(source: string): readonly string[] {
  let cursor = 0;
  let depth = 0;
  let inComment = false;
  const options: string[] = [];
  let quote: '"' | "'" | undefined;

  for (let index = 0; index <= source.length; index += 1) {
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

    if (character === '(') {
      depth += 1;
      continue;
    }

    if (character === ')') {
      depth -= 1;
      continue;
    }

    if (index === source.length || (character === ',' && depth === 0)) {
      options.push(source.slice(cursor, index));
      cursor = index + 1;
    }
  }

  return options;
}

function inlineCssImageSetOption(
  source: string,
  sourceFile: string,
  readAsset: AssetDataUrlReader,
): string {
  const token = findCssImageSetStringToken(source);

  if (
    token === undefined
    || isDataUrlReference(token.reference)
    || token.reference.startsWith('#')
  ) {
    return source;
  }

  const dataUrl = readAsset(sourceFile, token.reference);
  return `${source.slice(0, token.start)}${JSON.stringify(dataUrl)}${source.slice(token.end)}`;
}

function findCssImageSetStringToken(
  source: string,
): Readonly<{ end: number; reference: string; start: number }> | undefined {
  const codePositions = createCodePositionMap(source, false);
  let valueStart = 0;

  while (
    valueStart < source.length
    && (/\s/u.test(source[valueStart] ?? '') || codePositions[valueStart] === 0)
  ) {
    valueStart += 1;
  }

  if (valueStart === source.length || (source[valueStart] !== '"' && source[valueStart] !== "'")) {
    return undefined;
  }

  const quote = source[valueStart];
  let valueEnd = valueStart + 1;

  while (valueEnd < source.length && source[valueEnd] !== quote) {
    valueEnd += source[valueEnd] === '\\' ? 2 : 1;
  }

  if (valueEnd >= source.length) {
    return undefined;
  }

  const reference = decodeCssEscapes(source.slice(valueStart + 1, valueEnd));
  return { start: valueStart, end: valueEnd + 1, reference };
}

function decodeCssEscapes(value: string): string {
  let output = '';

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (character !== '\\') {
      output += character;
      continue;
    }

    const nextCharacter = value[index + 1];

    if (nextCharacter === undefined) {
      break;
    }

    if (nextCharacter === '\r' || nextCharacter === '\n' || nextCharacter === '\f') {
      if (nextCharacter === '\r' && value[index + 2] === '\n') {
        index += 1;
      }

      index += 1;
      continue;
    }

    if (/[\dA-Fa-f]/u.test(nextCharacter)) {
      let hexadecimal = '';

      while (hexadecimal.length < 6 && /[\dA-Fa-f]/u.test(value[index + 1] ?? '')) {
        hexadecimal += value[index + 1];
        index += 1;
      }

      const whitespace = value[index + 1];

      if (whitespace !== undefined && /[\t\n\f\r ]/u.test(whitespace)) {
        index += whitespace === '\r' && value[index + 2] === '\n' ? 2 : 1;
      }

      output += safeCodePoint(Number.parseInt(hexadecimal, 16));
      continue;
    }

    output += nextCharacter === '\0' ? '\uFFFD' : nextCharacter;
    index += 1;
  }

  return output;
}

function inlineStyleElements(
  html: string,
  htmlFile: string,
  context: InliningContext,
): string {
  let cursor = 0;
  let output = '';

  for (const match of html.matchAll(createHtmlRawTextPattern())) {
    if (match[1]?.toLowerCase() !== 'style') {
      continue;
    }

    if (match.index === undefined || match[0] === undefined) {
      throw new Error('Unable to rewrite a style element in the offline playtest document.');
    }

    const attributes = match[2] ?? '';
    const stylesheet = match[3] ?? '';
    const inlined = inlineCssAssetReferences(stylesheet, htmlFile, context);
    output += html.slice(cursor, match.index);
    output += `<style${attributes}>${escapeClosingTag(inlined, 'style')}</style>`;
    cursor = match.index + match[0].length;
  }

  return output + html.slice(cursor);
}

function containsCssImportRule(source: string): boolean {
  const codePositions = createCodePositionMap(source, false);

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '@' || codePositions[index] !== 1) {
      continue;
    }

    const identifier = readCssIdentifier(source, index + 1);

    if (identifier?.value.toLowerCase() === 'import') {
      return true;
    }
  }

  return false;
}

function readCssIdentifier(
  source: string,
  start: number,
): Readonly<{ end: number; value: string }> | undefined {
  let end = start;

  while (end < source.length) {
    const character = source[end] ?? '';

    if (/[-_\dA-Z_a-z\u0080-\uFFFF]/u.test(character)) {
      end += 1;
      continue;
    }

    if (character !== '\\' || source[end + 1] === undefined) {
      break;
    }

    end += 1;
    let hexadecimalDigits = 0;

    while (hexadecimalDigits < 6 && /[\dA-Fa-f]/u.test(source[end] ?? '')) {
      hexadecimalDigits += 1;
      end += 1;
    }

    if (hexadecimalDigits === 0) {
      end += 1;
    } else if (/[\t\n\f\r ]/u.test(source[end] ?? '')) {
      if (source[end] === '\r' && source[end + 1] === '\n') {
        end += 1;
      }

      end += 1;
    }
  }

  if (end === start) {
    return undefined;
  }

  return { end, value: decodeCssEscapes(source.slice(start, end)) };
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
  const htmlWithInlineStyles = html.replace(/<[a-z][\w:-]*(?=[\s>"'\/])(?:"[^"]*"|'[^']*'|[^'">])*>/giu, (tag) => {
    let output = tag;

    for (const attributeName of ['style', ...svgFunctionalUrlAttributeNames]) {
      const attributeTokens = tokenizeHtmlAttributes(output);
      const value = readHtmlAttributeToken(attributeTokens, attributeName);

      if (value === undefined) {
        continue;
      }

      output = replaceHtmlAttribute(
        output,
        attributeName,
        inlineCssAssetReferences(value, htmlFile, context),
        attributeTokens,
      );
    }

    return output;
  });

  return htmlWithInlineStyles.replace(/<(link|audio|body|embed|feimage|image|img|input|object|source|track|use|video)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/giu, (tag, name: string, attributes: string) => {
    const lowerName = name.toLowerCase();
    const attributeTokens = tokenizeHtmlAttributes(attributes);
    const rel = readHtmlRelTokenSet(attributeTokens);
    const allowedAttributes = [...(htmlAssetAttributesByTag[lowerName] ?? ['src'])];

    if (lowerName === 'link') {
      if (!['icon', 'apple-touch-icon', 'mask-icon'].some((token) => rel.has(token))) {
        return tag;
      }

      allowedAttributes.splice(0, allowedAttributes.length, 'href');
    }

    let output = tag;

    for (const attribute of allowedAttributes) {
      const reference = readHtmlAttributeToken(attributeTokens, attribute);

      if (reference === undefined || reference.startsWith('#')) {
        continue;
      }

      let inlined: string;

      if (attribute === 'srcset') {
        inlined = inlineHtmlSrcset(htmlFile, reference, context);
      } else if (isDataUrlReference(reference)) {
        if (lowerName === 'embed' || lowerName === 'object') {
          throw new Error('Offline playtest does not support embedded active data documents.');
        }

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
  let cursor = 0;
  let output = '';

  for (const match of html.matchAll(createHtmlRawTextPattern())) {
    if (match.index === undefined || match[0] === undefined) {
      continue;
    }

    output += transform(html.slice(cursor, match.index));
    output += match[0];
    cursor = match.index + match[0].length;
  }

  return output + transform(html.slice(cursor));
}

function createHtmlRawTextPattern(): RegExp {
  return /<!--[\s\S]*?--!?>|<(noscript|script|style|textarea|title)\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/\1\s*\/?\s*>/giu;
}

function maskHtmlRawTextBodies(html: string): string {
  return html.replace(
    createHtmlRawTextPattern(),
    (
      match,
      tagName: string | undefined,
      attributes: string | undefined,
      content: string | undefined,
    ) => {
      if (tagName === undefined || attributes === undefined || content === undefined) {
        return maskTextPreservingLines(match);
      }

      const contentStart = tagName.length + attributes.length + 2;
      return `${match.slice(0, contentStart)}${maskTextPreservingLines(content)}${match.slice(contentStart + content.length)}`;
    },
  );
}

function inlineHtmlSrcset(
  htmlFile: string,
  source: string,
  context: InliningContext,
): string {
  return parseHtmlSrcset(source, htmlFile).map(({ reference, descriptor }) => {
    const inlined = isDataUrlReference(reference)
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

function assembleOfflineHtml(
  html: string,
  bundledEntry: BundledEntry,
  entryAttributes: readonly HtmlAttributeToken[],
): string {
  const csp = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; connect-src data: blob:; object-src data:; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'";
  const banner = '<!-- MPGD offline playtest: test-play-only, not a release target or store submission artifact. -->';
  const runtimeGuard = renderOfflineRuntimeGuard();
  const guardScript = `<script>${escapeClosingTag(runtimeGuard, 'script')}</script>`;
  const bundledStyle = bundledEntry.stylesheet === undefined
    ? ''
    : `\n<style>${escapeClosingTag(bundledEntry.stylesheet, 'style')}</style>`;
  const inlineScript = `<script${renderHtmlAttributes(entryAttributes, inlineEntryExcludedAttributeNames)}>${escapeClosingTag(bundledEntry.script, 'script')}</script>`;
  let output = removeExistingCharsetDeclaration(
    removeUnsafeMetaDirectives(removeManifestLinks(html)),
  );

  const headTag = findActiveHtmlStartTag(output, 'head');

  if (headTag === undefined) {
    throw new Error('Offline playtest source index.html must contain a head element.');
  }
  output = `${output.slice(0, headTag.end)}\n${offlineCharsetDeclaration}\n${banner}\n<meta name="mpgd-purpose" content="test-play-only">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n${guardScript}${bundledStyle}${output.slice(headTag.end)}`;

  if (
    !output.includes(offlineEntryPlaceholder)
    || output.indexOf(offlineEntryPlaceholder) !== output.lastIndexOf(offlineEntryPlaceholder)
  ) {
    throw new Error('Offline playtest could not preserve the module entry position.');
  }
  output = output.replace(offlineEntryPlaceholder, inlineScript);

  if (findActiveHtmlStartTag(output, 'body') !== undefined) {
    return `${output.trim()}\n`;
  }

  throw new Error('Offline playtest source index.html must contain a body element.');
}

function assertSupportedHtmlDocument(html: string): void {
  const headTag = findActiveHtmlStartTag(html, 'head');

  if (headTag === undefined) {
    throw new Error('Offline playtest source index.html must contain a head element.');
  }

  const preHeadContent = html.slice(0, headTag.start);
  const supportedPreHeadPattern = /^(?:[\t\n\f\r \uFEFF]+|<!--[\s\S]*?--!?>|<!doctype\b(?:"[^"]*"|'[^']*'|[^'">])*>|<html\b(?:"[^"]*"|'[^']*'|[^'">])*>)*/iu;

  if (supportedPreHeadPattern.exec(preHeadContent)?.[0].length !== preHeadContent.length) {
    throw new Error('Offline playtest does not support content before the head element.');
  }

  const charsetEndBytes = Buffer.byteLength(
    `${html.slice(0, headTag.end)}\n${offlineCharsetDeclaration}`,
  );

  if (charsetEndBytes > 1_024) {
    throw new Error(
      'Offline playtest requires the generated UTF-8 charset declaration within the first 1024 bytes.',
    );
  }

  const activeHtml = maskInertHtmlTemplateContents(html);
  const containsImportMap = findHtmlScriptElements(activeHtml).some(
    (match) => readHtmlAttribute(match[2] ?? '', 'type')?.trim().toLowerCase() === 'importmap',
  );

  if (containsImportMap) {
    throw new Error('Offline playtest does not support HTML import maps.');
  }

  for (const match of html.matchAll(createHtmlRawTextPattern())) {
    if (match[1] !== undefined) {
      const attributes = tokenizeHtmlAttributes(match[2] ?? '');
      assertSupportedHtmlAttributes(match[1], attributes);

      if (
        match.index !== undefined
        && match[1].toLowerCase() === 'script'
        && activeHtml.slice(match.index, match.index + match[0].length).trim().length === 0
        && isJavaScriptScriptType(readHtmlAttributeToken(attributes, 'type'))
      ) {
        throw new Error('Offline playtest does not support executable scripts inside templates.');
      }
    }
  }

  transformOutsideHtmlRawText(html, (fragment) => {
    if (/<base\b(?:"[^"]*"|'[^']*'|[^'">])*>/iu.test(fragment)) {
      throw new Error('Offline playtest does not support HTML base elements.');
    }

    const tagPattern = /<([a-z][\w:-]*)(?=[\s>"'\/])((?:"[^"]*"|'[^']*'|[^'">])*)>/giu;

    for (const match of fragment.matchAll(tagPattern)) {
      assertSupportedHtmlAttributes(match[1] ?? '', tokenizeHtmlAttributes(match[2] ?? ''));
    }

    return fragment;
  });
}

function assertNoEntryImportMetaUrl(source: string): void {
  const normalizedSource = normalizeStaticJavaScriptPropertyAccess(source);
  const codeOnlySource = maskNonCode(
    normalizedSource,
    createCodePositionMap(normalizedSource, true),
  );

  if (/\bimport\s*\.\s*meta\b/u.test(codeOnlySource)) {
    throw new Error('Offline playtest does not support bare import.meta in the bundled entry.');
  }
}

function assertSupportedHtmlAttributes(
  tagName: string,
  attributes: readonly HtmlAttributeToken[],
): void {
  const eventHandler = attributes.find(
    (attribute) => attribute.name.length > 2
      && attribute.name.startsWith('on')
      && !nonEventHtmlAttributeNamesStartingWithOn.has(attribute.name),
  );

  if (eventHandler !== undefined) {
    throw new Error(
      `Offline playtest does not support inline HTML event handlers: ${eventHandler.name}.`,
    );
  }

  const lowerTagName = tagName.toLowerCase();

  if (
    lowerTagName === 'script'
    && (
      readHtmlAttributeToken(attributes, 'href') !== undefined
      || readHtmlAttributeToken(attributes, 'xlink:href') !== undefined
    )
  ) {
    throw new Error('Offline playtest does not support SVG external script references.');
  }

  if (lowerTagName === 'iframe') {
    throw new Error('Offline playtest does not support iframe documents.');
  }

  if (lowerTagName !== 'a' && lowerTagName !== 'area') {
    return;
  }

  for (const attributeName of ['href', 'xlink:href']) {
    const href = readHtmlAttributeToken(attributes, attributeName);

    if (href !== undefined && isNonLocalReference(href)) {
      throw new Error(`Offline playtest does not support external hyperlink navigation: ${href}`);
    }

    if (href !== undefined && href.trim().length > 0 && !href.trim().startsWith('#')) {
      throw new Error(
        `Offline playtest does not support non-fragment hyperlink navigation: ${href}`,
      );
    }
  }
}

function removeManifestLinks(html: string): string {
  return transformOutsideHtmlRawText(html, (fragment) =>
    fragment.replace(/<link\b((?:"[^"]*"|'[^']*'|[^'">])*)>/giu, (tag, attributes: string) =>
      readHtmlRelTokens(attributes).has('manifest') ? '' : tag,
    ),
  );
}

function removeUnsafeMetaDirectives(html: string): string {
  return transformOutsideHtmlRawText(html, (fragment) =>
    fragment.replace(/<meta\b(?:"[^"]*"|'[^']*'|[^'">])*>/giu, (tag) => {
      const httpEquiv = readHtmlAttribute(tag, 'http-equiv')?.trim().toLowerCase();
      return httpEquiv === 'content-security-policy' || httpEquiv === 'refresh' ? '' : tag;
    }),
  );
}

function removeExistingCharsetDeclaration(html: string): string {
  return transformOutsideHtmlRawText(html, (fragment) =>
    fragment.replace(/<meta\b(?:"[^"]*"|'[^']*'|[^'">])*>/giu, (tag) =>
      readHtmlAttribute(tag, 'charset') === undefined ? tag : '',
    ),
  );
}

function renderOfflineRuntimeGuard(): string {
  return `(()=>{const allowed=(value)=>{const raw=typeof value==='string'?value:typeof URL!=='undefined'&&value instanceof URL?value.href:typeof Request!=='undefined'&&value instanceof Request?value.url:String(value);const scheme=raw.slice(0,5).toLowerCase();return scheme==='data:'||scheme==='blob:'};const fragmentOnly=(value)=>typeof value==='string'&&value.trim().startsWith('#');const denied=(api,value)=>new TypeError('[mpgd offline playtest] '+api+' blocked network access: '+String(value));const blockConstructor=(api,Native)=>new Proxy(Native,{construct(_target,args){throw denied(api,args[0])}});const originalFetch=globalThis.fetch?.bind(globalThis);if(originalFetch){globalThis.fetch=(input,init)=>{if(!allowed(input))return Promise.reject(denied('fetch',input));return originalFetch(input,init)}}if(typeof globalThis.open==='function'){globalThis.open=(url)=>{throw denied('open',url)}}for(const [object,names] of [[globalThis.navigation,['back','forward','navigate','reload','traverseTo']],[globalThis.history,['back','forward','go']],[globalThis.History?.prototype,['back','forward','go']]]){if(object){for(const name of names){if(typeof object[name]==='function'){try{Object.defineProperty(object,name,{configurable:true,writable:true,value:(...args)=>{throw denied('navigation',args[0]??name)}})}catch{}}}}}if(globalThis.Location){for(const name of ['assign','replace']){const method=Location.prototype[name];if(typeof method==='function'){try{Object.defineProperty(Location.prototype,name,{configurable:true,writable:true,value:function(value){if(!fragmentOnly(value))throw denied('navigation',value);return method.call(this,value)}})}catch{}}}}if(globalThis.Document){for(const name of ['write','writeln']){if(typeof Document.prototype[name]==='function'){try{Object.defineProperty(Document.prototype,name,{configurable:true,writable:true,value:(...args)=>{throw denied('document.'+name,args[0])}})}catch{}}}}if(globalThis.HTMLAnchorElement){const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){const href=this.getAttribute('href');if(href!==null&&!fragmentOnly(href))throw denied('navigation',href);return click.call(this)}}if(typeof document!=='undefined'){document.addEventListener('click',(event)=>{const anchor=typeof Element!=='undefined'&&event.target instanceof Element?event.target.closest('a,area'):null;const href=anchor?.getAttribute('href')??anchor?.getAttribute('xlink:href');if(href!==null&&href!==undefined&&!fragmentOnly(href)){event.preventDefault();event.stopImmediatePropagation();throw denied('navigation',href)}},true)}if(globalThis.XMLHttpRequest){const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){if(!allowed(url))throw denied('XMLHttpRequest',url);return open.call(this,method,url,...rest)}}if(globalThis.WebSocket){globalThis.WebSocket=blockConstructor('WebSocket',globalThis.WebSocket)}if(globalThis.EventSource){globalThis.EventSource=blockConstructor('EventSource',globalThis.EventSource)}for(const name of ['RTCPeerConnection','webkitRTCPeerConnection']){if(name in globalThis){Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:class{constructor(){throw denied('WebRTC',name)}}})}}if(typeof navigator!=='undefined'&&navigator.sendBeacon){navigator.sendBeacon=()=>false}})();`;
}

function assertSupportedBundledRuntime(source: string): void {
  const unsupported = [
    { pattern: /\bWebAssembly\s*\.\s*instantiateStreaming\s*\(/gu, label: 'WebAssembly streaming' },
    { pattern: /\bnew\s+URL\([^;]*import\.meta/gu, label: 'runtime-computed import.meta asset URL' },
  ];
  const normalizedSource = normalizeRuntimeGlobalAliases(
    normalizeStaticJavaScriptPropertyAccess(normalizeJavaScriptIdentifierEscapes(source)),
  );
  const braceKinds = new Uint8Array(normalizedSource.length);
  const codePositions = createCodePositionMap(normalizedSource, true, braceKinds);
  const codeOnlySource = maskNonCode(normalizedSource, codePositions);
  assertNoUnsupportedWorkerConstruction(normalizedSource, codePositions);
  assertNoUnsupportedBrowserApi(normalizedSource, codePositions);
  assertNoDynamicImport(normalizedSource, codePositions, braceKinds);
  assertNoDynamicMetaElementCreation(normalizedSource, codePositions);
  assertNoScriptDrivenNavigation(normalizedSource, codePositions);

  for (const candidate of unsupported) {
    if (candidate.pattern.test(codeOnlySource)) {
      candidate.pattern.lastIndex = 0;
      throw new Error(`Offline playtest does not support ${candidate.label}.`);
    }

    candidate.pattern.lastIndex = 0;
  }
}

function assertNoDynamicMetaElementCreation(
  source: string,
  codePositions: Uint8Array,
): void {
  const pattern = new RegExp(
    `(?<![$.\\u200C\\u200D\\p{ID_Continue}])(?:(globalThis|self|window)${javascriptTriviaPatternSource}(?:\\.|\\?\\.)${javascriptTriviaPatternSource})?(${javascriptIdentifierPatternSource})${javascriptTriviaPatternSource}(?:\\.|\\?\\.)${javascriptTriviaPatternSource}(createElement(?:NS)?)${javascriptTriviaPatternSource}(?:\\?\\.${javascriptTriviaPatternSource})?\\(`,
    'gu',
  );

  for (const match of source.matchAll(pattern)) {
    const previousCode = match.index === undefined
      ? undefined
      : findPreviousJavaScriptCodeIndex(source, match.index - 1, codePositions);

    if (
      match.index === undefined
      || match[2] === undefined
      || match[3] === undefined
      || codePositions[match.index] !== 1
      || (previousCode !== undefined && source[previousCode] === '.')
      || !isNativeDocumentExpression(
        source,
        match[1] === undefined ? match[2] : `${match[1]}.${match[2]}`,
        match.index,
        codePositions,
        new Set<string>(),
      )
    ) {
      continue;
    }

    const openingParenthesis = match.index + match[0].length - 1;
    const arguments_ = splitJavaScriptArguments(source, openingParenthesis, codePositions);
    const method = match[3];
    const namespace = method === 'createElementNS' && arguments_[0] !== undefined
      ? readStaticJavaScriptStringWithTrivia(source, arguments_[0], codePositions)
      : undefined;
    const tagArgument = method === 'createElementNS' ? arguments_[1] : arguments_[0];
    const tagName = tagArgument === undefined
      ? undefined
      : readStaticJavaScriptStringWithTrivia(
          source,
          tagArgument,
          codePositions,
        )?.toLowerCase();

    if (
      tagName === 'meta'
      && (
        method === 'createElement'
        || namespace?.toLowerCase() === 'http://www.w3.org/1999/xhtml'
      )
    ) {
      throw new Error('Offline playtest does not support dynamically created meta elements.');
    }
  }
}

function isNativeDocumentExpression(
  source: string,
  expression: string,
  position: number,
  codePositions: Uint8Array,
  visitedBindings: Set<string>,
): boolean {
  const unwrapped = unwrapBalancedOuterParentheses(expression);

  if (unwrapped.offset > 0 || unwrapped.expression.length !== expression.length) {
    return isNativeDocumentExpression(
      source,
      unwrapped.expression,
      position + unwrapped.offset,
      codePositions,
      visitedBindings,
    );
  }

  const qualified = /^(globalThis|self|window)\s*\.\s*document$/u.exec(expression);

  if (qualified?.[1] !== undefined) {
    return findVisibleJavaScriptIdentifierBinding(
      source,
      qualified[1],
      position,
      codePositions,
    ) === undefined;
  }

  const identifier = exactJavaScriptIdentifierPattern.test(expression) ? expression : undefined;

  if (identifier === undefined) {
    return false;
  }

  const binding = findVisibleJavaScriptIdentifierBinding(
    source,
    identifier,
    position,
    codePositions,
  );

  if (identifier === 'document' && binding === undefined) {
    return true;
  }

  let assignment: JavaScriptAssignmentResolution | undefined;

  if (binding !== undefined) {
    assignment = resolveLastDirectJavaScriptAssignment(
      source,
      identifier,
      binding,
      position,
      codePositions,
    );
  }
  const initializerRange = assignment?.range ?? binding?.initializerRange;
  const bindingKey = binding === undefined || initializerRange === undefined
    ? undefined
    : `${identifier}:${binding.start}:${initializerRange.start}`;

  if (
    binding === undefined
    || initializerRange === undefined
    || binding.start >= position
    || assignment?.ambiguous === true
    || bindingKey === undefined
    || visitedBindings.has(bindingKey)
  ) {
    return false;
  }

  visitedBindings.add(bindingKey);
  const initializer = maskNonCode(
    source.slice(initializerRange.start, initializerRange.end),
    codePositions.slice(initializerRange.start, initializerRange.end),
  ).trim();
  return isNativeDocumentExpression(
    source,
    initializer,
    initializerRange.start,
    codePositions,
    visitedBindings,
  );
}

function assertNoUnsupportedBrowserApi(
  source: string,
  codePositions: Uint8Array,
): void {
  const candidates = [
    {
      pattern: /(?<![$.\u200C\u200D\p{ID_Continue}])(?:(globalThis|self|window)\s*\.\s*)?(navigator)\s*\.\s*serviceWorker\s*\.\s*register\s*\(/gu,
      label: 'service worker registration',
      bindingIndex: 1,
      fallbackBindingIndex: 2,
    },
    {
      pattern: /(?<![$.\u200C\u200D\p{ID_Continue}])(?:(globalThis|self|window)\s*\.\s*)?(serviceWorker)\s*\.\s*register\s*\(/gu,
      label: 'service worker registration',
      bindingIndex: 1,
      fallbackBindingIndex: 2,
    },
    {
      pattern: /(?<![$.\u200C\u200D\p{ID_Continue}])(?:(globalThis|self|window)\s*\.\s*)?((?:webkit)?RTCPeerConnection)\b/gu,
      label: 'WebRTC',
      bindingIndex: 1,
      fallbackBindingIndex: 2,
    },
  ] as const;

  for (const candidate of candidates) {
    for (const match of source.matchAll(candidate.pattern)) {
      if (match.index === undefined || codePositions[match.index] !== 1) {
        continue;
      }

      const bindingIdentifier = match[candidate.bindingIndex]
        ?? match[candidate.fallbackBindingIndex];

      if (
        bindingIdentifier !== undefined
        && findVisibleJavaScriptIdentifierBinding(
          source,
          bindingIdentifier,
          match.index,
          codePositions,
        ) === undefined
      ) {
        throw new Error(`Offline playtest does not support ${candidate.label}.`);
      }
    }
  }
}

function assertNoDynamicImport(
  source: string,
  codePositions: Uint8Array,
  braceKinds: Uint8Array,
): void {
  const pattern = /(?<![$\u200C\u200D\p{ID_Continue}])import(?![$\u200C\u200D\p{ID_Continue}])/gu;

  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined || codePositions[match.index] !== 1) {
      continue;
    }

    const previousCode = findPreviousJavaScriptCodeIndex(source, match.index - 1, codePositions);

    if (previousCode !== undefined && (source[previousCode] === '.' || source[previousCode] === '#')) {
      continue;
    }

    let openingParenthesis = match.index + match[0].length;

    while (
      openingParenthesis < source.length
      && (
        codePositions[openingParenthesis] !== 1
        || /\s/u.test(source[openingParenthesis] ?? '')
      )
    ) {
      openingParenthesis += 1;
    }

    if (source[openingParenthesis] !== '(') {
      continue;
    }

    let depth = 0;
    let closingParenthesis: number | undefined;

    for (let index = openingParenthesis; index < source.length; index += 1) {
      if (codePositions[index] !== 1) {
        continue;
      }

      if (source[index] === '(') {
        depth += 1;
      } else if (source[index] === ')') {
        depth -= 1;

        if (depth === 0) {
          closingParenthesis = index;
          break;
        }
      }
    }

    if (closingParenthesis !== undefined) {
      let nextCode = closingParenthesis + 1;

      while (
        nextCode < source.length
        && (
          codePositions[nextCode] !== 1
          || /\s/u.test(source[nextCode] ?? '')
        )
      ) {
        nextCode += 1;
      }

      if (
        source[nextCode] === '{'
        && isJavaScriptImportMethodDeclaration(
          source,
          match.index,
          previousCode,
          codePositions,
          braceKinds,
        )
      ) {
        continue;
      }
    }

    throw new Error('Offline playtest does not support dynamic import.');
  }
}

function isJavaScriptImportMethodDeclaration(
  source: string,
  importStart: number,
  previousCode: number | undefined,
  codePositions: Uint8Array,
  braceKinds: Uint8Array,
): boolean {
  const containerStart = findJavaScriptScopePath(source, importStart, codePositions).at(-1);
  const containerKind = containerStart === undefined ? 0 : braceKinds[containerStart];

  if (containerKind !== 2 && containerKind !== 3) {
    return false;
  }

  if (
    previousCode !== undefined
    && ['{', '}', ',', ';', '*'].includes(source[previousCode] ?? '')
  ) {
    return true;
  }

  const modifier = readPreviousJavaScriptIdentifier(source, importStart - 1, codePositions);
  return modifier !== undefined && ['async', 'get', 'set', 'static'].includes(modifier);
}

function assertNoUnsupportedWorkerConstruction(
  source: string,
  codePositions: Uint8Array,
): void {
  const pattern = new RegExp(
    `(?<![$.\\u200C\\u200D\\p{ID_Continue}])new\\s+(?:(globalThis|self|window)\\s*\\.\\s*)?((?:Shared)?Worker)\\s*\\(`,
    'gu',
  );

  for (const match of source.matchAll(pattern)) {
    if (
      match.index === undefined
      || match[2] === undefined
      || codePositions[match.index] !== 1
    ) {
      continue;
    }

    const bindingIdentifier = match[1] ?? match[2];

    if (
      findVisibleJavaScriptIdentifierBinding(
        source,
        bindingIdentifier,
        match.index,
        codePositions,
      ) === undefined
    ) {
      throw new Error('Offline playtest does not support Worker.');
    }
  }
}

function assertNoScriptDrivenNavigation(
  source: string,
  codePositions: Uint8Array,
): void {
  const globalObject = '(document|globalThis|parent|self|top|window)';
  const documentWriterPattern = /(?<![$.\u200C\u200D\p{ID_Continue}])(?:(globalThis|parent|self|top|window)\s*\.\s*)?document\s*\.\s*(?:write|writeln)\b/gu;

  for (const match of source.matchAll(documentWriterPattern)) {
    if (
      match.index !== undefined
      && codePositions[match.index] === 1
      && findVisibleJavaScriptIdentifierBinding(
        source,
        match[1] ?? 'document',
        match.index,
        codePositions,
      ) === undefined
    ) {
      throw new Error('Offline playtest does not support document.write or document.writeln.');
    }
  }

  const navigationPattern = /(?<![$.\u200C\u200D\p{ID_Continue}])(?:(globalThis|self|window)\s*\.\s*)?navigation\s*\.\s*(?:back|forward|navigate|reload|traverseTo)\s*\(/gu;

  for (const match of source.matchAll(navigationPattern)) {
    if (
      match.index !== undefined
      && codePositions[match.index] === 1
      && findVisibleJavaScriptIdentifierBinding(
        source,
        match[1] ?? 'navigation',
        match.index,
        codePositions,
      ) === undefined
    ) {
      throw new Error('Offline playtest does not support script-driven navigation.');
    }
  }

  const historyPattern = /(?<![$.\u200C\u200D\p{ID_Continue}])(?:(globalThis|self|window)\s*\.\s*)?history\s*\.\s*(?:back|forward|go)\s*\(/gu;

  for (const match of source.matchAll(historyPattern)) {
    if (
      match.index !== undefined
      && codePositions[match.index] === 1
      && findVisibleJavaScriptIdentifierBinding(
        source,
        match[1] ?? 'history',
        match.index,
        codePositions,
      ) === undefined
    ) {
      throw new Error('Offline playtest does not support script-driven navigation.');
    }
  }

  const historyPrototypePattern = /(?<![$.\u200C\u200D\p{ID_Continue}])(?:(globalThis|self|window)\s*\.\s*)?History\s*\.\s*prototype\s*\.\s*(?:back|forward|go)\s*\.\s*call\s*\(/gu;

  for (const match of source.matchAll(historyPrototypePattern)) {
    if (
      match.index !== undefined
      && codePositions[match.index] === 1
      && findVisibleJavaScriptIdentifierBinding(
        source,
        match[1] ?? 'History',
        match.index,
        codePositions,
      ) === undefined
    ) {
      throw new Error('Offline playtest does not support script-driven navigation.');
    }
  }

  const qualifiedOpenPattern = new RegExp(
    `(?<![$.\\u200C\\u200D\\p{ID_Continue}])${globalObject}\\s*\\.\\s*open\\s*\\(`,
    'gu',
  );

  for (const match of source.matchAll(qualifiedOpenPattern)) {
    if (
      match.index !== undefined
      && match[1] !== undefined
      && codePositions[match.index] === 1
      && findVisibleJavaScriptIdentifierBinding(
        source,
        match[1],
        match.index,
        codePositions,
      ) === undefined
    ) {
      if (match[1] === 'document') {
        const openingParenthesis = source.indexOf('(', match.index);
        const hasArguments = splitJavaScriptArguments(
          source,
          openingParenthesis,
          codePositions,
        ).some((argument) =>
          maskNonCode(
            source.slice(argument.start, argument.end),
            codePositions.slice(argument.start, argument.end),
          ).trim().length > 0,
        );

        if (!hasArguments) {
          continue;
        }
      }

      throw new Error('Offline playtest does not support script-driven navigation.');
    }
  }

  const aliasAssignments = findLocationAliasAssignments(source, codePositions);
  assertNoIndirectLocationMutation(source, codePositions, aliasAssignments);

  const locationOperation = '(?:\\s*\\.\\s*(?:assign|replace)\\b|(?:\\s*\\.\\s*href)?\\s*(?:(?:&&|\\?\\?|\\|\\|)|[+\\-*/%&|^])?=(?!=))';
  const groupedLocationOperationPattern = new RegExp(locationOperation, 'uy');
  const codeOnlySource = maskNonCodePreservingLength(source, codePositions);

  for (let closingParenthesis = 0; closingParenthesis < source.length; closingParenthesis += 1) {
    if (source[closingParenthesis] !== ')' || codePositions[closingParenthesis] !== 1) {
      continue;
    }

    groupedLocationOperationPattern.lastIndex = closingParenthesis + 1;

    if (groupedLocationOperationPattern.exec(codeOnlySource) === null) {
      continue;
    }

    const openingParenthesis = findMatchingJavaScriptOpeningParenthesis(
      source,
      closingParenthesis,
      codePositions,
    );

    if (
      openingParenthesis === undefined
      || !isJavaScriptGroupingParenthesis(source, openingParenthesis, codePositions)
    ) {
      continue;
    }

    const expressionRange = trimSourceRange(source, {
      start: openingParenthesis + 1,
      end: closingParenthesis,
    });
    const expression = maskNonCode(
      source.slice(expressionRange.start, expressionRange.end),
      codePositions.slice(expressionRange.start, expressionRange.end),
    ).trim();

    if (
      isLocationAliasExpression(
        source,
        expression,
        expressionRange.start,
        codePositions,
        aliasAssignments,
        new Set<string>(),
      )
    ) {
      throw new Error('Offline playtest does not support script-driven navigation.');
    }
  }

  const qualifiedLocationPattern = new RegExp(
    `(?<![$.\\u200C\\u200D\\p{ID_Continue}])${globalObject}\\s*\\.\\s*location${locationOperation}`,
    'gu',
  );

  for (const match of source.matchAll(qualifiedLocationPattern)) {
    if (
      match.index !== undefined
      && match[1] !== undefined
      && codePositions[match.index] === 1
      && findVisibleJavaScriptIdentifierBinding(
        source,
        match[1],
        match.index,
        codePositions,
      ) === undefined
    ) {
      throw new Error('Offline playtest does not support script-driven navigation.');
    }
  }

  const unqualifiedLocationPattern = new RegExp(
    `(?<![$.\\u200C\\u200D\\p{ID_Continue}])location${locationOperation}`,
    'gu',
  );

  for (const match of source.matchAll(unqualifiedLocationPattern)) {
    if (
      match.index !== undefined
      && codePositions[match.index] === 1
      && findVisibleJavaScriptIdentifierBinding(
        source,
        'location',
        match.index,
        codePositions,
      ) === undefined
    ) {
      throw new Error('Offline playtest does not support script-driven navigation.');
    }
  }

  const aliasPattern = new RegExp(
    `(?<![$.\\u200C\\u200D\\p{ID_Continue}])(${javascriptIdentifierPatternSource})${locationOperation}`,
    'gu',
  );
  const potentialAliases = findPotentialLocationAliasIdentifiers(aliasAssignments);

  for (const match of source.matchAll(aliasPattern)) {
    if (
      match.index === undefined
      || match[1] === undefined
      || codePositions[match.index] !== 1
      || !potentialAliases.has(match[1])
    ) {
      continue;
    }

    if (
      isLocationAliasIdentifierAtPosition(
        source,
        match[1],
        match.index,
        codePositions,
        aliasAssignments,
        new Set<string>(),
      )
    ) {
      throw new Error('Offline playtest does not support script-driven navigation.');
    }
  }
}

function isJavaScriptGroupingParenthesis(
  source: string,
  openingParenthesis: number,
  codePositions: Uint8Array,
): boolean {
  const previousCode = findPreviousJavaScriptCodeIndex(
    source,
    openingParenthesis - 1,
    codePositions,
  );

  if (previousCode === undefined) {
    return true;
  }

  const previousCharacter = source[previousCode] ?? '';

  if (/[$\u200C\u200D\p{ID_Continue}]/u.test(previousCharacter)) {
    return ['await', 'case', 'delete', 'return', 'throw', 'typeof', 'void', 'yield'].includes(
      readPreviousJavaScriptIdentifier(source, previousCode, codePositions) ?? '',
    );
  }

  return previousCharacter !== ')' && previousCharacter !== ']';
}

function assertNoIndirectLocationMutation(
  source: string,
  codePositions: Uint8Array,
  aliasAssignments: readonly LocationAliasAssignment[],
): void {
  const bulkDescriptorPattern = /(?<![$.\u200C\u200D\p{ID_Continue}])(?:(globalThis|self|window)\s*\.\s*)?(Object)\s*\.\s*getOwnPropertyDescriptors\s*\(/gu;

  for (const match of source.matchAll(bulkDescriptorPattern)) {
    if (
      match.index === undefined
      || codePositions[match.index] !== 1
      || findVisibleJavaScriptIdentifierBinding(
        source,
        match[1] ?? match[2] ?? 'Object',
        match.index,
        codePositions,
      ) !== undefined
    ) {
      continue;
    }

    const openingParenthesis = source.indexOf('(', match.index);
    const target = splitJavaScriptArguments(source, openingParenthesis, codePositions)[0];

    if (target === undefined) {
      continue;
    }

    const targetExpression = maskNonCode(
      source.slice(target.start, target.end),
      codePositions.slice(target.start, target.end),
    ).trim();

    if (
      isLocationAliasExpression(
        source,
        targetExpression,
        target.start,
        codePositions,
        aliasAssignments,
        new Set<string>(),
      )
    ) {
      throw new Error('Offline playtest does not support script-driven navigation.');
    }
  }

  const descriptorPattern = /(?<![$.\u200C\u200D\p{ID_Continue}])(?:(globalThis|self|window)\s*\.\s*)?(Object|Reflect)\s*\.\s*getOwnPropertyDescriptor\s*\(/gu;

  for (const match of source.matchAll(descriptorPattern)) {
    if (
      match.index === undefined
      || codePositions[match.index] !== 1
      || findVisibleJavaScriptIdentifierBinding(
        source,
        match[1] ?? match[2] ?? 'Object',
        match.index,
        codePositions,
      ) !== undefined
    ) {
      continue;
    }

    const openingParenthesis = source.indexOf('(', match.index);
    const arguments_ = splitJavaScriptArguments(source, openingParenthesis, codePositions);
    const target = arguments_[0];
    const property = arguments_[1] === undefined
      ? undefined
      : readStaticJavaScriptStringWithTrivia(source, arguments_[1], codePositions);

    if (target === undefined || property !== 'href') {
      continue;
    }

    const targetExpression = maskNonCode(
      source.slice(target.start, target.end),
      codePositions.slice(target.start, target.end),
    ).trim();

    if (
      isLocationAliasExpression(
        source,
        targetExpression,
        target.start,
        codePositions,
        aliasAssignments,
        new Set<string>(),
      )
    ) {
      throw new Error('Offline playtest does not support script-driven navigation.');
    }
  }

  const pattern = /(?<![$.\u200C\u200D\p{ID_Continue}])(?:(globalThis|self|window)\s*\.\s*)?(Object|Reflect)\s*\.\s*(assign|defineProperties|defineProperty|set)\s*\(/gu;

  for (const match of source.matchAll(pattern)) {
    if (
      match.index === undefined
      || match[2] === undefined
      || match[3] === undefined
      || codePositions[match.index] !== 1
      || findVisibleJavaScriptIdentifierBinding(
        source,
        match[1] ?? match[2],
        match.index,
        codePositions,
      ) !== undefined
      || (
        match[2] === 'Object'
          ? !['assign', 'defineProperties', 'defineProperty'].includes(match[3])
          : !['defineProperty', 'set'].includes(match[3])
      )
    ) {
      continue;
    }

    const openingParenthesis = source.indexOf('(', match.index);
    const target = splitJavaScriptArguments(source, openingParenthesis, codePositions)[0];

    if (target === undefined) {
      continue;
    }

    const targetExpression = maskNonCode(
      source.slice(target.start, target.end),
      codePositions.slice(target.start, target.end),
    ).trim();

    if (
      isLocationAliasExpression(
        source,
        targetExpression,
        target.start,
        codePositions,
        aliasAssignments,
        new Set<string>(),
      )
    ) {
      throw new Error('Offline playtest does not support script-driven navigation.');
    }
  }
}

function findLocationAliasAssignments(
  source: string,
  codePositions: Uint8Array,
): readonly LocationAliasAssignment[] {
  // A logical assignment may conditionally replace its receiver with Location. Treating the
  // right-hand side as a possible alias keeps later navigation checks conservative.
  const assignmentPattern = new RegExp(
    `(?<![$.\\u200C\\u200D\\p{ID_Continue}])(${javascriptIdentifierPatternSource})\\s*(?:&&=|\\|\\|=|\\?\\?=|=)\\s*(?!=|>)`,
    'gu',
  );
  const assignments: LocationAliasAssignment[] = [];

  for (const match of source.matchAll(assignmentPattern)) {
    if (
      match.index === undefined
      || match[1] === undefined
      || codePositions[match.index] !== 1
    ) {
      continue;
    }

    const previous = findPreviousJavaScriptCodeIndex(source, match.index - 1, codePositions);

    if (previous !== undefined && (source[previous] === '.' || source[previous] === '?')) {
      continue;
    }

    const expressionStart = match.index + match[0].length;
    const expressionRange = findJavaScriptExpressionRange(
      source,
      expressionStart,
      source.length,
      codePositions,
      true,
      true,
    );
    const expression = maskNonCode(
      source.slice(expressionRange.start, expressionRange.end),
      codePositions.slice(expressionRange.start, expressionRange.end),
    ).trim();
    assignments.push({
      expression,
      expressionRange,
      identifier: match[1],
      start: match.index,
    });
  }

  const destructuringPattern = /\b(?:const|let|var)\s*\{([^;=\r\n]*)\}\s*=\s*/gu;

  for (const match of source.matchAll(destructuringPattern)) {
    if (
      match.index === undefined
      || match[1] === undefined
      || codePositions[match.index] !== 1
    ) {
      continue;
    }

    const expressionStart = match.index + match[0].length;
    const expressionRange = findJavaScriptExpressionRange(
      source,
      expressionStart,
      source.length,
      codePositions,
      true,
      true,
    );
    const objectExpression = maskNonCode(
      source.slice(expressionRange.start, expressionRange.end),
      codePositions.slice(expressionRange.start, expressionRange.end),
    ).trim();
    const bindingSource = match[1];
    const bindingStart = match.index + match[0].indexOf(bindingSource);
    const locationPropertyPattern = new RegExp(
      `(?:^|,)\\s*location\\s*(?::\\s*(${javascriptIdentifierPatternSource})|(?=\\s*(?:,|$)))`,
      'gu',
    );

    for (const property of bindingSource.matchAll(locationPropertyPattern)) {
      const identifier = property[1] ?? 'location';
      const propertyOffset = property.index ?? 0;
      assignments.push({
        expression: `${objectExpression}.location`,
        expressionRange,
        identifier,
        start: bindingStart + propertyOffset + property[0].lastIndexOf(identifier),
      });
    }
  }

  return assignments;
}

function findPotentialLocationAliasIdentifiers(
  assignments: readonly LocationAliasAssignment[],
): ReadonlySet<string> {
  const aliases = new Set<string>();
  let previousSize = -1;

  while (aliases.size !== previousSize) {
    previousSize = aliases.size;

    for (const assignment of assignments) {
      if (isPotentialLocationAliasExpression(assignment.expression, aliases)) {
        aliases.add(assignment.identifier);
      }
    }
  }

  return aliases;
}

function isPotentialLocationAliasExpression(
  expression: string,
  aliases: ReadonlySet<string>,
): boolean {
  const unwrapped = unwrapBalancedOuterParentheses(expression);

  if (unwrapped.offset > 0 || unwrapped.expression.length !== expression.length) {
    return isPotentialLocationAliasExpression(unwrapped.expression, aliases);
  }

  const sequenceResult = findSequenceExpressionLastValue(expression);

  if (sequenceResult !== undefined) {
    return isPotentialLocationAliasExpression(sequenceResult.expression, aliases);
  }

  const isDirectLocation =
    /^(?:(?:document|globalThis|parent|self|top|window)\s*\.\s*)?location$/u.test(expression);

  if (isDirectLocation || aliases.has(expression)) {
    return true;
  }

  const assignmentResult = findAssignmentResultRightHandSide(expression);
  return assignmentResult !== undefined
    && isPotentialLocationAliasExpression(assignmentResult.expression, aliases);
}

function findAssignmentResultRightHandSide(
  expression: string,
): Readonly<{ expression: string; offset: number }> | undefined {
  const pattern = new RegExp(
    `^(?:${javascriptIdentifierPatternSource})\\s*(?:&&=|\\|\\|=|\\?\\?=|=)\\s*(?!=|>)([\\s\\S]+)$`,
    'u',
  );
  const match = pattern.exec(expression);

  if (match?.[1] === undefined) {
    return undefined;
  }

  return {
    expression: match[1],
    offset: match[0].length - match[1].length,
  };
}

function unwrapBalancedOuterParentheses(
  expression: string,
): Readonly<{ expression: string; offset: number }> {
  let start = 0;
  let end = expression.length;

  while (start < end && /\s/u.test(expression[start] ?? '')) {
    start += 1;
  }

  while (start < end && /\s/u.test(expression[end - 1] ?? '')) {
    end -= 1;
  }

  while (expression[start] === '(' && expression[end - 1] === ')') {
    let depth = 0;
    let matchingClose: number | undefined;

    for (let index = start; index < end; index += 1) {
      if (expression[index] === '(') {
        depth += 1;
      } else if (expression[index] === ')') {
        depth -= 1;

        if (depth === 0) {
          matchingClose = index;
          break;
        }
      }
    }

    if (matchingClose !== end - 1) {
      break;
    }

    start += 1;
    end -= 1;

    while (start < end && /\s/u.test(expression[start] ?? '')) {
      start += 1;
    }

    while (start < end && /\s/u.test(expression[end - 1] ?? '')) {
      end -= 1;
    }
  }

  return { expression: expression.slice(start, end), offset: start };
}

function findSequenceExpressionLastValue(
  expression: string,
): Readonly<{ expression: string; offset: number }> | undefined {
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let lastComma: number | undefined;

  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];

    if (character === '(') {
      parenthesisDepth += 1;
    } else if (character === ')') {
      parenthesisDepth -= 1;
    } else if (character === '[') {
      bracketDepth += 1;
    } else if (character === ']') {
      bracketDepth -= 1;
    } else if (character === '{') {
      braceDepth += 1;
    } else if (character === '}') {
      braceDepth -= 1;
    } else if (
      character === ','
      && parenthesisDepth === 0
      && bracketDepth === 0
      && braceDepth === 0
    ) {
      lastComma = index;
    }

    if (parenthesisDepth < 0 || bracketDepth < 0 || braceDepth < 0) {
      return undefined;
    }
  }

  if (
    lastComma === undefined
    || parenthesisDepth !== 0
    || bracketDepth !== 0
    || braceDepth !== 0
  ) {
    return undefined;
  }

  let offset = lastComma + 1;

  while (offset < expression.length && /\s/u.test(expression[offset] ?? '')) {
    offset += 1;
  }

  return { expression: expression.slice(offset).trimEnd(), offset };
}

function isLocationAliasIdentifierAtPosition(
  source: string,
  identifier: string,
  position: number,
  codePositions: Uint8Array,
  assignments: readonly LocationAliasAssignment[],
  visitedAliases: Set<string>,
): boolean {
  const binding = findVisibleJavaScriptIdentifierBinding(
    source,
    identifier,
    position,
    codePositions,
  );
  let aliasKey = `unbound:${identifier}`;

  if (binding?.kind === 'parameter') {
    aliasKey = `parameter:${identifier}:${binding.bindingPath.join(',')}`;
  } else if (binding !== undefined) {
    aliasKey = `binding:${binding.start}`;
  }

  if (
    (
      binding !== undefined
      && (
        binding.start >= position
        || (binding.start < 0 && binding.kind !== 'parameter')
      )
    )
    || visitedAliases.has(aliasKey)
  ) {
    return false;
  }

  visitedAliases.add(aliasKey);
  const initializerRange = binding?.initializerRange === undefined
    ? undefined
    : trimSourceRange(source, binding.initializerRange);

  if (
    initializerRange !== undefined
    && initializerRange.end <= position
    && isLocationAliasExpression(
      source,
      maskNonCode(
        source.slice(initializerRange.start, initializerRange.end),
        codePositions.slice(initializerRange.start, initializerRange.end),
      ).trim(),
      initializerRange.start,
      codePositions,
      assignments,
      new Set(visitedAliases),
    )
  ) {
    return true;
  }

  for (const assignment of assignments) {
    if (
      assignment.identifier !== identifier
      || (binding !== undefined && assignment.start <= binding.start)
      || assignment.expressionRange.end > position
    ) {
      continue;
    }

    const assignmentBinding = findVisibleJavaScriptIdentifierBinding(
      source,
      identifier,
      assignment.start,
      codePositions,
    );
    let matchesParameterDefault = false;

    if (binding?.kind === 'parameter') {
      matchesParameterDefault = isInsideJavaScriptParameterBinding(
        source,
        assignment.start,
        binding,
        codePositions,
      );
    }

    if (
      (
        binding === undefined
        || assignmentBinding?.start === binding.start
        || matchesParameterDefault
      )
      && isLocationAliasExpression(
        source,
        assignment.expression,
        assignment.expressionRange.start,
        codePositions,
        assignments,
        new Set(visitedAliases),
      )
    ) {
      return true;
    }
  }

  return false;
}

function isInsideJavaScriptParameterBinding(
  source: string,
  position: number,
  binding: JavaScriptIdentifierBinding,
  codePositions: Uint8Array,
): boolean {
  const blockStart = binding.bindingPath.at(-1);

  if (blockStart === undefined) {
    return false;
  }

  const header = findJavaScriptBlockBindingHeader(source, blockStart, codePositions);
  return header?.kind === 'function'
    && header.parameters.start <= position
    && position < header.parameters.end;
}

function isLocationAliasExpression(
  source: string,
  expression: string,
  position: number,
  codePositions: Uint8Array,
  assignments: readonly LocationAliasAssignment[],
  visitedAliases: Set<string>,
): boolean {
  const unwrapped = unwrapBalancedOuterParentheses(expression);

  if (unwrapped.offset > 0 || unwrapped.expression.length !== expression.length) {
    return isLocationAliasExpression(
      source,
      unwrapped.expression,
      position + unwrapped.offset,
      codePositions,
      assignments,
      visitedAliases,
    );
  }

  const sequenceResult = findSequenceExpressionLastValue(expression);

  if (sequenceResult !== undefined) {
    return isLocationAliasExpression(
      source,
      sequenceResult.expression,
      position + sequenceResult.offset,
      codePositions,
      assignments,
      visitedAliases,
    );
  }

  const qualified = /^(document|globalThis|parent|self|top|window)\s*\.\s*location$/u.exec(
    expression,
  );

  if (qualified?.[1] !== undefined) {
    return findVisibleJavaScriptIdentifierBinding(
      source,
      qualified[1],
      position,
      codePositions,
    ) === undefined;
  }

  if (expression === 'location') {
    return findVisibleJavaScriptIdentifierBinding(
      source,
      'location',
      position,
      codePositions,
    ) === undefined;
  }

  const assignmentResult = findAssignmentResultRightHandSide(expression);

  if (assignmentResult !== undefined) {
    return isLocationAliasExpression(
      source,
      assignmentResult.expression,
      position + assignmentResult.offset,
      codePositions,
      assignments,
      visitedAliases,
    );
  }

  if (!new RegExp(`^${javascriptIdentifierPatternSource}$`, 'u').test(expression)) {
    return false;
  }

  return isLocationAliasIdentifierAtPosition(
    source,
    expression,
    position,
    codePositions,
    assignments,
    visitedAliases,
  );
}

function normalizeRuntimeGlobalAliases(source: string): string {
  const codePositions = createCodePositionMap(source, true);
  const pattern = /(?<![$.\u200C\u200D\p{ID_Continue}])document\s*\.\s*defaultView\b/gu;
  const replacements: SourceReplacement[] = [];

  for (const match of source.matchAll(pattern)) {
    if (
      match.index !== undefined
      && codePositions[match.index] === 1
      && findVisibleJavaScriptIdentifierBinding(
        source,
        'document',
        match.index,
        codePositions,
      ) === undefined
    ) {
      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        value: 'window',
      });
    }
  }

  let output = source;

  for (const replacement of replacements.reverse()) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }

  return output;
}

function normalizeJavaScriptIdentifierEscapes(source: string): string {
  const codePositions = createCodePositionMap(source, true);
  const pattern = /\\u(?:\{([\dA-Fa-f]{1,6})\}|([\dA-Fa-f]{4}))/gu;
  const replacements: SourceReplacement[] = [];

  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined || codePositions[match.index] !== 1) {
      continue;
    }

    const hexadecimal = match[1] ?? match[2] ?? '';
    const codePoint = Number.parseInt(hexadecimal, 16);
    const identifierPart = codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : undefined;

    if (identifierPart !== undefined && isJavaScriptIdentifierPart(identifierPart)) {
      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        value: identifierPart,
      });
    }
  }

  let output = source;

  for (const replacement of replacements.reverse()) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }

  return output;
}

function normalizeStaticJavaScriptPropertyAccess(source: string): string {
  const codePositions = createCodePositionMap(source, true);
  const pattern = /\[\s*(?:"((?:\\(?:\r\n|[\s\S])|[^"\\\r\n])*)"|'((?:\\(?:\r\n|[\s\S])|[^'\\\r\n])*)'|`((?:\\(?:\r\n|[\s\S])|[^`\\$\r\n]|\$(?!\{))*)`)\s*\]/gu;
  const replacements: SourceReplacement[] = [];

  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined || codePositions[match.index] !== 1) {
      continue;
    }

    const property = decodeJavaScriptStringLiteral(match[1] ?? match[2] ?? match[3] ?? '');

    if (/^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u.test(property)) {
      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        value: `.${property}`,
      });
    }
  }

  let output = source;

  for (const replacement of replacements.reverse()) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }

  return output.replace(/\?\.\s*(?=\()/gu, '').replace(/\?\./gu, '.');
}

function normalizeStaticJavaScriptPropertyKeys(source: string): string {
  const codePositions = createCodePositionMap(source, true);
  const stringLiteralPatternSource = /"((?:\\(?:\r\n|[\s\S])|[^"\\\r\n])*)"|'((?:\\(?:\r\n|[\s\S])|[^'\\\r\n])*)'|`((?:\\(?:\r\n|[\s\S])|[^`\\$\r\n]|\$(?!\{))*)`/u.source;
  const pattern = new RegExp(
    `${stringLiteralPatternSource}|\\[\\s*(?:${stringLiteralPatternSource})\\s*\\]`,
    'gu',
  );
  const replacements: SourceReplacement[] = [];

  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined || codePositions[match.index] !== 1) {
      continue;
    }

    const previous = findAdjacentJavaScriptCodeCharacter(
      source,
      match.index - 1,
      -1,
      codePositions,
    );
    let colon = match.index + match[0].length;

    while (
      colon < source.length
      && (codePositions[colon] !== 1 || /\s/u.test(source[colon] ?? ''))
    ) {
      colon += 1;
    }

    if ((previous !== '{' && previous !== ',') || source[colon] !== ':') {
      continue;
    }

    const propertyName = decodeJavaScriptStringLiteral(
      match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? '',
    );

    if (
      !/^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u.test(propertyName)
      || propertyName.length > match[0].length
    ) {
      continue;
    }

    replacements.push({
      start: match.index,
      end: match.index + match[0].length,
      value: propertyName.padEnd(match[0].length),
    });
  }

  let output = source;

  for (const replacement of replacements.reverse()) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }

  return output;
}

function maskNonCode(source: string, codePositions: Uint8Array): string {
  const chunks: string[] = [];
  let codeStart: number | undefined;

  for (let index = 0; index < source.length; index += 1) {
    if (codePositions[index] === 1) {
      codeStart ??= index;
    } else if (codeStart !== undefined) {
      chunks.push(source.slice(codeStart, index), ' ');
      codeStart = undefined;
    }
  }

  if (codeStart !== undefined) {
    chunks.push(source.slice(codeStart));
  }

  return chunks.join('');
}

function maskNonCodePreservingLength(source: string, codePositions: Uint8Array): string {
  const characters = new Array<string>(source.length);

  for (let index = 0; index < source.length; index += 1) {
    characters[index] = codePositions[index] === 1 ? (source[index] ?? '') : ' ';
  }

  return characters.join('');
}

function createCodePositionMap(
  source: string,
  allowLineComments: boolean,
  braceKindPositions?: Uint8Array,
): Uint8Array {
  const positions = new Uint8Array(source.length);
  positions.fill(1);

  if (allowLineComments) {
    scanJavaScriptCodePositions(source, positions, 0, false, false, 0, braceKindPositions);
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
  braceKindPositions?: Uint8Array,
): number {
  if (depth > 64) {
    throw new Error('Offline playtest JavaScript exceeds the supported template nesting depth.');
  }

  let regexAllowed = true;
  let pendingControlParenthesis = false;
  let pendingClassBody = false;
  let pendingClassBodyCompletesExpression = false;
  let pendingAsyncFunctionCompletesExpression: boolean | undefined;
  const pendingFunctionBodiesCompletingExpression: boolean[] = [];
  let nextBraceIsBlock = false;
  let previousToken: string | undefined;
  const parenthesisKinds: Array<'control' | 'normal'> = [];
  const braceKinds: boolean[] = [];
  const braceCompletesExpression: boolean[] = [];

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
      index = markTemplateLiteral(source, positions, index, depth + 1, braceKindPositions);
      regexAllowed = false;
      pendingControlParenthesis = false;
      previousToken = 'value';
      continue;
    }

    const identifierStartCharacter = readCodePointAt(source, index);

    if (
      identifierStartCharacter !== undefined
      && isJavaScriptIdentifierStart(identifierStartCharacter)
    ) {
      const declarationPosition = previousToken === undefined
        || [';', 'block-open', 'block-close', 'export', 'default'].includes(previousToken);
      const identifierStart = index;
      index += identifierStartCharacter.length;

      while (true) {
        const identifierPart = readCodePointAt(source, index);

        if (identifierPart === undefined || !isJavaScriptIdentifierPart(identifierPart)) {
          break;
        }

        index += identifierPart.length;
      }

      const identifier = source.slice(identifierStart, index);
      index -= 1;
      pendingControlParenthesis = javascriptControlParenthesisKeywords.has(identifier);

      if (identifier === 'async') {
        pendingAsyncFunctionCompletesExpression = !declarationPosition;
      } else if (identifier === 'function') {
        const functionCompletesExpression = previousToken === 'async'
          ? (pendingAsyncFunctionCompletesExpression ?? true)
          : !declarationPosition;
        pendingFunctionBodiesCompletingExpression.push(functionCompletesExpression);
        pendingAsyncFunctionCompletesExpression = undefined;
      }

      if (identifier === 'class') {
        pendingClassBody = true;
        pendingClassBodyCompletesExpression = !declarationPosition;
      }

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
      const isArrowBody = previousToken === '=>';
      const isFunctionBody = isBlock
        && !isArrowBody
        && findJavaScriptBlockBindingHeader(source, index, positions)?.kind === 'function';
      const functionBodyCompletesExpression = isFunctionBody
        ? (pendingFunctionBodiesCompletingExpression.pop() ?? false)
        : false;
      const completesExpression = !isBlock
        || isArrowBody
        || (isClassBody && pendingClassBodyCompletesExpression)
        || functionBodyCompletesExpression;
      braceKinds.push(isBlock);
      braceCompletesExpression.push(completesExpression);

      if (braceKindPositions !== undefined) {
        braceKindPositions[index] = isClassBody ? 3 : isBlock ? 1 : 2;
      }

      pendingClassBody &&= !isClassBody;
      if (isClassBody) {
        pendingClassBodyCompletesExpression = false;
      }
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
      const completesExpression = braceCompletesExpression.pop() ?? false;
      regexAllowed = isBlock && !completesExpression;
      pendingControlParenthesis = false;
      previousToken = completesExpression ? 'value' : isBlock ? 'block-close' : 'object-close';
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
  braceKindPositions?: Uint8Array,
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
        braceKindPositions,
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
  return value !== undefined && /^[$_\p{ID_Start}]$/u.test(value);
}

function isJavaScriptIdentifierPart(value: string | undefined): boolean {
  return value !== undefined && /^[$\u200C\u200D\p{ID_Continue}]$/u.test(value);
}

function readCodePointAt(source: string, index: number): string | undefined {
  const codePoint = source.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function decodeJavaScriptStringLiteral(value: string): string {
  let output = '';

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';

    if (character !== '\\') {
      output += character;
      continue;
    }

    const escape = value[index + 1];

    if (escape === undefined) {
      throw new Error('Invalid trailing escape in an offline playtest JavaScript asset URL.');
    }

    index += 1;

    const simpleEscape = ({
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
    } as Readonly<Record<string, string>>)[escape];

    if (simpleEscape !== undefined) {
      output += simpleEscape;
      continue;
    }

    if (escape === '0') {
      if (/\d/u.test(value[index + 1] ?? '')) {
        throw new Error('Legacy octal escapes are unsupported in offline playtest asset URLs.');
      }

      output += '\0';
      continue;
    }

    if (escape === 'x') {
      const hexadecimal = value.slice(index + 1, index + 3);

      if (!/^[\dA-Fa-f]{2}$/u.test(hexadecimal)) {
        throw new Error('Invalid hexadecimal escape in an offline playtest JavaScript asset URL.');
      }

      output += String.fromCharCode(Number.parseInt(hexadecimal, 16));
      index += 2;
      continue;
    }

    if (escape === 'u') {
      const braced = value[index + 1] === '{';
      const close = braced ? value.indexOf('}', index + 2) : index + 5;
      const hexadecimal = braced ? value.slice(index + 2, close) : value.slice(index + 1, close);

      if (
        close === -1
        || !(braced ? /^[\dA-Fa-f]{1,6}$/u : /^[\dA-Fa-f]{4}$/u).test(hexadecimal)
      ) {
        throw new Error('Invalid Unicode escape in an offline playtest JavaScript asset URL.');
      }

      const codePoint = Number.parseInt(hexadecimal, 16);

      if (codePoint > 0x10FFFF) {
        throw new Error('Out-of-range Unicode escape in an offline playtest JavaScript asset URL.');
      }

      output += braced ? String.fromCodePoint(codePoint) : String.fromCharCode(codePoint);
      index = braced ? close : close - 1;
      continue;
    }

    if (escape === '\r' || escape === '\n' || escape === '\u2028' || escape === '\u2029') {
      if (escape === '\r' && value[index + 1] === '\n') {
        index += 1;
      }

      continue;
    }

    if (/[1-9]/u.test(escape)) {
      throw new Error('Legacy octal escapes are unsupported in offline playtest asset URLs.');
    }

    output += escape;
  }

  return output;
}

function containsUnescapedTemplateInterpolation(value: string): boolean {
  let backslashes = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (character === '\\') {
      backslashes += 1;
      continue;
    }

    if (character === '$' && value[index + 1] === '{' && backslashes % 2 === 0) {
      return true;
    }

    backslashes = 0;
  }

  return false;
}

function readAssetDataUrl(
  sourceFile: string,
  reference: string,
  context: InliningContext,
): string {
  const normalizedReference = normalizeUrlReference(reference);
  const fragmentIndex = normalizedReference.indexOf('#');
  const fragment = fragmentIndex === -1 ? '' : normalizedReference.slice(fragmentIndex);
  const assetFile = resolveLocalReference(
    context.artifactRoot,
    path.dirname(sourceFile),
    normalizedReference,
  );
  const extension = path.extname(assetFile).toLowerCase();
  const mimeType = mimeTypes.get(extension);

  if (mimeType === undefined) {
    throw new Error(
      `Unsupported offline asset type: ${path.relative(context.artifactRoot, assetFile)}`,
    );
  }

  let dataUrl = context.assetDataUrls.get(assetFile);
  const assetBytes = statSync(assetFile).size;

  if (assetBytes > context.maximumBytes) {
    throw new Error(
      `Offline asset ${path.relative(context.artifactRoot, assetFile)} is ${assetBytes} bytes, exceeding the ${context.maximumBytes}-byte limit.`,
    );
  }

  const dataUrlBytes = dataUrl === undefined
    ? Buffer.byteLength(`data:${mimeType};base64,`) + Math.ceil(assetBytes / 3) * 4
    : Buffer.byteLength(dataUrl);
  const nextInlinedAssetBytes = context.inlinedAssetBytes
    + dataUrlBytes
    + Buffer.byteLength(fragment);

  if (nextInlinedAssetBytes > context.maximumBytes) {
    throw new Error(
      `Offline asset data URLs total ${nextInlinedAssetBytes} bytes while inlining ${path.relative(context.artifactRoot, assetFile)}, exceeding the ${context.maximumBytes}-byte limit.`,
    );
  }

  if (dataUrl === undefined) {
    const asset = readFileSync(assetFile);

    if (extension === '.gltf') {
      assertSelfContainedGltf(assetFile, asset.toString('utf8'));
    } else if (extension === '.glb') {
      assertSelfContainedGlb(assetFile, asset);
    } else if (extension === '.htm' || extension === '.html') {
      assertSelfContainedHtmlAsset(assetFile, asset.toString('utf8'));
    } else if (extension === '.svg') {
      assertSelfContainedSvg(assetFile, asset.toString('utf8'));
    } else if (extension === '.xml') {
      assertSelfContainedXml(assetFile, asset.toString('utf8'));
    }

    dataUrl = `data:${mimeType};base64,${asset.toString('base64')}`;
    context.assetDataUrls.set(assetFile, dataUrl);
  }

  context.inlinedAssetBytes = nextInlinedAssetBytes;
  context.inlinedAssets.add(assetFile);
  return `${dataUrl}${fragment}`;
}

function assertSelfContainedXml(xmlFile: string, source: string): void {
  const unsafeMarkup = findUnsafeXmlMarkup(source);

  if (unsafeMarkup !== undefined) {
    throw new Error(
      `Offline playtest requires inert self-contained XML assets: ${xmlFile} contains ${unsafeMarkup}`,
    );
  }

  try {
    assertSelfContainedHtmlAsset(xmlFile, source);
    assertSelfContainedSvg(xmlFile, source);
  } catch (error) {
    throw new Error(
      `Offline playtest requires inert self-contained XML assets: ${xmlFile}. ${errorMessage(error)}`,
    );
  }
}

function findUnsafeXmlMarkup(source: string): string | undefined {
  return /<!DOCTYPE\b|<\?(?!xml(?:\s|\?>))/iu.exec(source)?.[0];
}

function assertSelfContainedHtmlAsset(htmlFile: string, source: string): void {
  for (const tag of findHtmlTagTokens(maskHtmlRawTextBodies(source))) {
    if (tag.closing) {
      continue;
    }

    if (tag.name === 'script' || tag.name === 'iframe') {
      throw new Error(
        `Offline playtest requires inert self-contained HTML assets: ${htmlFile} contains <${tag.name}>`,
      );
    }

    if (
      tag.name === 'meta'
      && readHtmlAttributeToken(tag.attributes, 'http-equiv')?.trim().toLowerCase() === 'refresh'
    ) {
      throw new Error(
        `Offline playtest requires inert self-contained HTML assets: ${htmlFile} contains meta refresh`,
      );
    }

    const rel = tag.name === 'link' ? readHtmlRelTokenSet(tag.attributes) : undefined;

    for (const attribute of tag.attributes) {
      if (attribute.name.length > 2 && attribute.name.startsWith('on')) {
        throw new Error(
          `Offline playtest requires inert self-contained HTML assets: ${htmlFile} contains ${attribute.name}`,
        );
      }

      if (attribute.value === undefined) {
        continue;
      }

      const value = decodeHtmlCharacterReferences(attribute.value);

      if (
        tag.name === 'link'
        && attribute.name === 'href'
        && rel?.has('stylesheet') === true
        && isDataUrlReference(value)
      ) {
        throw new Error(
          `Offline playtest requires inert self-contained HTML assets: ${htmlFile} contains a data-backed stylesheet`,
        );
      }

      if (
        (
          (tag.name === 'object' && attribute.name === 'data')
          || (tag.name === 'embed' && attribute.name === 'src')
        )
        && isDataUrlReference(value)
      ) {
        throw new Error(
          `Offline playtest requires inert self-contained HTML assets: ${htmlFile} contains an embedded active data document`,
        );
      }

      if (
        isActiveEmbeddedNavigationAttribute(tag.name, attribute.name)
        && (isDataUrlReference(value) || isJavaScriptUrlReference(value))
      ) {
        throw new Error(
          `Offline playtest requires inert self-contained HTML assets: ${htmlFile} contains an active hyperlink URL`,
        );
      }

      if (attribute.name === 'style') {
        const reference = findExternalCssReference(value);

        if (reference !== undefined) {
          throw new Error(
            `Offline playtest requires self-contained HTML assets: ${htmlFile} references ${reference}`,
          );
        }
      }

      const resourceAttributes = htmlAssetAttributesByTag[tag.name] ?? [];
      const isResourceReference = resourceAttributes.includes(attribute.name)
        || (tag.name === 'link' && attribute.name === 'href')
        || isActiveEmbeddedNavigationAttribute(tag.name, attribute.name);

      if (attribute.name === 'srcset' && resourceAttributes.includes('srcset')) {
        const external = parseHtmlSrcset(value, htmlFile).find(
          (candidate) => !isEmbeddedOrFragmentReference(candidate.reference),
        );

        if (external !== undefined) {
          throw new Error(
            `Offline playtest requires self-contained HTML assets: ${htmlFile} references ${external.reference}`,
          );
        }
      } else if (
        isResourceReference
        && value.trim().length > 0
        && !isEmbeddedOrFragmentReference(value)
      ) {
        throw new Error(
          `Offline playtest requires self-contained HTML assets: ${htmlFile} references ${value}`,
        );
      }
    }
  }

  for (const match of source.matchAll(createHtmlRawTextPattern())) {
    if (match[1]?.toLowerCase() !== 'style') {
      continue;
    }

    const reference = findExternalCssReference(match[3] ?? '');

    if (reference !== undefined) {
      throw new Error(
        `Offline playtest requires self-contained HTML assets: ${htmlFile} references ${reference}`,
      );
    }
  }
}

function isActiveEmbeddedNavigationAttribute(
  tagName: string,
  attributeName: string,
): boolean {
  const localName = tagName.split(':').at(-1) ?? tagName;

  return (
    ((localName === 'a' || localName === 'area' || localName === 'base')
      && (attributeName === 'href' || attributeName === 'xlink:href'))
    || (localName === 'form' && attributeName === 'action')
    || ((localName === 'button' || localName === 'input') && attributeName === 'formaction')
  );
}

function isEmbeddedOrFragmentReference(reference: string): boolean {
  const normalized = normalizeUrlReference(reference);
  return isDataUrlReference(normalized) || normalized.startsWith('#');
}

function assertSelfContainedSvg(svgFile: string, source: string): void {
  const unsafeMarkup = findUnsafeXmlMarkup(source);

  if (unsafeMarkup !== undefined) {
    throw new Error(
      `Offline playtest requires inert self-contained SVG assets: ${svgFile} contains ${unsafeMarkup}`,
    );
  }

  const activeContent = findActiveSvgContent(source);

  if (activeContent !== undefined) {
    throw new Error(
      `Offline playtest does not support active SVG content: ${svgFile} contains ${activeContent}`,
    );
  }

  const externalReference = findExternalSvgReference(source);

  if (externalReference !== undefined) {
    throw new Error(
      `Offline playtest requires self-contained SVG data URIs and fragment references: ${svgFile} references ${externalReference}`,
    );
  }
}

function findActiveSvgContent(source: string): string | undefined {
  for (const tag of findHtmlTagTokens(source)) {
    const localName = tag.name.split(':').at(-1) ?? tag.name;

    if (
      !tag.closing
      && ['animate', 'animatemotion', 'animatetransform', 'set'].includes(localName)
    ) {
      return `<${tag.name}>`;
    }

    if (!tag.closing && (tag.name === 'script' || tag.name.endsWith(':script'))) {
      return '<script>';
    }

    if (!tag.closing && (tag.name === 'iframe' || tag.name.endsWith(':iframe'))) {
      return '<iframe>';
    }

    const eventHandler = tag.attributes.find(
      (attribute) => attribute.name.length > 2 && attribute.name.startsWith('on'),
    );

    if (eventHandler !== undefined) {
      return eventHandler.name;
    }
  }

  return undefined;
}

function findExternalSvgReference(source: string): string | undefined {
  const tagPattern = /<[a-z][\w:-]*(?=[\s>"'\/])(?:"[^"]*"|'[^']*'|[^'">])*>/giu;

  for (const match of source.matchAll(tagPattern)) {
    const attributes = tokenizeHtmlAttributes(match[0]);
    const tagName = /^<([a-z][\w:-]*)/iu.exec(match[0])?.[1]?.toLowerCase() ?? '';

    for (const attribute of attributes) {
      if (attribute.value === undefined) {
        continue;
      }

      const decodedValue = decodeHtmlCharacterReferences(attribute.value);
      const functionalReference = (
        attribute.name === 'style'
        || svgFunctionalUrlAttributeNames.has(attribute.name)
      )
        ? findExternalCssReference(decodedValue)
        : undefined;

      if (functionalReference !== undefined) {
        return functionalReference;
      }

      if (attribute.name === 'srcset') {
        const external = parseHtmlSrcset(decodedValue, 'embedded SVG asset').find(
          (candidate) => !isEmbeddedOrFragmentReference(candidate.reference),
        );

        if (external !== undefined) {
          return external.reference;
        }

        continue;
      }

      if (!svgResourceAttributeNames.has(attribute.name)) {
        continue;
      }

      const reference = normalizeUrlReference(decodedValue);

      if (
        isActiveEmbeddedNavigationAttribute(tagName, attribute.name)
        && (isDataUrlReference(reference) || isJavaScriptUrlReference(reference))
      ) {
        return reference;
      }

      if (!isDataUrlReference(reference) && !reference.startsWith('#')) {
        return reference;
      }
    }

  }

  for (const style of findHtmlRawTextElements(source, 'style')) {
    const reference = findExternalCssReference(style[3] ?? '');

    if (reference !== undefined) {
      return reference;
    }
  }

  return undefined;
}

function findExternalCssReference(source: string): string | undefined {
  if (containsCssImportRule(source)) {
    return '@import';
  }

  for (const token of findCssUrlTokens(source)) {
    if (!isDataUrlReference(token.reference) && !token.reference.startsWith('#')) {
      return token.reference;
    }
  }

  return findExternalCssImageSetStringReference(source);
}

function findExternalCssImageSetStringReference(source: string): string | undefined {
  for (const token of findCssImageSetFunctionTokens(source)) {
    for (const option of splitCssImageSetOptions(
      source.slice(token.openingParenthesis + 1, token.closingParenthesis),
    )) {
      const reference = findCssImageSetStringToken(option)?.reference;

      if (reference !== undefined && !isEmbeddedOrFragmentReference(reference)) {
        return reference;
      }
    }
  }

  return undefined;
}

function findCssUrlTokens(source: string): readonly CssUrlToken[] {
  const cssIdentifierCharacter = String.raw`(?:[a-z]|\\(?:[\dA-Fa-f]{1,6}[\t\n\f\r ]?|[^\n\f\r]))`;
  const pattern = new RegExp(`(?<![-\\w])((?:${cssIdentifierCharacter}){3})\\s*\\(`, 'giu');
  const codePositions = createCodePositionMap(source, false);
  const tokens: CssUrlToken[] = [];
  let match = pattern.exec(source);

  while (match !== null) {
    if (
      codePositions[match.index] !== 1
      || decodeCssEscapes(match[1] ?? '').toLowerCase() !== 'url'
    ) {
      match = pattern.exec(source);
      continue;
    }

    const openingParenthesis = source.indexOf('(', match.index);
    const closingParenthesis = findCssFunctionEnd(source, openingParenthesis);

    if (closingParenthesis === undefined) {
      match = pattern.exec(source);
      continue;
    }

    const rawValue = source.slice(openingParenthesis + 1, closingParenthesis);
    const value = removeCssCommentsOutsideStrings(rawValue).trim();
    const quote = value[0];
    let rawReference: string | undefined = value;

    if (quote === '"' || quote === "'") {
      rawReference = value.at(-1) === quote ? value.slice(1, -1) : undefined;
    }

    if (
      rawReference !== undefined
      && !isCssNamespaceUrl(source, match.index, codePositions)
    ) {
      tokens.push({
        start: match.index,
        end: closingParenthesis + 1,
        reference: normalizeUrlReference(decodeCssEscapes(rawReference)),
      });
    }

    pattern.lastIndex = closingParenthesis + 1;
    match = pattern.exec(source);
  }

  return tokens;
}

function removeCssCommentsOutsideStrings(source: string): string {
  let output = '';

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';

    if (character === '"' || character === "'") {
      const start = index;

      for (index += 1; index < source.length; index += 1) {
        if (source[index] === '\\') {
          index += 1;
        } else if (source[index] === character) {
          break;
        }
      }

      output += source.slice(start, Math.min(index + 1, source.length));
    } else if (character === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      index = commentEnd === -1 ? source.length : commentEnd + 1;
    } else {
      output += character;
    }
  }

  return output;
}

function isCssNamespaceUrl(
  source: string,
  urlStart: number,
  codePositions: Uint8Array,
): boolean {
  let statementStart = 0;

  for (let index = urlStart - 1; index >= 0; index -= 1) {
    if (codePositions[index] === 1 && /[;{}]/u.test(source[index] ?? '')) {
      statementStart = index + 1;
      break;
    }
  }

  const prelude = source
    .slice(statementStart, urlStart)
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .trim();

  if (prelude[0] !== '@') {
    return false;
  }

  const atKeyword = readCssIdentifier(prelude, 1);

  if (atKeyword?.value.toLowerCase() !== 'namespace') {
    return false;
  }

  const prefix = prelude.slice(atKeyword.end).trim();

  if (prefix.length === 0) {
    return true;
  }

  const prefixIdentifier = readCssIdentifier(prefix, 0);
  return prefixIdentifier?.end === prefix.length;
}

function assertSelfContainedGltf(gltfFile: string, source: string): void {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid glTF JSON in ${gltfFile}: ${errorMessage(error)}`);
  }

  assertNoExternalGltfUri(gltfFile, parsed);
}

function assertSelfContainedGlb(glbFile: string, source: Buffer): void {
  const glbMagic = 0x4654_6C67;
  const jsonChunkType = 0x4E4F_534A;
  const binaryChunkType = 0x004E_4942;

  if (
    source.length < 24
    || source.length % 4 !== 0
    || source.readUInt32LE(0) !== glbMagic
    || source.readUInt32LE(4) !== 2
    || source.readUInt32LE(8) !== source.length
  ) {
    throw new Error(`Invalid GLB container: ${glbFile}`);
  }

  let jsonSource: string | undefined;
  let binaryChunkSeen = false;
  let chunkIndex = 0;
  let offset = 12;

  while (offset + 8 <= source.length) {
    const chunkLength = source.readUInt32LE(offset);
    const chunkType = source.readUInt32LE(offset + 4);
    const chunkEnd = offset + 8 + chunkLength;

    if (chunkLength % 4 !== 0 || chunkEnd > source.length) {
      throw new Error(`Invalid GLB chunk length in ${glbFile}`);
    }

    if (chunkIndex === 0 && chunkType !== jsonChunkType) {
      throw new Error(`Invalid GLB first chunk in ${glbFile}`);
    }

    if (chunkType === jsonChunkType) {
      if (jsonSource !== undefined) {
        throw new Error(`Invalid GLB duplicate JSON chunk in ${glbFile}`);
      }

      jsonSource = source
        .subarray(offset + 8, chunkEnd)
        .toString('utf8')
        .replace(/[\x00\t\n\r ]+$/gu, '');
    } else if (chunkType === binaryChunkType) {
      if (binaryChunkSeen) {
        throw new Error(`Invalid GLB duplicate binary chunk in ${glbFile}`);
      }

      binaryChunkSeen = true;
    }

    offset = chunkEnd;
    chunkIndex += 1;
  }

  if (jsonSource === undefined || offset !== source.length) {
    throw new Error(`Invalid GLB JSON chunk in ${glbFile}`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonSource) as unknown;
  } catch (error) {
    throw new Error(`Invalid GLB JSON in ${glbFile}: ${errorMessage(error)}`);
  }

  assertNoExternalGltfUri(glbFile, parsed);
}

function assertNoExternalGltfUri(gltfFile: string, parsed: unknown): void {
  const externalUri = findExternalGltfUri(parsed);

  if (externalUri !== undefined) {
    throw new Error(
      `Offline playtest requires self-contained glTF data URIs or GLB: ${gltfFile} references ${externalUri}`,
    );
  }
}

function findExternalGltfUri(value: unknown): string | undefined {
  assertGltfNestingDepth(value);

  if (!isRecord(value)) {
    return undefined;
  }

  for (const collectionName of ['buffers', 'images']) {
    const collection = value[collectionName];

    if (!Array.isArray(collection)) {
      continue;
    }

    for (const resource of collection) {
      if (
        isRecord(resource)
        && typeof resource.uri === 'string'
        && !isDataUrlReference(resource.uri)
      ) {
        return resource.uri;
      }
    }
  }

  return undefined;
}

function assertGltfNestingDepth(value: unknown): void {
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [{ value, depth: 0 }];

  while (pending.length > 0) {
    const current = pending.pop();

    if (current === undefined) {
      break;
    }

    if (current.depth > 64) {
      throw new Error('Offline playtest glTF JSON exceeds the maximum nesting depth.');
    }

    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    } else if (isRecord(current.value)) {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function resolveLocalReference(artifactRoot: string, baseDir: string, reference: string): string {
  const normalizedReference = normalizeUrlReference(reference);

  if (isNonLocalReference(normalizedReference)) {
    throw new Error(`Offline playtest cannot inline external URL: ${normalizedReference}`);
  }

  const candidate = resolveReferencePath(artifactRoot, baseDir, normalizedReference);
  return resolveArtifactFile(artifactRoot, candidate);
}

function resolveReferencePath(artifactRoot: string, baseDir: string, reference: string): string {
  const cleanReference = normalizeUrlReference(reference).split(/[?#]/u, 1)[0] ?? '';

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
  const value = normalizeUrlReference(reference);
  return value.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(value);
}

function isDataUrlReference(reference: string): boolean {
  return /^data:/iu.test(normalizeUrlReference(reference));
}

function isJavaScriptUrlReference(reference: string): boolean {
  const normalized = normalizeUrlReference(reference);
  const schemeEnd = normalized.indexOf(':');

  return schemeEnd >= 0
    && normalized.slice(0, schemeEnd).replace(/[\t\n\f\r ]/gu, '').toLowerCase() === 'javascript';
}

function normalizeUrlReference(reference: string): string {
  return reference.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, '');
}

function readHtmlAttribute(attributes: string, name: string): string | undefined {
  return readHtmlAttributeToken(tokenizeHtmlAttributes(attributes), name);
}

function readHtmlAttributeToken(
  attributes: readonly HtmlAttributeToken[],
  name: string,
): string | undefined {
  const token = attributes.find((attribute) => attribute.name === name.toLowerCase());
  return token?.value === undefined ? undefined : decodeHtmlCharacterReferences(token.value);
}

function hasHtmlAttributeToken(
  attributes: readonly HtmlAttributeToken[],
  name: string,
): boolean {
  return attributes.some((attribute) => attribute.name === name.toLowerCase());
}

function tokenizeHtmlAttributes(source: string): readonly HtmlAttributeToken[] {
  const attributes: HtmlAttributeToken[] = [];
  let index = 0;

  if (source[index] === '<') {
    index += 1;

    if (source[index] === '/') {
      index += 1;
    }

    while (
      index < source.length
      && !isHtmlSpace(source[index])
      && source[index] !== '>'
      && source[index] !== '/'
    ) {
      index += 1;
    }
  }

  while (index < source.length) {
    while (isHtmlSpace(source[index])) {
      index += 1;
    }

    if (index >= source.length || source[index] === '>') {
      break;
    }

    if (source[index] === '/' || source[index] === '<') {
      index += 1;
      continue;
    }

    const nameStart = index;

    while (
      index < source.length
      && !isHtmlSpace(source[index])
      && !htmlAttributeNameTerminators.has(source[index] ?? '')
    ) {
      index += 1;
    }

    if (index === nameStart) {
      index += 1;
      continue;
    }

    const name = source.slice(nameStart, index).toLowerCase();

    while (isHtmlSpace(source[index])) {
      index += 1;
    }

    if (source[index] !== '=') {
      attributes.push({ name });
      continue;
    }

    index += 1;

    while (isHtmlSpace(source[index])) {
      index += 1;
    }

    const rawValueStart = index;
    const quote = source[index];
    let value: string;

    if (quote === '"' || quote === "'") {
      index += 1;
      const valueStart = index;

      while (index < source.length && source[index] !== quote) {
        index += 1;
      }

      value = source.slice(valueStart, index);

      if (source[index] === quote) {
        index += 1;
      }
    } else {
      const valueStart = index;

      while (index < source.length && !isHtmlSpace(source[index]) && source[index] !== '>') {
        index += 1;
      }

      value = source.slice(valueStart, index);
    }

    attributes.push({ name, value, rawValueStart, rawValueEnd: index });
  }

  return attributes;
}

function decodeHtmlCharacterReferences(value: string): string {
  return decodeHTMLAttribute(value);
}

function safeCodePoint(value: number): string {
  return !Number.isInteger(value)
    || value <= 0
    || value > 0x10_FFFF
    || (value >= 0xD800 && value <= 0xDFFF)
    ? '\uFFFD'
    : String.fromCodePoint(value);
}

function replaceHtmlAttribute(
  tag: string,
  name: string,
  value: string,
  attributes: readonly HtmlAttributeToken[] = tokenizeHtmlAttributes(tag),
): string {
  const attribute = attributes.find((token) => token.name === name.toLowerCase());

  if (attribute?.rawValueStart === undefined || attribute.rawValueEnd === undefined) {
    return tag;
  }

  return `${tag.slice(0, attribute.rawValueStart)}"${escapeHtmlAttribute(value)}"${tag.slice(attribute.rawValueEnd)}`;
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
