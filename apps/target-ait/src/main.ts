import './styles.css';
import { installAitBridge, type InstallAitBridgeOptions } from './aitBridge';

const gameBundleBasePath = '/game/';
const gameBundleIndexPath = `${gameBundleBasePath}index.html`;
const gameAssetAttribute = 'data-mpgd-ait-game-asset';
const resourceLoadTimeoutMs = 15_000;
const safeScriptAttributes = new Set([
  'crossorigin',
  'integrity',
  'nomodule',
  'nonce',
  'referrerpolicy',
  'type',
]);

installAitBridge(identityBridgeOptions());

const app = document.querySelector<HTMLDivElement>('#app');

if (app !== null) {
  void loadGameBundle(app);
}

function identityBridgeOptions(): InstallAitBridgeOptions {
  if (import.meta.env.VITE_MPGD_AIT_MOCK_IDENTITY !== '1') {
    return {};
  }

  return {
    getUserKeyForGame: async () => ({
      type: 'HASH',
      hash: 'ait-local-player',
    }),
  };
}

async function loadGameBundle(app: HTMLDivElement): Promise<void> {
  try {
    const bundleDocument = await fetchGameBundleDocument();
    const gameMount = bundleDocument.querySelector('#game');

    if (gameMount === null) {
      throw new Error('Game bundle mount element was not found.');
    }

    const scripts = Array.from(bundleDocument.querySelectorAll<HTMLScriptElement>('script'));

    if (scripts.length === 0) {
      throw new Error('Game bundle script was not found.');
    }

    const links = Array.from(bundleDocument.querySelectorAll<HTMLLinkElement>('link[href]'));
    await Promise.all(links.map((link) => appendBundleLink(link)));

    document.title = bundleDocument.title || document.title;
    app.replaceChildren(createGameMount(gameMount));

    await appendBundleScripts(scripts);
  } catch (error) {
    // Already-executed scripts cannot be un-run; this only removes injected DOM nodes.
    removeInjectedGameAssets();
    renderMissingBundleShell(app, error);
  }
}

async function fetchGameBundleDocument(): Promise<Document> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => {
    controller.abort();
  }, resourceLoadTimeoutMs);

  try {
    const response = await fetch(gameBundleIndexPath, {
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Game bundle request failed with ${response.status}.`);
    }

    const contentType = response.headers.get('Content-Type') ?? '';

    if (contentType.length > 0 && !contentType.includes('text/html')) {
      throw new Error(`Game bundle returned unexpected Content-Type: ${contentType}.`);
    }

    const html = await response.text();
    return new DOMParser().parseFromString(html, 'text/html');
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out loading ${gameBundleIndexPath}.`);
    }

    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function appendBundleLink(source: HTMLLinkElement): Promise<void> {
  const rel = source.getAttribute('rel');

  if (rel !== 'stylesheet' && rel !== 'modulepreload') {
    return;
  }

  const href = source.getAttribute('href');

  if (href === null) {
    return;
  }

  const rewrittenHref = rewriteGameBundleUrl(href);

  if (hasMarkedElement('link', rewrittenHref)) {
    return;
  }

  const link = document.createElement('link');
  link.setAttribute(gameAssetAttribute, 'true');
  copyAttribute(source, link, 'as');
  copyAttribute(source, link, 'crossorigin');
  copyAttribute(source, link, 'integrity');
  copyAttribute(source, link, 'media');
  copyAttribute(source, link, 'nonce');
  copyAttribute(source, link, 'referrerpolicy');
  link.rel = rel;
  link.setAttribute('href', rewrittenHref);
  document.head.appendChild(link);

  if (rel === 'stylesheet') {
    await waitForElementLoad(link, rewrittenHref);
  }
}

async function appendBundleScripts(scripts: readonly HTMLScriptElement[]): Promise<void> {
  const runtimeErrorTrap = createRuntimeErrorTrap();

  try {
    for (const script of scripts) {
      await Promise.race([appendBundleScript(script), runtimeErrorTrap.promise]);
      await waitForNextMacrotask();
      runtimeErrorTrap.throwIfCaught();
    }
  } finally {
    runtimeErrorTrap.dispose();
  }
}

async function appendBundleScript(source: HTMLScriptElement): Promise<void> {
  const src = source.getAttribute('src');

  if (src === null) {
    throw new Error('Inline scripts are not supported in AIT wrapper game bundles.');
  }

  const rewrittenSrc = rewriteGameBundleUrl(src);

  if (hasMarkedElement('script', rewrittenSrc)) {
    return;
  }

  const script = document.createElement('script');
  script.setAttribute(gameAssetAttribute, 'true');
  copyScriptAttributes(source, script);
  script.async = false;
  script.setAttribute('src', rewrittenSrc);
  const loadPromise = waitForElementLoad(script, rewrittenSrc);
  document.body.appendChild(script);
  await loadPromise;
}

function rewriteGameBundleUrl(url: string): string {
  const trimmedUrl = url.trim();

  if (trimmedUrl.length === 0) {
    throw new Error('Game bundle asset URL must not be empty.');
  }

  if (trimmedUrl.startsWith('//')) {
    throw new Error('Protocol-relative game bundle asset URLs are not supported.');
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmedUrl)) {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(trimmedUrl);
    } catch {
      throw new Error(`Invalid game bundle asset URL: ${trimmedUrl}`);
    }

    if (
      (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') ||
      parsedUrl.origin !== window.location.origin
    ) {
      throw new Error(`External game bundle asset URL is not supported: ${parsedUrl.protocol}`);
    }

    return rewriteGameBundleUrl(`${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`);
  }

  return rewriteAndValidateGamePath(trimmedUrl, trimmedUrl);
}

