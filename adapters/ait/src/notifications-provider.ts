import {
  NotificationError,
  type NotificationCapabilities,
  type NotificationEndpointRegistration,
  type NotificationEvent,
  type NotificationPermissionOutcome,
  type NotificationPermissionResult,
  type NotificationPermissionSnapshot,
  type NotificationPermissionState,
  type NotificationProvider,
  type NotificationTopicId,
} from '@mpgd/platform/notifications';
import { hasRouteControlCharacter, normalizeRootRelativeRoute } from '@mpgd/platform/routes';

/**
 * Notifications v2 provider for Apps in Toss (notifications RFC "Provider
 * profiles → Apps in Toss"). It asks for agreement per message template
 * through `Notification.requestAgreement`, never reads it back (neither the
 * mini-app nor the server can), reports each decision as evidence for the
 * backend's consent record, and turns a launch from a Toss push or inbox
 * message into one cold `opened` event. The SDK is injected, so this module
 * imports no Apps in Toss code; `./host` passes the real SDK.
 */

/** Provider id of the Apps in Toss reference registry entry. */
export const aitNotificationProviderId = 'apps-in-toss';

/** Evidence schema of the agreement answers this provider reports. */
export const aitNotificationAgreementEvidenceSchema = 'apps-in-toss.notification-agreement.v1';

/**
 * How long a request waits for the agreement sheet's answer. A request with
 * no answer by then is `dismissed` (RFC "Apps in Toss", event mapping).
 */
export const aitNotificationAgreementTimeoutMs = 120_000;

/** Launch referrers that mean the player opened a Toss message (Apps in Toss referrer list). */
export const aitNotificationLandingReferrers = Object.freeze(['push', 'inbox'] as const);

export type AitNotificationLandingReferrer = (typeof aitNotificationLandingReferrers)[number];

/**
 * A topic's Apps in Toss mapping, as the catalog's `targets.ait` declares it.
 * `templateSetCode` is both the send API's template set code and the
 * agreement sheet's `templateCode`. `agreement: 'none'` marks a service
 * template without an agreement statement: it reads `granted` and never
 * prompts.
 */
export interface AitNotificationTopicMapping {
  readonly templateSetCode: string;
  readonly agreement: 'required' | 'none';
}

export type AitNotificationAgreementResult = 'newAgreement' | 'alreadyAgreed' | 'agreementRejected';

/** The parameter of `Notification.requestAgreement`. */
export interface AitNotificationAgreementRequest {
  readonly options: { readonly templateCode: string };
  readonly onEvent: (result: { readonly type: AitNotificationAgreementResult }) => void;
  readonly onError: (error: unknown) => void | Promise<void>;
}

/** The SDK surface the provider uses; `./host` passes `Notification` and `Environment`. */
export interface AitNotificationSdk {
  /** `Notification.requestAgreement` (Toss 5.255.0+); it returns the cleanup function. */
  readonly requestAgreement: ((request: AitNotificationAgreementRequest) => () => void) & {
    readonly isSupported?: () => boolean;
  };
  /** `Environment.initialURL`: the scheme URL the mini-app was launched with. */
  readonly readInitialUrl: () => string | undefined;
}

export interface CreateAitNotificationProviderInput {
  readonly sdk: AitNotificationSdk;
  /** Topic ids mapped to their Apps in Toss templates; without any the provider is `configuration-required`. */
  readonly topics: Readonly<Record<NotificationTopicId, AitNotificationTopicMapping>>;
  /** May be shortened (tests), never extended past `aitNotificationAgreementTimeoutMs`. */
  readonly agreementTimeoutMs?: number;
  /** The device's IANA zone for the `platform-user` registration; absent when unknown. */
  readonly timeZone?: () => string | undefined;
  /** The player's locale for the `platform-user` registration; absent when unknown. */
  readonly locale?: () => string | undefined;
  /**
   * Whether a launch from a Toss message becomes an `opened` event (default
   * true). The host bridge turns it off for games that map only v1 topics:
   * they never subscribe, so the launch intent must keep routing it.
   */
  readonly landingOpens?: boolean;
  /**
   * Called before the cold open is emitted; `false` means another reader
   * (the host's launch intent) already routed this launch, so the provider
   * emits nothing. Absent, the provider always may.
   */
  readonly claimLanding?: () => boolean;
}

