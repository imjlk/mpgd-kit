import type { ShareIntent, ShareResult } from './index.js';
import { rootRelativeRouteVectors, shareLinkVectors } from './route-vectors.js';

/** How a fixture observes what its host was handed. */
export interface ShareLinkConformanceHost {
  /**
   * What the host was handed for each share that reached it, oldest first:
   * the link, or `null` for a host that takes no link (a WeChat card).
   */
  readonly handedLinks: () => readonly (string | null)[];
  /**
   * What the host is handed for a link `normalizeShareLink` accepted: the
   * normalized route or absolute URL as the adapter maps it, or `null` for a
   * host that takes no link.
   */
  readonly expectedLink: (link: string) => string | null;
}

export interface ShareLinkConformanceFixture {
  /** Names the fixture in failures. */
  readonly name: string;
  /** The adapter's `share`, called as a game calls it. */
  readonly share: (intent: ShareIntent) => Promise<ShareResult>;
  /** The answer for a share the host presented. */
  readonly sharedResult: ShareResult;
  /**
   * Omit only for a host that cannot be observed, such as a sandbox bridge
   * that answers by itself; the runner then checks the answers alone.
   */
  readonly host?: ShareLinkConformanceHost;
}

export interface ShareLinkConformanceReport {
  readonly name: string;
  /** Intents answered `unavailable` without reaching the host. */
  readonly refused: number;
  /** Intents shared with the expected link. */
  readonly shared: number;
}

const baseIntent = { kind: 'invite', title: 'Join', text: 'Join me' } as const;

/**
 * Intents from untyped game code that every adapter refuses whatever their
 * link, because the contract needs an object with a string `text` and
 * `deepLink`.
 */
const malformedIntents: readonly (readonly [label: string, intent: unknown])[] = [
  ['a null intent', null],
  ['a string intent', '/daily'],
  ['an array intent', []],
  ['an intent without text', { kind: 'invite', title: 'Join', deepLink: '/daily' }],
  ['an intent with a number for text', { ...baseIntent, text: 1, deepLink: '/daily' }],
  ['an intent without a deep link', { ...baseIntent }],
  ['an intent with a null deep link', { ...baseIntent, deepLink: null }],
  [
    'an intent with a URL object for its deep link',
    { ...baseIntent, deepLink: new URL('https://game.example/daily') },
  ],
];

/**
 * Runs the `ShareIntent.deepLink` contract against one adapter's `share`:
 * every escape in `rootRelativeRouteVectors.rejected`, every link outside the
 * contract in `shareLinkVectors.rejected`, and malformed intents answer
 * `unavailable` and never reach the host; every route in
 * `rootRelativeRouteVectors.normalized` and absolute link in
 * `shareLinkVectors.normalized` is shared, and the host is handed the
 * normalized link as the adapter maps it. Every adapter that hands share
 * links to a host runs it, so a new escape added to the vectors is checked
 * on every target. It throws one error listing every failure.
 */
export async function runShareLinkConformance(
  fixture: ShareLinkConformanceFixture,
): Promise<ShareLinkConformanceReport> {
  const failures: string[] = [];
  let refused = 0;
  let shared = 0;

  const handedCount = (): number => fixture.host?.handedLinks().length ?? 0;

  async function attempt(label: string, intent: unknown): Promise<ShareResult | undefined> {
    try {
      return await fixture.share(intent as ShareIntent);
    } catch (error) {
      failures.push(`${label}: share rejected instead of answering (${errorMessage(error)})`);
      return undefined;
    }
  }

  async function expectRefused(label: string, intent: unknown): Promise<void> {
    const before = handedCount();
    const result = await attempt(label, intent);

    if (result !== undefined && !isSameResult(result, { status: 'unavailable' })) {
      failures.push(`${label}: answered ${JSON.stringify(result)} instead of unavailable`);
    }

    if (handedCount() !== before) {
      failures.push(`${label}: reached the host`);
    }

    refused += 1;
  }

  async function expectShared(label: string, deepLink: string, link: string): Promise<void> {
    const before = handedCount();
    const result = await attempt(label, { ...baseIntent, deepLink });

    if (result !== undefined && !isSameResult(result, fixture.sharedResult)) {
      failures.push(
        `${label}: answered ${JSON.stringify(result)} instead of ${JSON.stringify(fixture.sharedResult)}`,
      );
    }

    if (fixture.host !== undefined) {
      const handed = fixture.host.handedLinks().slice(before);
      const expected = fixture.host.expectedLink(link);

      if (handed.length !== 1 || handed[0] !== expected) {
        failures.push(
          `${label}: the host was handed ${JSON.stringify(handed)} instead of ${JSON.stringify([expected])}`,
        );
      }
    }

    shared += 1;
  }

  for (const [label, intent] of malformedIntents) {
    await expectRefused(label, intent);
  }

  for (const deepLink of [...rootRelativeRouteVectors.rejected, ...shareLinkVectors.rejected]) {
    await expectRefused(JSON.stringify(deepLink), { ...baseIntent, deepLink });
  }

  for (const [deepLink, link] of [
    ...rootRelativeRouteVectors.normalized,
    ...shareLinkVectors.normalized,
  ]) {
    await expectShared(JSON.stringify(deepLink), deepLink, link);
  }

  if (failures.length > 0) {
    throw new Error(`${fixture.name}: share link conformance failed:\n- ${failures.join('\n- ')}`);
  }

  return { name: fixture.name, refused, shared };
}

function isSameResult(actual: unknown, expected: ShareResult): boolean {
  if (typeof actual !== 'object' || actual === null) {
    return false;
  }

  const record = actual as Readonly<Record<string, unknown>>;

  return record['status'] === expected.status
    && record['completion'] === expected.completion
    && Object.keys(record).every((key) => key === 'status' || key === 'completion');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