function rewriteAndValidateGamePath(path: string, originalUrl: string): string {
  rejectEncodedTraversal(path, originalUrl);

  const normalizedPath = path.startsWith('/') && !path.startsWith(gameBundleBasePath)
    ? path.slice(1)
    : path;
  const resolvedUrl = new URL(normalizedPath, `${window.location.origin}${gameBundleBasePath}`);

  if (resolvedUrl.origin !== window.location.origin || !resolvedUrl.pathname.startsWith(gameBundleBasePath)) {
    throw new Error(`Game bundle asset URL escapes the bundle base path: ${originalUrl}`);
  }

  return `${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}`;
}

function rejectEncodedTraversal(path: string, originalUrl: string): void {
  const rawPath = path.toLowerCase();

  if (
    rawPath.includes('%25') ||
    rawPath.includes('%2e') ||
    rawPath.includes('%2f') ||
    rawPath.includes('%5c')
  ) {
    throw new Error(`Game bundle asset URL contains encoded path traversal: ${originalUrl}`);
  }
}

function createGameMount(source: Element): HTMLElement {
  const tagName = source.tagName.toLowerCase() === 'main' ? 'main' : 'div';
  const mount = document.createElement(tagName);

  for (const attribute of source.attributes) {
    const attributeName = attribute.name.toLowerCase();

    if (
      attributeName === 'class' ||
      attributeName === 'role' ||
      attributeName.startsWith('aria-') ||
      attributeName.startsWith('data-')
    ) {
      mount.setAttribute(attribute.name, attribute.value);
    }
  }

  mount.id = 'game';
  return mount;
}

function copyAttribute(source: Element, target: Element, attributeName: string): void {
  const value = source.getAttribute(attributeName);

  if (value !== null) {
    target.setAttribute(attributeName, value);
  }
}

function copyScriptAttributes(source: HTMLScriptElement, target: HTMLScriptElement): void {
  for (const attribute of source.attributes) {
    if (safeScriptAttributes.has(attribute.name)) {
      target.setAttribute(attribute.name, attribute.value);
    }
  }
}

function hasMarkedElement(tagName: 'link' | 'script', url: string): boolean {
  const attributeName = tagName === 'link' ? 'href' : 'src';
  const elements = document.querySelectorAll<HTMLElement>(`${tagName}[${gameAssetAttribute}]`);

  return Array.from(elements).some((element) => element.getAttribute(attributeName) === url);
}

function removeInjectedGameAssets(): void {
  document.querySelectorAll(`[${gameAssetAttribute}]`).forEach((element) => element.remove());
}

interface RuntimeErrorTrap {
  readonly promise: Promise<never>;
  throwIfCaught(): void;
  dispose(): void;
}

function createRuntimeErrorTrap(): RuntimeErrorTrap {
  let caughtError: Error | null = null;
  let rejectPromise: (error: Error) => void = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
  });
  promise.catch(() => undefined);

  const catchError = (error: Error): void => {
    if (caughtError === null) {
      caughtError = error;
      rejectPromise(error);
    }
  };
  const onError = (event: ErrorEvent): void => {
    if (!isGameBundleRuntimeError(event)) {
      return;
    }

    catchError(event.error instanceof Error ? event.error : new Error(event.message));
  };

  window.addEventListener('error', onError);

  return {
    promise,
    throwIfCaught() {
      if (caughtError !== null) {
        throw caughtError;
      }
    },
    dispose() {
      window.removeEventListener('error', onError);
    },
  };
}

function isGameBundleRuntimeError(event: ErrorEvent): boolean {
  if (event.filename.length === 0) {
    return false;
  }

  try {
    const sourceUrl = new URL(event.filename, window.location.href);
    return sourceUrl.origin === window.location.origin && sourceUrl.pathname.startsWith(gameBundleBasePath);
  } catch {
    return false;
  }
}

async function waitForNextMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(() => resolve(), 0);
  });
}

async function waitForElementLoad(
  element: HTMLLinkElement | HTMLScriptElement,
  url: string,
  timeoutMs = resourceLoadTimeoutMs,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const controller = new AbortController();
    let timer = 0;
    const settle = (callback: () => void): void => {
      window.clearTimeout(timer);
      controller.abort();
      callback();
    };
    timer = window.setTimeout(() => {
      settle(() => reject(new Error(`Timed out loading ${url}.`)));
    }, timeoutMs);
    element.addEventListener('load', () => {
      settle(resolve);
    }, { once: true, signal: controller.signal });
    element.addEventListener('error', () => {
      settle(() => reject(new Error(`Failed to load ${url}.`)));
    }, {
      once: true,
      signal: controller.signal,
    });
  });
}

function renderMissingBundleShell(app: HTMLDivElement, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  const section = document.createElement('section');
  section.className = 'shell';

  const title = document.createElement('h1');
  title.textContent = 'MPGD AIT Target';

  const guide = document.createElement('p');
  guide.append('Bridge installed. Run ');
  const command = document.createElement('code');
  command.textContent = 'pnpm build:ait';
  guide.append(command, ' from a generated game to copy its bundle into ');
  const outputPath = document.createElement('code');
  outputPath.textContent = 'public/game';
  guide.append(outputPath, '.');

  const errorMessage = document.createElement('p');
  const errorCode = document.createElement('code');
  errorCode.textContent = detail;
  errorMessage.append(errorCode);

  section.append(title, guide, errorMessage);
  app.replaceChildren(section);
}
