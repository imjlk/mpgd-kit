import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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
  readonly inlinedAssets: Set<string>;
}

interface BundledEntry {
  readonly script: string;
  readonly stylesheet?: string;
}

const effectiveTargetConfigFileName = 'mpgd-effective-target.json';
const offlinePlaytestLimitations = [
  'Server-backed identity, purchases, ads, rewards, leaderboards, and cloud saves are unavailable.',
  'Browser storage opened from file:// is browser-dependent and best-effort only.',
  'Workers, service workers, WebAssembly streaming, and runtime-computed asset URLs are unsupported.',
] as const;

const mimeTypes = new Map<string, string>([
  ['.aac', 'audio/aac'],
  ['.avif', 'image/avif'],
  ['.bin', 'application/octet-stream'],
  ['.csv', 'text/csv'],
  ['.eot', 'application/vnd.ms-fontobject'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.ogv', 'video/ogg'],
  ['.otf', 'font/otf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain'],
  ['.wav', 'audio/wav'],
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
  const identity = readEffectivePreviewIdentity(artifactRoot);
  const sourceIndexFile = resolveArtifactFile(artifactRoot, 'index.html');
  const sourceHtml = readFileSync(sourceIndexFile, 'utf8');
  const context: InliningContext = {
    artifactRoot,
    inlinedAssets: new Set<string>(),
  };
  const { html: htmlWithoutEntry, entryFile } = extractModuleEntry(sourceHtml, context);
  const bundledEntry = await bundleEntry(entryFile, context);
  const htmlWithStyles = inlineStylesheets(htmlWithoutEntry, sourceIndexFile, context);
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

  rmSync(outputDir, { recursive: true, force: true });
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
  const scriptPattern = /<script\b([^>]*)>\s*<\/script>/giu;
  const matches = [...html.matchAll(scriptPattern)];
  const externalScripts = matches.filter(
    (match) => readHtmlAttribute(match[1] ?? '', 'src') !== undefined,
  );
  const moduleEntries = externalScripts.filter(
    (match) => readHtmlAttribute(match[1] ?? '', 'type')?.toLowerCase() === 'module',
  );

  if (externalScripts.length !== 1 || moduleEntries.length !== 1) {
    throw new Error('Offline playtest requires exactly one external module entry script.');
  }

  const match = moduleEntries[0];
  const source = readHtmlAttribute(match?.[1] ?? '', 'src');

  if (match?.[0] === undefined || source === undefined || match.index === undefined) {
    throw new Error('Unable to resolve the module entry script.');
  }

  const entryFile = resolveLocalReference(context.artifactRoot, context.artifactRoot, source);
  const output = `${html.slice(0, match.index)}${html.slice(match.index + match[0].length)}`;

  return { html: output, entryFile };
}

async function bundleEntry(entryFile: string, context: InliningContext): Promise<BundledEntry> {
  const result = await build({
    entryPoints: [entryFile],
    absWorkingDir: context.artifactRoot,
    bundle: true,
    write: false,
    outfile: 'offline-playtest.js',
    format: 'iife',
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
  const staticUrlPattern = /new\s+URL\(\s*(["'`])([^"'`]+)\1\s*,\s*import\.meta\.url\s*\)(?:\.href)?/gu;
  let output = source.replace(staticUrlPattern, (_match, _quote: string, reference: string) =>
    JSON.stringify(readAssetDataUrl(sourceFile, reference, context)),
  );
  const literalPattern = /(["'`])([^"'`\r\n]+)\1/gu;
  output = output.replace(literalPattern, (match, quote: string, reference: string) => {
    const assetFile = resolveExistingAssetReference(sourceFile, reference, context.artifactRoot);

    if (assetFile === undefined || isCodeAsset(assetFile)) {
      return match;
    }

    return `${quote}${escapeForQuote(readAssetDataUrl(sourceFile, reference, context), quote)}${quote}`;
  });
  assertSupportedBundledRuntime(output);
  return output;
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
    context.inlinedAssets.add(stylesheetFile);
    return `<style>${escapeClosingTag(inlined, 'style')}</style>`;
  });
}

function inlineCssAssetReferences(
  source: string,
  sourceFile: string,
  context: InliningContext,
): string {
  return source.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/giu, (match, _quote: string, value: string) => {
    const reference = value.trim();

    if (reference.startsWith('data:') || reference.startsWith('blob:') || reference.startsWith('#')) {
      return match;
    }

    return `url(${JSON.stringify(readAssetDataUrl(sourceFile, reference, context))})`;
  });
}

function inlineHtmlAssets(
  html: string,
  htmlFile: string,
  context: InliningContext,
): string {
  return html.replace(/<(link|img|source|audio|video)\b([^>]*)>/giu, (tag, name: string, attributes: string) => {
    const lowerName = name.toLowerCase();
    const rel = readHtmlAttribute(attributes, 'rel')?.toLowerCase();
    const allowedAttributes = lowerName === 'video'
      ? ['src', 'poster']
      : lowerName === 'img' || lowerName === 'source'
        ? ['src', 'srcset']
        : ['src'];

    if (lowerName === 'link') {
      if (rel !== 'icon' && rel !== 'apple-touch-icon' && rel !== 'mask-icon') {
        return tag;
      }

      allowedAttributes.splice(0, allowedAttributes.length, 'href');
    }

    let output = tag;

    for (const attribute of allowedAttributes) {
      const reference = readHtmlAttribute(attributes, attribute);

      if (reference === undefined || reference.startsWith('data:') || reference.startsWith('blob:')) {
        continue;
      }

      const inlined = attribute === 'srcset'
        ? inlineHtmlSrcset(htmlFile, reference, context)
        : readAssetDataUrl(htmlFile, reference, context);
      output = replaceHtmlAttribute(output, attribute, inlined);
    }

    return output;
  });
}

function inlineHtmlSrcset(
  htmlFile: string,
  source: string,
  context: InliningContext,
): string {
  return source.split(',').map((candidate) => {
    const [reference, ...descriptors] = candidate.trim().split(/\s+/u);

    if (reference === undefined || reference.length === 0) {
      throw new Error(`Invalid empty srcset candidate in ${htmlFile}.`);
    }

    const dataUrl = readAssetDataUrl(htmlFile, reference, context);
    return [dataUrl, ...descriptors].join(' ');
  }).join(', ');
}

function assembleOfflineHtml(html: string, bundledEntry: BundledEntry): string {
  const csp = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src data: blob:; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'";
  const banner = '<!-- MPGD offline playtest: test-play-only, not a release target or store submission artifact. -->';
  const runtimeGuard = renderOfflineRuntimeGuard();
  const guardScript = `<script>${escapeClosingTag(runtimeGuard, 'script')}</script>`;
  const bundledStyle = bundledEntry.stylesheet === undefined
    ? ''
    : `\n<style>${escapeClosingTag(bundledEntry.stylesheet, 'style')}</style>`;
  const inlineScript = `<script>${escapeClosingTag(bundledEntry.script, 'script')}</script>`;
  let output = html.replace(/<link\b[^>]*\brel=["']manifest["'][^>]*>/giu, '');

  if (/<head\b[^>]*>/iu.test(output)) {
    output = output.replace(
      /<head\b([^>]*)>/iu,
      `<head$1>\n${banner}\n<meta name="mpgd-purpose" content="test-play-only">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n${guardScript}${bundledStyle}`,
    );
  } else {
    throw new Error('Offline playtest source index.html must contain a head element.');
  }

  if (/<\/body>/iu.test(output)) {
    return `${output.replace(/<\/body>/iu, `${inlineScript}\n</body>`).trim()}\n`;
  }

  throw new Error('Offline playtest source index.html must contain a body element.');
}

function renderOfflineRuntimeGuard(): string {
  return `(()=>{const allowed=(value)=>{const raw=typeof value==='string'?value:typeof URL!=='undefined'&&value instanceof URL?value.href:typeof Request!=='undefined'&&value instanceof Request?value.url:String(value);return raw.startsWith('data:')||raw.startsWith('blob:')};const denied=(api,value)=>new TypeError('[mpgd offline playtest] '+api+' blocked network access: '+String(value));const originalFetch=globalThis.fetch?.bind(globalThis);if(originalFetch){globalThis.fetch=(input,init)=>{if(!allowed(input))return Promise.reject(denied('fetch',input));return originalFetch(input,init)}}if(globalThis.XMLHttpRequest){const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){if(!allowed(url))throw denied('XMLHttpRequest',url);return open.call(this,method,url,...rest)}}if(globalThis.WebSocket){globalThis.WebSocket=class{constructor(url){throw denied('WebSocket',url)}}}if(globalThis.EventSource){globalThis.EventSource=class{constructor(url){throw denied('EventSource',url)}}}if(typeof navigator!=='undefined'&&navigator.sendBeacon){navigator.sendBeacon=()=>false}})();`;
}

function assertSupportedBundledRuntime(source: string): void {
  const unsupported = [
    { pattern: /\bnew\s+(?:Shared)?Worker\s*\(/u, label: 'Worker' },
    { pattern: /\bserviceWorker\s*\.\s*register\s*\(/u, label: 'service worker registration' },
    { pattern: /\bWebAssembly\s*\.\s*instantiateStreaming\s*\(/u, label: 'WebAssembly streaming' },
    { pattern: /\bnew\s+URL\([^)]*import\.meta/u, label: 'runtime-computed import.meta asset URL' },
  ];

  for (const candidate of unsupported) {
    if (candidate.pattern.test(source)) {
      throw new Error(`Offline playtest does not support ${candidate.label}.`);
    }
  }
}

function readAssetDataUrl(
  sourceFile: string,
  reference: string,
  context: InliningContext,
): string {
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

  context.inlinedAssets.add(assetFile);
  return `data:${mimeType};base64,${readFileSync(assetFile).toString('base64')}`;
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

  return cleanReference.startsWith('/')
    ? path.resolve(artifactRoot, `.${cleanReference}`)
    : path.resolve(baseDir, cleanReference);
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
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(["'])(.*?)\\1`, 'iu').exec(attributes);
  return match?.[2];
}

function replaceHtmlAttribute(tag: string, name: string, value: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`((?:^|\\s)${escapedName}\\s*=\\s*)(["'])(.*?)\\2`, 'iu');
  return tag.replace(pattern, `$1"${escapeHtmlAttribute(value)}"`);
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;');
}

function escapeForQuote(value: string, quote: string): string {
  return value.replace(/\\/gu, '\\\\').replace(new RegExp(quote, 'gu'), `\\${quote}`);
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
