import { createHash } from 'node:crypto';
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
  readonly assetDataUrls: Map<string, string>;
  readonly inlinedAssets: Set<string>;
  readonly maximumBytes: number;
  inlinedAssetBytes: number;
}

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

const effectiveTargetConfigFileName = 'mpgd-effective-target.json';
const offlineEntryPlaceholder = '<!-- MPGD_OFFLINE_PLAYTEST_ENTRY -->';
const offlinePlaytestOutputFiles = new Set(['README.txt', 'index.html', 'offline-playtest.json']);
const htmlAttributeNameTerminators = new Set(['"', "'", '=', '<', '>', '/']);
const nonEventHtmlAttributeNamesStartingWithOn = new Set(['ontology']);
const inlineEntryExcludedAttributeNames = new Set(['src']);
const svgResourceAttributeNames = new Set(['href', 'src', 'xlink:href']);
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
  'Dynamic imports, import maps, and HTML base elements are unsupported.',
  'Retained inline modules cannot import other modules, and script-driven navigation is unsupported.',
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
  return [...html.matchAll(createHtmlRawTextPattern())].filter(
    (match) => match[1]?.toLowerCase() === elementName,
  );
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
      pluginBuild.onLoad({ filter: /\.json$/ }, (args) => {
        const jsonFile = resolveArtifactFile(context.artifactRoot, args.path);
        const source = readFileSync(jsonFile, 'utf8');
        context.inlinedAssets.add(jsonFile);
        return {
          contents: inlineJsonAssetReferences(source, jsonFile, context),
          loader: 'json',
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

function inlineJsonAssetReferences(
  source: string,
  sourceFile: string,
  context: InliningContext,
): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON module ${sourceFile}: ${errorMessage(error)}`);
  }

  return JSON.stringify(transformJsonAssetReferences(parsed, sourceFile, context, 0));
}

function transformJsonAssetReferences(
  value: unknown,
  sourceFile: string,
  context: InliningContext,
  depth: number,
): unknown {
  if (depth > 64) {
    throw new Error(
      `Offline playtest JSON module exceeds the supported nesting depth: ${sourceFile}`,
    );
  }

  if (typeof value === 'string') {
    const assetFile = resolveExistingAssetReference(sourceFile, value, context.artifactRoot);
    return assetFile === undefined || isCodeAsset(assetFile)
      ? value
      : readAssetDataUrl(sourceFile, value, context);
  }

  if (Array.isArray(value)) {
    return value.map((item) => transformJsonAssetReferences(item, sourceFile, context, depth + 1));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        transformJsonAssetReferences(item, sourceFile, context, depth + 1),
      ]),
    );
  }

  return value;
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
    (match, quote: string, reference: string, hrefAccess: string | undefined, offset: number) => {
      if (sourceCodePositions[offset] !== 1) {
        return match;
      }

      if (quote === '`' && reference.includes('${')) {
        return match;
      }

      if (reference.startsWith('data:') || reference.startsWith('blob:')) {
        return hrefAccess === undefined
          ? `new URL(${JSON.stringify(reference)})`
          : JSON.stringify(reference);
      }

      const dataUrl = readAssetDataUrl(sourceFile, reference, context);
      return hrefAccess === undefined
        ? `new URL(${JSON.stringify(dataUrl)})`
        : JSON.stringify(dataUrl);
    },
  );
  const documentFile = path.join(context.artifactRoot, 'index.html');
  const staticFetchPattern = /((?<![$.\w])(?:(?:globalThis|self|window)\s*\.\s*)?fetch\s*\(\s*)(["'`])([^"'`\r\n]+)\2/gu;
  const fetchCodePositions = createCodePositionMap(output, true);
  output = output.replace(
    staticFetchPattern,
    (match, prefix: string, quote: string, reference: string, offset: number) => {
      if (fetchCodePositions[offset] !== 1 || (quote === '`' && reference.includes('${'))) {
        return match;
      }

      if (reference.startsWith('data:') || reference.startsWith('blob:')) {
        // These schemes are already self-contained or point at runtime-created in-memory data.
        return match;
      }

      if (isNonLocalReference(reference)) {
        throw new Error(`Offline playtest does not support network fetch URL: ${reference}`);
      }

      const dataUrl = escapeForQuote(readAssetDataUrl(documentFile, reference, context), quote);
      return `${prefix}${quote}${dataUrl}${quote}`;
    },
  );
  assertSupportedBundledRuntime(output);
  return output;
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
        return rel.has('modulepreload') ? '' : match;
      }

      if (href === undefined) {
        throw new Error('Stylesheet link is missing href.');
      }

      const stylesheetFile = resolveLocalReference(context.artifactRoot, path.dirname(htmlFile), href);
      const stylesheet = readFileSync(stylesheetFile, 'utf8');
      const inlined = inlineCssAssetReferences(stylesheet, stylesheetFile, context);
      context.inlinedAssets.add(stylesheetFile);
      const style = `<style${renderInlinedStylesheetAttributes(attributeTokens)}>${escapeClosingTag(inlined, 'style')}</style>`;
      return hasHtmlAttributeToken(attributeTokens, 'disabled')
        ? `${style}<script>document.currentScript.previousElementSibling.disabled=true</script>`
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
): string {
  if (containsCssImportRule(source)) {
    throw new Error(`Offline playtest does not support CSS @import rules: ${sourceFile}`);
  }

  const output = inlineCssImageSetStringReferences(source, sourceFile, context);
  const cssUrlPattern = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*?))\s*\)/giu;
  const codePositions = createCodePositionMap(output, false);
  return output.replace(cssUrlPattern, (match, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined, offset: number) => {
    if (codePositions[offset] !== 1) {
      return match;
    }

    const reference = decodeCssEscapes((doubleQuoted ?? singleQuoted ?? unquoted ?? '').trim());

    if (reference.startsWith('data:') || reference.startsWith('blob:') || reference.startsWith('#')) {
      return match;
    }

    return `url(${JSON.stringify(readAssetDataUrl(sourceFile, reference, context))})`;
  });
}