/** The provider, plus the read the v1 surface and the launch intent share. */
export interface AitNotificationProvider extends NotificationProvider {
  /** Whether `topic` has an Apps in Toss mapping. */
  hasTopic(topic: NotificationTopicId): boolean;
  /**
   * Whether a push or inbox launch becomes the cold `opened` event: landing
   * opens are on and a topic is mapped. The launch intent leaves such a
   * launch to the event exactly when this is true.
   */
  deliversLandingOpens(): boolean;
}

/** A fresh Apps in Toss capability block (RFC profile table). */
export function createAitNotificationCapabilities(
  availability: NotificationCapabilities['availability'] = 'available',
): NotificationCapabilities {
  return {
    availability,
    permission: {
      scope: 'topic',
      prompt: 'host',
      readable: false,
      serverReadable: false,
      allowance: 'persistent',
      userGesture: true,
      settings: false,
    },
    remote: {
      supported: true,
      purposes: ['service', 'requested'],
      addressing: 'platform-user',
      content: 'host-template',
    },
    local: { supported: false },
    open: 'landing-url',
  };
}

/** Validates and copies topic mappings; a blank code or an unknown agreement throws. */
export function normalizeAitNotificationTopics(
  input: Readonly<Record<string, AitNotificationTopicMapping>> | undefined,
): ReadonlyMap<NotificationTopicId, AitNotificationTopicMapping> {
  const topics = new Map<NotificationTopicId, AitNotificationTopicMapping>();
  if (input === undefined) {
    return topics;
  }
  for (const [topic, mapping] of Object.entries(input)) {
    if (topic.length === 0) {
      throw new TypeError('AIT notification topic ids must not be empty.');
    }
    const templateSetCode = typeof mapping?.templateSetCode === 'string'
      ? mapping.templateSetCode.trim()
      : '';
    if (templateSetCode.length === 0) {
      throw new TypeError(`AIT notification topic ${topic} needs a non-empty templateSetCode.`);
    }
    if (mapping.agreement !== 'required' && mapping.agreement !== 'none') {
      throw new TypeError(`AIT notification topic ${topic} needs agreement 'required' or 'none'.`);
    }
    topics.set(topic, { templateSetCode, agreement: mapping.agreement });
  }
  return topics;
}

/** One agreement prompt's answer, before it becomes an outcome. */
type AgreementAnswer =
  | { readonly kind: 'answered'; readonly result: AitNotificationAgreementResult }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'terms-declined' };

/**
 * The Apps in Toss notifications provider.
 *
 * - **Reads.** A topic that needs an agreement reads `unknown` (the host gives
 *   no read, so the backend record decides), or `unsupported` on a Toss app
 *   older than 5.255.0. A topic mapped with `agreement: 'none'` reads
 *   `granted`, and an unmapped topic reads `unsupported`.
 * - **Requests.** Each topic that needs an agreement gets its own sheet, one
 *   at a time. `newAgreement` is `granted`, `alreadyAgreed`
 *   `already-granted`, and `agreementRejected` `denied`; the snapshot carries
 *   the decided state. No answer within 120 seconds is `dismissed`, and so
 *   are the topics after it, which are not prompted. `TERMS_DISAGREED_MEMBER`
 *   is the `action-required` outcome with `requiredAction: 'host-settings'`,
 *   for that topic and the remaining ones, which are not prompted either. A
 *   too-old Toss app throws `NOTIFICATIONS_HOST_VERSION_UNSUPPORTED` before
 *   any sheet, `NOTIFICATION_AGREEMENT_FAILED` (a bad template code) throws
 *   `NOTIFICATIONS_CONFIGURATION_REQUIRED` with that `hostCode`, and any other
 *   host error throws `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`. That retryable
 *   failure, after an earlier topic of the same request was answered, does
 *   not throw: that answer and its evidence are returned, and the failed and
 *   remaining topics are `dismissed`. The SDK's cleanup function is always called.
 * - **Evidence.** A request with a decided answer carries an
 *   `apps-in-toss.notification-agreement.v1` envelope with each answered
 *   topic's template set code and SDK event, for the backend's
 *   `host-agreement` record; the host offers no other proof.
 * - **Opens.** The first subscriber receives, once, a cold remote `opened`
 *   event when the launch URL's referrer is `push` or `inbox`, with the
 *   landing route when it is a safe root-relative route (see
 *   `readAitNotificationLanding`).
 */
