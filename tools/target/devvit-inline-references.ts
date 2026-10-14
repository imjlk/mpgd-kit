import { parse as parseJavaScript } from 'acorn';
import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5';
import { parse as parseCss } from 'postcss';
import valueParser from 'postcss-value-parser';

export interface InlineReference {
  readonly url: string;
  readonly dynamic: boolean;
  readonly scriptKind?: 'script' | 'module';
}

/** Parse executable syntax so tutorial strings and comments cannot create edges. */
export function scriptReferences(content: string, sourceType: 'script' | 'module' = 'module'): readonly InlineReference[] {
  const references: InlineReference[] = [];
  const pending: unknown[] = [
    parseJavaScript(content, { ecmaVersion: 'latest', sourceType, allowHashBang: true }),
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
        references.push({
          url: source.value,
          dynamic: node.type === 'ImportExpression',
          scriptKind: 'module',
        });
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
  const collect = (value: string, isImport = false): void => {
    const parsed = valueParser(value);
    const first = parsed.nodes.find((node) => node.type !== 'space' && node.type !== 'comment');
    if (isImport && first?.type === 'string') {
      references.push({ url: first.value, dynamic: false });
    }
    parsed.walk((node) => {
      if (node.type === 'function' && node.value.toLowerCase() === 'url') {
        const url = node.nodes.find((part) => part.type === 'string' || part.type === 'word');
        if (url !== undefined) {
          references.push({ url: url.value, dynamic: false });
        }
        return false;
      }
      return undefined;
    });
  };
  const stylesheet = parseCss(content);
  stylesheet.walkDecls((declaration) => collect(declaration.value));
  stylesheet.walkAtRules((rule) => {
    if (rule.name.toLowerCase() === 'import') {
      collect(rule.params, true);
    }
  });
  return references;
}

/** Parse HTML attributes, entities and raw-text elements with browser syntax. */
export function htmlReferences(content: string): readonly InlineReference[] {
  const references: InlineReference[] = [];
  const pending: DefaultTreeAdapterTypes.Node[] = [parseHtml(content)];
  const add = (url: string | undefined, scriptKind?: 'script' | 'module'): void => {
    if (url !== undefined) {
      references.push({ url, dynamic: false, ...(scriptKind === undefined ? {} : { scriptKind }) });
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
      const language = attrs.get('language') ?? '';
      const type = (attrs.get('type') ?? (language === '' ? '' : `text/${language}`)).trim().toLowerCase();
      const kind = type === 'module'
        ? 'module'
        : type === '' || javascriptMimeTypes.has(type)
          ? 'script'
          : undefined;
      if (kind !== undefined) {
        add(attrs.get('src'), kind);
        if (!attrs.has('src')) {
          references.push(...scriptReferences(textContent(node), kind));
        }
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

// https://mimesniff.spec.whatwg.org/#javascript-mime-type
const javascriptMimeTypes = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
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
  'text/x-ecmascript',
  'text/x-javascript',
]);

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