function inlineCssImageSetStringReferences(
  source: string,
  sourceFile: string,
  context: InliningContext,
): string {
  const pattern = /(?:-webkit-)?image-set\s*\(/giu;
  const codePositions = createCodePositionMap(source, false);
  let cursor = 0;
  let output = '';

  let match = pattern.exec(source);

  while (match !== null) {
    if (codePositions[match.index] !== 1) {
      match = pattern.exec(source);
      continue;
    }

    const openingParenthesis = source.indexOf('(', match.index);
    const closingParenthesis = findCssFunctionEnd(source, openingParenthesis);

    if (closingParenthesis === undefined) {
      match = pattern.exec(source);
      continue;
    }

    output += source.slice(cursor, openingParenthesis + 1);
    output += inlineCssImageSetOptions(
      source.slice(openingParenthesis + 1, closingParenthesis),
      sourceFile,
      context,
    );
    cursor = closingParenthesis;
    pattern.lastIndex = closingParenthesis + 1;
    match = pattern.exec(source);
  }

  return output + source.slice(cursor);
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

    if (character === '/' && nextCharacter === '*') {
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
  context: InliningContext,
): string {
  let cursor = 0;
  let depth = 0;
  let output = '';
  let quote: '"' | "'" | undefined;

  for (let index = 0; index <= source.length; index += 1) {
    const character = source[index];

    if (quote !== undefined) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }

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
      output += inlineCssImageSetOption(source.slice(cursor, index), sourceFile, context);

      if (character === ',') {
        output += ',';
      }

      cursor = index + 1;
    }
  }

  return output;
}

