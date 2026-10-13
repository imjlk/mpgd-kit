import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(process.argv[2], 'utf8');
const script = source.match(/Bootstrap = """\s*([\s\S]*?)\s*""";/)?.[1];
assert.ok(script, 'Missing actual shipped bootstrap');
function documentTransport() {
  const messages = [];
  const context = { crypto: webcrypto, chrome: { webview: { postMessage: value => messages.push(value) } } };
  runInNewContext(script, context);
  return { context, messages };
}
const oldPage = documentTransport();
const newPage = documentTransport();
const request = { protocol: 'mpgd.microsoft-store.native.v1', requestId: 'startup', method: 'identity.signIn', payload: {} };
oldPage.context.chrome.webview.postMessage(request);
newPage.context.chrome.webview.postMessage(request);
assert.equal(oldPage.messages[0].request, request);
assert.match(oldPage.messages[0].documentNonce, /^[a-f0-9]{32}$/);
assert.notEqual(oldPage.messages[0].documentNonce, newPage.messages[0].documentNonce);
const other = { protocol: 'other-message', payload: 1 };
newPage.context.chrome.webview.postMessage(other);
assert.equal(newPage.messages[1], other);
assert.equal(Object.getOwnPropertyDescriptor(newPage.context, '__mpgdMicrosoftStoreDocumentNonce').writable, false);
console.log('Actual shipped document bootstrap: 5 checks passed');