export function createAitNotificationProvider(
  input: CreateAitNotificationProviderInput,
): AitNotificationProvider {
  const topics = normalizeAitNotificationTopics(input.topics);
  const timeoutMs = normalizeAgreementTimeout(input.agreementTimeoutMs);
  const { sdk } = input;
  const landingOpens = input.landingOpens !== false && topics.size > 0;
  let landingRead = false;
  // One agreement sheet at a time: the SDK keeps a callback per call, and two
  // sheets at once would leave the player answering the wrong one.
  let promptChain: Promise<unknown> = Promise.resolve();

  const hostSupportsAgreement = (): boolean => {
    try {
      return sdk.requestAgreement.isSupported?.() === true;
    } catch {
      return false;
    }
  };

  const readState = (topic: NotificationTopicId): NotificationPermissionState => {
    const mapping = topics.get(topic);
    if (mapping === undefined) {
      return 'unsupported';
    }
    if (mapping.agreement === 'none') {
      return 'granted';
    }
    return hostSupportsAgreement() ? 'unknown' : 'unsupported';
  };

  const ask = (templateCode: string): Promise<AgreementAnswer> => {
    const run = promptChain.then(() => requestAgreement(sdk, templateCode, timeoutMs));
    promptChain = run.catch(() => undefined);
    return run;
  };

  return {
    provider: aitNotificationProviderId,
    hasTopic: (topic) => topics.has(topic),
    deliversLandingOpens: () => landingOpens,
    async getCapabilities() {
      return createAitNotificationCapabilities(
        topics.size === 0 ? 'configuration-required' : 'available',
      );
    },
    async getPermission(request) {
      return {
        topics: Object.fromEntries(unique(request.topics).map((topic) => [topic, readState(topic)])),
      };
    },
    async requestPermission(request) {
      const requested = unique(request.topics);
      // Maps, so a topic id such as `__proto__` stays an ordinary key.
      const outcomes = new Map<NotificationTopicId, NotificationPermissionOutcome>();
      const decided = new Map<NotificationTopicId, NotificationPermissionState>();
      const askable: { readonly topic: NotificationTopicId; readonly mapping: AitNotificationTopicMapping }[] = [];
      for (const topic of requested) {
        const mapping = topics.get(topic);
        if (mapping === undefined) {
          outcomes.set(topic, 'unavailable');
        } else if (mapping.agreement === 'none') {
          outcomes.set(topic, 'already-granted');
        } else {
          askable.push({ topic, mapping });
        }
      }
      if (askable.length > 0 && !hostSupportsAgreement()) {
        throw hostVersionUnsupported();
      }
      const evidence = new Map<string, string>();
      let requiredAction: NotificationPermissionResult['requiredAction'];
      // Once a sheet goes unanswered, fails, or the member's terms block every
      // sheet, the remaining topics are not prompted: they answer the same
      // outcome without reaching the host (dismissed, or action-required).
      let remaining: NotificationPermissionOutcome | undefined;
      for (const { topic, mapping } of askable) {
        if (remaining !== undefined) {
          outcomes.set(topic, remaining);
          continue;
        }
        let answer: AgreementAnswer;
        try {
          answer = await ask(mapping.templateSetCode);
        } catch (error) {
          // A configuration or host-version failure must surface, whatever was
          // answered before it. A retryable one after an answered sheet is
          // absorbed: the host keeps that agreement, so report it rather than
          // lose its evidence. This topic and the rest were not decided, so
          // the next request asks again.
          if (decided.size === 0 || !(error instanceof NotificationError && error.retryable)) {
            throw error;
          }
          console.warn('AIT notification agreement failed after earlier answers.', error);
          outcomes.set(topic, 'dismissed');
          remaining = 'dismissed';
          continue;
        }
        switch (answer.kind) {
          case 'timeout':
            outcomes.set(topic, 'dismissed');
            remaining = 'dismissed';
            break;
          case 'terms-declined':
            // The personalization terms are the member's, not the template's.
            outcomes.set(topic, 'action-required');
            requiredAction = 'host-settings';
            remaining = 'action-required';
            break;
          case 'answered': {
            const outcome = agreementOutcome(answer.result);
            outcomes.set(topic, outcome);
            decided.set(topic, outcome === 'denied' ? 'denied' : 'granted');
            evidence.set(`templateSetCode:${topic}`, mapping.templateSetCode);
            evidence.set(`result:${topic}`, answer.result);
            break;
          }
        }
      }
      const snapshot: NotificationPermissionSnapshot = {
        topics: Object.fromEntries(
          requested.map((topic) => [topic, decided.get(topic) ?? readState(topic)]),
        ),
      };
      return {
        snapshot,
        outcomes: Object.fromEntries(outcomes),
        ...(requiredAction === undefined ? {} : { requiredAction }),
        ...(decided.size === 0
          ? {}
          : {
              evidence: {
                schema: aitNotificationAgreementEvidenceSchema,
                payload: { provider: aitNotificationProviderId, ...Object.fromEntries(evidence) },
              },
            }),
      };
    },
    async register(): Promise<NotificationEndpointRegistration | null> {
      if (topics.size === 0) {
        // Nothing is mapped, so there is nothing the server could send.
        return null;
      }
      const timeZone = readOptional(() => input.timeZone?.());
      const locale = readOptional(() => input.locale?.());
      return {
        provider: aitNotificationProviderId,
        address: { kind: 'platform-user' },
        ...(locale === undefined ? {} : { locale }),
        ...(timeZone === undefined ? {} : { timeZone }),
      };
    },
    async openSettings() {
      // Toss offers no link into its notification settings.
      return 'unavailable';
    },
    subscribe(listener) {
      // The only event is the launch's cold open: a Toss message opens the
      // mini-app with a new launch, so nothing arrives later, and the open
      // goes to the first subscriber only.
      if (!landingRead && landingOpens) {
        landingRead = true;
        const landing = readAitNotificationLanding(readOptional(() => sdk.readInitialUrl()));
        if (landing !== undefined && input.claimLanding?.() !== false) {
          deliver(listener, toOpenedEvent(landing));
        }
      }
      return () => {};
    },
  };
}