function inlineCssImageSetOption(
  source: string,
  sourceFile: string,
  context: InliningContext,
): string {
  const valueStart = source.search(/\S/u);

  if (valueStart === -1 || (source[valueStart] !== '"' && source[valueStart] !== "'")) {
    return source;
  }

  const quote = source[valueStart];
  let valueEnd = valueStart + 1;

  while (valueEnd < source.length && source[valueEnd] !== quote) {
    valueEnd += source[valueEnd] === '\\' ? 2 : 1;
  }

  if (valueEnd >= source.length) {
    return source;
  }

  const reference = decodeCssEscapes(source.slice(valueStart + 1, valueEnd));

  if (reference.startsWith('data:') || reference.startsWith('blob:') || reference.startsWith('#')) {
    return source;
  }

  const dataUrl = readAssetDataUrl(sourceFile, reference, context);
  return `${source.slice(0, valueStart)}${JSON.stringify(dataUrl)}${source.slice(valueEnd + 1)}`;
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

  for (const match of findHtmlRawTextElements(html, 'style')) {
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
  const htmlWithInlineStyles = html.replace(/<[a-z][\w:-]*(?=[\s>"'\/])(?:"[^"]*"|'[^']*'|[^'">])*>/giu, (tag) => {
    const attributeTokens = tokenizeHtmlAttributes(tag);
    const style = readHtmlAttributeToken(attributeTokens, 'style');

    if (style === undefined) {
      return tag;
    }

    return replaceHtmlAttribute(
      tag,
      'style',
      inlineCssAssetReferences(style, htmlFile, context),
      attributeTokens,
    );
  });

  return htmlWithInlineStyles.replace(/<(link|audio|embed|feimage|image|img|input|object|source|track|use|video)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/giu, (tag, name: string, attributes: string) => {
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
  return /<!--[\s\S]*?-->|<(script|style|textarea|title)\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/\1\s*>/giu;
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

  const headPattern = /<head\b((?:"[^"]*"|'[^']*'|[^'">])*)>/iu;

  if (headPattern.test(output)) {
    output = output.replace(
      headPattern,
      `<head$1>\n<meta charset="utf-8">\n${banner}\n<meta name="mpgd-purpose" content="test-play-only">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n${guardScript}${bundledStyle}`,
    );
  } else {
    throw new Error('Offline playtest source index.html must contain a head element.');
  }

  if (
    !output.includes(offlineEntryPlaceholder)
    || output.indexOf(offlineEntryPlaceholder) !== output.lastIndexOf(offlineEntryPlaceholder)
  ) {
    throw new Error('Offline playtest could not preserve the module entry position.');
  }
  output = output.replace(offlineEntryPlaceholder, inlineScript);

  if (/<\/body>/iu.test(output)) {
    return `${output.trim()}\n`;
  }

  throw new Error('Offline playtest source index.html must contain a body element.');
}

function assertSupportedHtmlDocument(html: string): void {
  const containsImportMap = findHtmlScriptElements(html).some(
    (match) => readHtmlAttribute(match[2] ?? '', 'type')?.trim().toLowerCase() === 'importmap',
  );

  if (containsImportMap) {
    throw new Error('Offline playtest does not support HTML import maps.');
  }

  for (const match of html.matchAll(createHtmlRawTextPattern())) {
    if (match[1] !== undefined) {
      assertSupportedHtmlAttributes(match[1], tokenizeHtmlAttributes(match[2] ?? ''));
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

  if (lowerTagName !== 'a' && lowerTagName !== 'area') {
    return;
  }

  const href = readHtmlAttributeToken(attributes, 'href');

  if (href !== undefined && isNonLocalReference(href)) {
    throw new Error(`Offline playtest does not support external hyperlink navigation: ${href}`);
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
  return `(()=>{const allowed=(value)=>{const raw=typeof value==='string'?value:typeof URL!=='undefined'&&value instanceof URL?value.href:typeof Request!=='undefined'&&value instanceof Request?value.url:String(value);return raw.startsWith('data:')||raw.startsWith('blob:')};const denied=(api,value)=>new TypeError('[mpgd offline playtest] '+api+' blocked network access: '+String(value));const originalFetch=globalThis.fetch?.bind(globalThis);if(originalFetch){globalThis.fetch=(input,init)=>{if(!allowed(input))return Promise.reject(denied('fetch',input));return originalFetch(input,init)}}if(globalThis.XMLHttpRequest){const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){if(!allowed(url))throw denied('XMLHttpRequest',url);return open.call(this,method,url,...rest)}}if(globalThis.WebSocket){globalThis.WebSocket=class{constructor(url){throw denied('WebSocket',url)}}}if(globalThis.EventSource){globalThis.EventSource=class{constructor(url){throw denied('EventSource',url)}}}if(typeof navigator!=='undefined'&&navigator.sendBeacon){navigator.sendBeacon=()=>false}})();`;
}

function assertSupportedBundledRuntime(source: string): void {
  const unsupported = [
    {
      pattern: /\bnew\s+(?:(?:globalThis|self|window)\s*\.\s*)?(?:Shared)?Worker\s*\(/gu,
      label: 'Worker',
    },
    { pattern: /\bserviceWorker\s*\.\s*register\s*\(/gu, label: 'service worker registration' },
    { pattern: /\bWebAssembly\s*\.\s*instantiateStreaming\s*\(/gu, label: 'WebAssembly streaming' },
    { pattern: /\bnew\s+URL\([^;]*import\.meta/gu, label: 'runtime-computed import.meta asset URL' },
    { pattern: /\bimport\s*\(/gu, label: 'dynamic import' },
    {
      pattern: /\b(?:globalThis|parent|self|top|window)\s*\.\s*open\s*\(/gu,
      label: 'script-driven navigation',
    },
    {
      pattern: /(?:\b(?:document|globalThis|parent|self|top|window)\s*\.\s*|(?<![$.\w]))location\s*\.\s*(?:assign|replace)\s*\(/gu,
      label: 'script-driven navigation',
    },
    {
      pattern: /(?:\b(?:document|globalThis|parent|self|top|window)\s*\.\s*|(?<![$.\w]))location(?:\s*\.\s*href)?\s*(?:(?:&&|\?\?|\|\|)|[+\-*/%&|^])?=(?!=)/gu,
      label: 'script-driven navigation',
    },
  ];
  const codePositions = createCodePositionMap(source, true);
  const codeOnlySource = maskNonCode(source, codePositions);

  for (const candidate of unsupported) {
    if (candidate.pattern.test(codeOnlySource)) {
      candidate.pattern.lastIndex = 0;
      throw new Error(`Offline playtest does not support ${candidate.label}.`);
    }

    candidate.pattern.lastIndex = 0;
  }
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
    } else if (extension === '.svg') {
      assertSelfContainedSvg(assetFile, asset.toString('utf8'));
    }

    dataUrl = `data:${mimeType};base64,${asset.toString('base64')}`;
    context.assetDataUrls.set(assetFile, dataUrl);
  }

  context.inlinedAssetBytes = nextInlinedAssetBytes;
  context.inlinedAssets.add(assetFile);
  return `${dataUrl}${fragment}`;
}

function assertSelfContainedSvg(svgFile: string, source: string): void {
  const externalReference = findExternalSvgReference(source);

  if (externalReference !== undefined) {
    throw new Error(
      `Offline playtest requires self-contained SVG data URIs and fragment references: ${svgFile} references ${externalReference}`,
    );
  }
}

function findExternalSvgReference(source: string): string | undefined {
  const tagPattern = /<[a-z][\w:-]*(?=[\s>"'\/])(?:"[^"]*"|'[^']*'|[^'">])*>/giu;

  for (const match of source.matchAll(tagPattern)) {
    const attributes = tokenizeHtmlAttributes(match[0]);

    for (const attribute of attributes) {
      if (!svgResourceAttributeNames.has(attribute.name) || attribute.value === undefined) {
        continue;
      }

      const reference = normalizeUrlReference(decodeHtmlCharacterReferences(attribute.value));

      if (!reference.startsWith('data:') && !reference.startsWith('#')) {
        return reference;
      }
    }

    const inlineStyle = readHtmlAttributeToken(attributes, 'style');
    const styleReference = inlineStyle === undefined
      ? undefined
      : findExternalCssReference(inlineStyle);

    if (styleReference !== undefined) {
      return styleReference;
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

  const pattern = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*?))\s*\)/giu;

  for (const match of source.matchAll(pattern)) {
    const reference = normalizeUrlReference(
      decodeCssEscapes(match[1] ?? match[2] ?? match[3] ?? ''),
    );

    if (!reference.startsWith('data:') && !reference.startsWith('#')) {
      return reference;
    }
  }

  return undefined;
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
  const normalizedReference = normalizeUrlReference(reference);

  if (isNonLocalReference(normalizedReference) || normalizedReference.includes('${')) {
    return undefined;
  }

  try {
    const candidate = resolveReferencePath(
      artifactRoot,
      path.dirname(sourceFile),
      normalizedReference,
    );
    return existsSync(candidate) && lstatSync(candidate).isFile()
      ? resolveArtifactFile(artifactRoot, candidate)
      : undefined;
  } catch {
    return undefined;
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

function normalizeUrlReference(reference: string): string {
  return reference.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, '');
}

function isCodeAsset(file: string): boolean {
  return /\.(?:c|m)?js$/iu.test(file) || /\.css$/iu.test(file) || /\.html?$/iu.test(file);
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
