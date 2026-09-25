import { DOMParser, type Element } from '@xmldom/xmldom';

/** Parse the bounded XML representation produced by plutil for profile preflight. */
export function parseIosProfilePlist(source: string): unknown {
  if (Buffer.byteLength(source) > 1024 * 1024) {
    throw new Error('iOS provisioning profile plist exceeds 1 MiB.');
  }
  const document = new DOMParser({
    onError: () => {
      throw new Error('iOS provisioning profile plist is malformed.');
    },
  }).parseFromString(source, 'application/xml');
  const root = document.documentElement;
  if (root === null || root.tagName !== 'plist') {
    throw new Error('iOS provisioning profile plist has no plist root.');
  }
  const children = elements(root);
  if (children.length !== 1) {
    throw new Error('iOS provisioning profile plist must contain one value.');
  }
  return parseValue(children[0] as Element);
}

function parseValue(element: Element): unknown {
  switch (element.tagName) {
    case 'dict': {
      const children = elements(element);
      if (children.length % 2 !== 0) {
        throw new Error('iOS provisioning profile plist dictionary is malformed.');
      }
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (let index = 0; index < children.length; index += 2) {
        const key = children[index] as Element;
        const value = children[index + 1] as Element;
        const name = (key.textContent ?? '').trim();
        if (key.tagName !== 'key' || name === '' || Object.hasOwn(result, name)) {
          throw new Error('iOS provisioning profile plist key is malformed or duplicated.');
        }
        result[name] = parseValue(value);
      }
      return result;
    }
    case 'array':
      return elements(element).map((child) => parseValue(child));
    case 'string':
    case 'date':
      return (element.textContent ?? '').trim();
    case 'data':
      return (element.textContent ?? '').replace(/\s+/gu, '');
    case 'true':
      return true;
    case 'false':
      return false;
    case 'integer': {
      const text = (element.textContent ?? '').trim();
      if (!/^-?\d+$/u.test(text)) {
        throw new Error('iOS provisioning profile plist integer is invalid.');
      }
      const value = Number(text);
      if (!Number.isSafeInteger(value)) {
        throw new Error('iOS provisioning profile plist integer is invalid.');
      }
      return value;
    }
    default:
      throw new Error(`Unsupported iOS provisioning profile plist value ${element.tagName}.`);
  }
}

function elements(parent: Element): Element[] {
  const result: Element[] = [];
  for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 1) {
      result.push(child as Element);
    }
  }
  return result;
}