function deliver(listener: (event: NotificationEvent) => void, event: NotificationEvent): void {
  try {
    listener(event);
  } catch (error) {
    console.warn('AIT notification listener failed.', error);
  }
}

function toOpenedEvent(landing: AitNotificationLanding): NotificationEvent {
  return {
    type: 'opened',
    channel: 'remote',
    source: 'cold',
    referrer: landing.referrer,
    ...(landing.route === undefined ? {} : { route: landing.route }),
  };
}

function agreementOutcome(result: AitNotificationAgreementResult): NotificationPermissionOutcome {
  switch (result) {
    case 'newAgreement':
      return 'granted';
    case 'alreadyAgreed':
      return 'already-granted';
    case 'agreementRejected':
      return 'denied';
  }
}

/** Host error codes `Notification.requestAgreement` documents. */
const unsupportedAppVersionCode = 'UNSUPPORTED_APP_VERSION';
const agreementFailedCode = 'NOTIFICATION_AGREEMENT_FAILED';
const termsDisagreedCode = 'TERMS_DISAGREED_MEMBER';

/**
 * One agreement sheet. Settles on the first event, error, or the timeout, and
 * calls the SDK's cleanup function exactly once whichever comes first, also
 * when the SDK answers before it returns the cleanup function.
 */
function requestAgreement(
  sdk: AitNotificationSdk,
  templateCode: string,
  timeoutMs: number,
): Promise<AgreementAnswer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cleanup: (() => void) | undefined;
    let cleaned = false;
    const runCleanup = (): void => {
      if (cleanup === undefined || cleaned) {
        return;
      }
      cleaned = true;
      try {
        cleanup();
      } catch (error) {
        console.warn('AIT notification agreement cleanup failed.', error);
      }
    };
    const timer = globalThis.setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    function finish(answer: AgreementAnswer | NotificationError): void {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      runCleanup();
      if (answer instanceof NotificationError) {
        reject(answer);
      } else {
        resolve(answer);
      }
    }
    try {
      const unregister = sdk.requestAgreement({
        options: { templateCode },
        onEvent: (event) => {
          const type: unknown = event?.type;
          finish(
            type === 'newAgreement' || type === 'alreadyAgreed' || type === 'agreementRejected'
              ? { kind: 'answered', result: type }
              : new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
                  message: 'Apps in Toss answered the notification agreement with an unknown event.',
                }),
          );
        },
        onError: (error) => finish(fromHostError(error)),
      });
      if (typeof unregister === 'function') {
        cleanup = unregister;
        if (settled) {
          runCleanup();
        }
      }
    } catch (error) {
      finish(fromHostError(error));
    }
  });
}

function fromHostError(error: unknown): AgreementAnswer | NotificationError {
  const code = hostErrorCode(error);
  switch (code) {
    case termsDisagreedCode:
      return { kind: 'terms-declined' };
    case unsupportedAppVersionCode:
      return hostVersionUnsupported(error);
    case agreementFailedCode:
      return new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
        message: 'Apps in Toss refused the notification template code.',
        hostCode: code,
        cause: error,
      });
    default:
      return new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: 'Apps in Toss could not show the notification agreement.',
        cause: error,
      });
  }
}

