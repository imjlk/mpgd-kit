import { parse as parseJavaScript } from 'acorn';
import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5';

export interface InlineReference {
  readonly url: string;
  readonly dynamic: boolean;
}

/** Parse executable syntax so tutorial strings and comments cannot create edges. */
export function scriptReferences(content: string): readonly InlineReference[] {
  const references: InlineReference[] = [];
  const pending: unknown[] = [
    parseJavaScript(content, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }),
  ];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object') {
      continue;
    }
    const node = value as Record<string, unknown>;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(
      String(node.type),
    )) {
      const source = node.source as { readonly type?: string; readonly value?: unknown } | null | undefined;
      if (source?.type === 'Literal' && typeof source.value === 'string') {
        references.push({ url: source.value, dynamic: node.type === 'ImportExpression' });
      }
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        pending.push(...child);
      } else if (child !== null && typeof child === 'object') {
        pending.push(child);
      }
    }
  }
  return references;
}

export function styleReferences(content: string): readonly InlineReference[] {
  const references: InlineReference[] = [];
  for (const pattern of [
    /@import\s+(?:url\(\s*["']?([^\s"')]+)["']?\s*\)|["']([^"']+)["'])/giu,
    /url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/giu,
  ]) {
    for (const match of content.matchAll(pattern)) {
      const url = match[1] ?? match[2] ?? match[3];
      if (url !== undefined) {
        references.push({ url, dynamic: false });
      }
    }
  }
  return references;
}

/** Parse HTML attributes, entities and raw-text elements with browser syntax. */
export function htmlReferences(content: string): readonly InlineReference[] {
  const references: InlineReference[] = [];
  const pending: DefaultTreeAdapterTypes.Node[] = [parseHtml(content)];
  const add = (url: string | undefined): void => {
    if (url !== undefined) {
      references.push({ url, dynamic: false });
    }
  };
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) {
      continue;
    }
    if ('childNodes' in node) {
      pending.push(...node.childNodes);
    }
    if (!('tagName' in node)) {
      continue;
    }
    const attrs = new Map(node.attrs.map(({ name, value }) => [name, value]));
    const tag = node.tagName;
    if (tag === 'base' && attrs.has('href')) {
      throw new Error(
        'Devvit inline entries with a base href are unsupported; emit artifact-relative URLs.',
      );
    }
    if (tag === 'script') {
      add(attrs.get('src'));
      const type = (attrs.get('type') ?? '').trim().toLowerCase();
      if (!attrs.has('src') && ['', 'module', 'text/javascript', 'application/javascript'].includes(type)) {
        references.push(...scriptReferences(textContent(node)));
      }
    } else if (tag === 'link') {
      const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/u);
      if (rel.some((value) => ['stylesheet', 'preload', 'modulepreload'].includes(value))) {
        add(attrs.get('href'));
        for (const url of srcsetReferences(attrs.get('imagesrcset') ?? '')) {
          add(url);
        }
      }
    } else if (['img', 'audio', 'video', 'source', 'track', 'input', 'embed', 'object'].includes(
      tag,
    )) {
      for (const attribute of ['src', 'poster', 'data']) {
        add(attrs.get(attribute));
      }
      for (const url of srcsetReferences(attrs.get('srcset') ?? '')) {
        add(url);
      }
    }
    if (tag === 'style') {
      references.push(...styleReferences(textContent(node)));
    }
    references.push(...styleReferences(attrs.get('style') ?? ''));
  }
  return references;
}

function textContent(node: DefaultTreeAdapterTypes.Element): string {
  return node.childNodes.map((child) => child.nodeName === '#text' && 'value' in child ? child.value : '').join(
    '',
  );
}

/** Charge all responsive candidates; data URL commas are part of the URL token. */
function srcsetReferences(input: string): readonly string[] {
  const references: string[] = [];
  const whitespace = /[\t\n\f\r ]/u;
  let position = 0;
  while (position < input.length) {
    while (position < input.length && (whitespace.test(input.charAt(position)) || input[position] === ',')) {
      position += 1;
    }
    const start = position;
    while (position < input.length && !whitespace.test(input.charAt(position))) {
      position += 1;
    }
    const url = input.slice(start, position);
    if (url.length === 0) {
      break;
    }
    references.push(url.replace(/,+$/u, ''));
    if (url.endsWith(',')) {
      continue;
    }
    let inParens = false;
    while (position < input.length) {
      const character = input[position++];
      if (character === '(') {
        inParens = true;
      } else if (character === ')') {
        inParens = false;
      } else if (character === ',' && !inParens) {
        break;
      }
    }
  }
  return references;
}
