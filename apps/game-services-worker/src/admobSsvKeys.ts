const googleAdMobSsvKeyFeed = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const maximumKeyFeedBytes = 65_536;
const keyFeedCacheMs = 300_000;
let cachedKeyFeed: { readonly expiresAt: number; readonly keys: ReadonlyMap<string, string> }
  | undefined;
let pendingKeyFeed: Promise<ReadonlyMap<string, string>> | undefined;

/** Fetch the current Google key for callback intake; claim replay uses the stored SPKI. */
export async function fetchAdMobSsvPublicKeySpki(
  keyId: string,
  options: { readonly fetcher?: typeof fetch; readonly signal?: AbortSignal } = {},
): Promise<string | undefined> {
  if (!/^[0-9]+$/u.test(keyId)) {
    return undefined;
  }
  // Public Google keys are safe to share between requests. Injected fetchers bypass
  // the isolate cache so conformance tests can model key rotation deterministically.
  const keys = options.fetcher === undefined
    ? await getDefaultKeyFeed()
    : await loadKeyFeed(options.fetcher, options.signal);
  return keys.get(keyId);
}

function getDefaultKeyFeed(): Promise<ReadonlyMap<string, string>> {
  if (cachedKeyFeed !== undefined && cachedKeyFeed.expiresAt > Date.now()) {
    return Promise.resolve(cachedKeyFeed.keys);
  }
  if (pendingKeyFeed !== undefined) {
    return pendingKeyFeed;
  }
  const refresh = loadKeyFeed(fetch).then((keys) => {
    cachedKeyFeed = { keys, expiresAt: Date.now() + keyFeedCacheMs };
    return keys;
  });
  pendingKeyFeed = refresh;
  const clearPending = (): void => {
    if (pendingKeyFeed === refresh) {
      pendingKeyFeed = undefined;
    }
  };
  void refresh.then(clearPending, clearPending);
  return refresh;
}

async function loadKeyFeed(
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const response = await fetcher(googleAdMobSsvKeyFeed, {
    method: 'GET',
    redirect: 'error',
    signal: signal === undefined
      ? AbortSignal.timeout(5_000)
      : AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  if (!response.ok) {
    throw new Error(`AdMob SSV key feed returned HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumKeyFeedBytes) {
    throw new Error('AdMob SSV key feed exceeds the size limit.');
  }
  const content = await readBoundedKeyFeed(response);
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed) || !Array.isArray(parsed.keys)) {
    throw new Error('AdMob SSV key feed has an invalid shape.');
  }
  const keys = new Map<string, string>();
  for (const candidate of parsed.keys as unknown[]) {
    if (!isRecord(candidate)) {
      throw new Error('AdMob SSV key feed contains an invalid entry.');
    }
    const candidateId = String(candidate.keyId);
    if (!/^[0-9]+$/u.test(candidateId)
      || typeof candidate.base64 !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(candidate.base64)) {
      throw new Error('AdMob SSV key feed contains an invalid public key.');
    }
    if (keys.has(candidateId)) {
      throw new Error('AdMob SSV key feed contains a duplicate key ID.');
    }
    keys.set(candidateId, candidate.base64);
  }
  return keys;
}

async function readBoundedKeyFeed(response: Response): Promise<string> {
  if (response.body === null) {
    throw new Error('AdMob SSV key feed has no body.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      length += next.value.byteLength;
      if (length > maximumKeyFeedBytes) {
        throw new Error('AdMob SSV key feed exceeds the size limit.');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