/** The SDK's `error.code`; a bare string or an error whose message is the code also counts. */
function hostErrorCode(error: unknown): string | undefined {
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { code, message } = error as { readonly code?: unknown; readonly message?: unknown };
  if (typeof code === 'string') {
    return code;
  }
  return typeof message === 'string'
    && [unsupportedAppVersionCode, agreementFailedCode, termsDisagreedCode].includes(message)
    ? message
    : undefined;
}

function hostVersionUnsupported(cause?: unknown): NotificationError {
  return new NotificationError('NOTIFICATIONS_HOST_VERSION_UNSUPPORTED', {
    message: 'Notification agreement needs Toss 5.255.0 or later.',
    ...(cause === undefined ? {} : { cause }),
  });
}

function normalizeAgreementTimeout(value: number | undefined): number {
  if (value === undefined) {
    return aitNotificationAgreementTimeoutMs;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('AIT notification agreement timeout must be a positive finite number.');
  }
  return Math.min(value, aitNotificationAgreementTimeoutMs);
}

function unique(topics: readonly NotificationTopicId[]): NotificationTopicId[] {
  return [...new Set(topics)];
}

function readOptional(read: () => string | undefined): string | undefined {
  try {
    const value = read();
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

// Landing opens.

export interface AitNotificationLanding {
  readonly referrer: AitNotificationLandingReferrer;
  /** The landing route, when it is a root-relative route on the game's origin. */
  readonly route?: string;
}

/** The longest landing route an `opened` event carries, as a catalog route. */
const maximumLandingRouteLength = 2048;

/**
 * Reads a launch URL (`Environment.initialURL`, such as
 * `intoss://my-game/daily?entry=continue&referrer=push`) as a notification
 * open, or answers `undefined` when its `referrer` query parameter is not
 * `push` or `inbox`. The route is the URL's path, query, and fragment after
 * the scheme and authority, without the `referrer` parameter, normalized by
 * `normalizeRootRelativeRoute` from `@mpgd/platform/routes` as share links
 * are; a route that function refuses, or one longer than 2,048 characters,
 * is left out and the open still counts. The authority is never read, so a
 * link naming another app or host cannot change the route's origin. A URL
 * with a control character is not an open.
 */
export function readAitNotificationLanding(url: string | undefined): AitNotificationLanding | undefined {
  if (url === undefined || hasRouteControlCharacter(url)) {
    return undefined;
  }
  const rest = afterAuthority(url);
  if (rest === undefined) {
    return undefined;
  }
  const hashIndex = rest.indexOf('#');
  const beforeHash = hashIndex < 0 ? rest : rest.slice(0, hashIndex);
  const hash = hashIndex < 0 ? '' : rest.slice(hashIndex);
  const queryIndex = beforeHash.indexOf('?');
  const path = queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : beforeHash.slice(queryIndex + 1);
  let referrer: string | undefined;
  const kept: string[] = [];
  for (const piece of query === '' ? [] : query.split('&')) {
    const separator = piece.indexOf('=');
    const key = decodeQueryComponent(separator < 0 ? piece : piece.slice(0, separator));
    if (key === 'referrer') {
      referrer ??= decodeQueryComponent(separator < 0 ? '' : piece.slice(separator + 1));
      continue;
    }
    kept.push(piece);
  }
  if (referrer === undefined || !isLandingReferrer(referrer)) {
    return undefined;
  }
  const route = normalizeRootRelativeRoute(
    `${path === '' ? '/' : path}${kept.length === 0 ? '' : `?${kept.join('&')}`}${hash}`,
  );
  return route === undefined || route.length > maximumLandingRouteLength
    ? { referrer }
    : { referrer, route };
}

function isLandingReferrer(value: string): value is AitNotificationLandingReferrer {
  return (aitNotificationLandingReferrers as readonly string[]).includes(value);
}

/**
 * The part of a launch URL after `scheme://authority`, or the URL itself when
 * it is root-relative. Text matching, not a URL parser: `intoss:` is not a
 * special scheme, and parsers disagree on where its authority ends.
 */
function afterAuthority(url: string): string | undefined {
  if (url.startsWith('/') && !url.startsWith('//')) {
    return url;
  }
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.exec(url);
  if (scheme === null) {
    return undefined;
  }
  const authorityAndRest = url.slice(scheme[0].length);
  const end = authorityAndRest.search(/[/?#]/u);
  return end < 0 ? '' : authorityAndRest.slice(end);
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/gu, ' '));
  } catch {
    return value;
  }
}
