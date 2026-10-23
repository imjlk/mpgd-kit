/**
 * The server half of the notifications v2 live test (docs/NOTIFICATIONS_LIVE_TEST.md):
 * it calls a game-services Worker's notification session routes as one test
 * player, prints each answer, and checks the status the contract expects.
 *
 * No Node, DOM, network, or SDK import: the CLI (`cli.ts`) supplies `fetch`, the
 * clock, and the log, and the dry run (apps/game-services-worker/src/
 * notificationsLiveDriver.test.ts) supplies the in-process Worker instead
 * of a network, so both run the same steps. Its one import is the pure
 * development-session token helper from `@mpgd/game-services`.
 */

import {
  developmentNotificationSessionPrefix,
  formatDevelopmentNotificationSessionAuthorization,
  isDevelopmentNotificationSessionId,
  type DevelopmentNotificationSession,
} from '@mpgd/game-services';

/** The Worker's notifications route prefix. */
export const liveNotificationsRoutePrefix = '/game-services/notifications';

/**
 * The route `wrangler dev` (4.x) serves to run the Worker's `scheduled`
 * handler once. A deployed Worker has no such route: its cron runs itself.
 */
export const wranglerDevScheduledRoute = '/cdn-cgi/handler/scheduled';

/**
 * Host labels that mark a test environment, as in `staging.example.com` or
 * `game-services-staging.example.workers.dev`. The top-level domain never
 * counts (`.dev` is a public suffix, not a test label).
 */
export const liveTestEnvironmentLabels: readonly string[] = Object.freeze([
  'staging',
  'stage',
  'dev',
  'development',
  'test',
  'testing',
  'qa',
  'sandbox',
  'preview',
]);

/** The Worker the driver may call, as `assertLiveWorkerOrigin` accepted it. */
export interface LiveWorkerOrigin {
  /** The origin, without a trailing slash. */
  readonly origin: string;
  /** Whether it is this machine (`localhost`, `127.0.0.1`, `[::1]`). */
  readonly local: boolean;
}

/** Thrown for anything the driver refuses before it sends a request. */
export class LiveDriverUsageError extends Error {
  override readonly name = 'LiveDriverUsageError';
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '[::1]';
}

/**
 * Whether a host name has a label (other than its last) that marks a test
 * environment, whole or as a `-` separated part. A heuristic, and the second
 * of two opt-ins: the maintainer also names the host with `--staging`. A
 * name with a trailing dot is refused, so its last label is the real TLD.
 */
export function hasTestEnvironmentLabel(hostname: string): boolean {
  if (hostname.endsWith('.')) {
    return false;
  }
  const labels = hostname.toLowerCase().split('.');
  return labels.slice(0, -1).some((label) =>
    label.split('-').some((part) => liveTestEnvironmentLabels.includes(part)),
  );
}

/**
 * Accepts the Worker URL the driver will call: an origin on this machine,
 * or, only when `staging` names exactly its host, an https origin whose host
 * has a test-environment label. Anything else is refused before a request
 * is sent, so the driver cannot write test records to a production Worker.
 */
export function assertLiveWorkerOrigin(raw: string, staging?: string): LiveWorkerOrigin {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LiveDriverUsageError(`--worker ${JSON.stringify(raw)} is not a URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LiveDriverUsageError('--worker must be an http or https URL.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new LiveDriverUsageError('--worker must not carry credentials.');
  }
  // An http(s) URL's path is at least '/'.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new LiveDriverUsageError(
      '--worker is the Worker origin only, such as http://127.0.0.1:8787.',
    );
  }
  if (url.hostname.endsWith('.')) {
    throw new LiveDriverUsageError(
      `--worker ${url.hostname} ends with a dot; name the host without it.`,
    );
  }
  if (isLocalHostname(url.hostname)) {
    return { origin: url.origin, local: true };
  }
  if (staging === undefined) {
    throw new LiveDriverUsageError(
      `${url.hostname} is not this machine. The driver writes test records; to run it against a `
        + 'test deployment, name its host with --staging <host>.',
    );
  }
  if (staging.toLowerCase() !== url.hostname.toLowerCase()) {
    throw new LiveDriverUsageError(
      `--staging ${staging} does not name the --worker host ${url.hostname}.`,
    );
  }
  if (!hasTestEnvironmentLabel(url.hostname)) {
    throw new LiveDriverUsageError(
      `${url.hostname} has no label that marks a test environment (${liveTestEnvironmentLabels.join(', ')}); `
        + 'the driver does not run against it.',
    );
  }
  if (url.protocol !== 'https:') {
    throw new LiveDriverUsageError('A --staging Worker is reached over https only.');
  }
  return { origin: url.origin, local: false };
}

/**
 * The `Authorization` value of a local development session
 * (`MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS` in the Worker):
 * `Bearer mpgd-dev.<playerId>.<sessionId>.<installationId>`, built by the
 * same `@mpgd/game-services` helper whose parser the Worker uses, so the two
 * cannot drift. It authenticates nothing: a Worker accepts it only in
 * local development, on a local request host.
 */
export function developmentSessionAuthorization(session: DevelopmentNotificationSession): string {
  for (const [name, value] of Object.entries(session)) {
    if (!isDevelopmentNotificationSessionId(value)) {
      throw new LiveDriverUsageError(
        `${name} ${JSON.stringify(value)} must be 1 to 64 letters, digits, '_' or '-'.`,
      );
    }
  }
  return formatDevelopmentNotificationSessionAuthorization(session);
}

/** The part of the Fetch API the driver uses. */
export type LiveDriverFetch = (
  url: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

export interface LiveDriverDependencies {
  readonly fetch: LiveDriverFetch;
  readonly log: (line: string) => void;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * The Worker's `deliverNotification` RPC. It is a service-binding method,
   * not an HTTP route, so only an in-process run (the dry run) has it.
   */
  readonly deliver?: (input: {
    readonly idempotencyKey: string;
    readonly player: string;
    readonly topic: string;
    readonly templateData?: Readonly<Record<string, string>>;
  }) => Promise<unknown>;
}

export interface LiveDriverOptions {
  readonly worker: LiveWorkerOrigin;
  /** The session's `Authorization` header value. Never printed. */
  readonly authorization: string;
  /** How the log names the session, such as `development session for player p-1`. */
  readonly sessionLabel: string;
  /** The test player, when the driver knows it (a development session); needed for `deliver`. */
  readonly playerId?: string;
  /** The catalog target the device registers for, such as `android`. */
  readonly target: string;
  /** A `requested` topic the target maps with the remote channel, such as `daily-ready`. */
  readonly topic: string;
  /** Distinguishes this run's reminder keys and send keys from earlier runs. */
  readonly runId: string;
  /** Seconds from now the test reminder fires; the driver waits that long before it runs the scheduler. */
  readonly fireInSeconds: number;
  /**
   * An FCM registration token the driver registers for its own session, as
   * the app would, with a granted permission report. Without it the device
   * must have registered itself for the same player. Never printed.
   */
  readonly fcmToken?: string;
  /** Run the scheduler through `wranglerDevScheduledRoute` (local Workers only). */
  readonly triggerScheduler: boolean;
  /** Record advertising consent with this text version, then check its result notice. */
  readonly advertisingTextVersion?: string;
  /** One send through `deliverNotification`, made only when `dependencies.deliver` is given. */
  readonly deliver?: {
    readonly topic: string;
    /** Fills the topic copy's `{{name}}` placeholders. */
    readonly templateData?: Readonly<Record<string, string>>;
  };
}

export type LiveDriverStepResult = 'pass' | 'warn' | 'skip' | 'fail';

export interface LiveDriverStep {
  readonly name: string;
  readonly result: LiveDriverStepResult;
  readonly detail: string;
}

export interface LiveDriverReport {
  readonly ok: boolean;
  readonly steps: readonly LiveDriverStep[];
  /** The test reminder's key, for the runbook's checks. */
  readonly reminderKey: string;
}

interface Answer {
  readonly status: number;
  /** The parsed JSON object, or `undefined` when the body was not one. */
  readonly body: JsonObject | undefined;
  readonly text: string;
}

/** Stops the run at a failed step: later steps depend on it. */
class StepFailed extends Error {}

/** A request that got no readable answer. */
class TransportFailed extends Error {}

/** What a 401 on the session step most likely means, by the kind of session sent. */
function sessionRefusedHint(status: number, authorization: string): string | undefined {
  if (status !== 401) {
    return undefined;
  }
  return authorization.startsWith(developmentNotificationSessionPrefix)
    ? 'the Worker did not accept this development session: it needs the flag, and it is accepted only on a '
      + 'local host (localhost, 127.0.0.1, [::1], *.localhost, or 10.0.2.2).'
    : 'the Worker did not accept this session: has it expired, or is it for another identity service?';
}

/** What a `providers` failure most likely means. */
function providersHint(status: number): string | undefined {
  if (status === 404) {
    return 'notifications are off: the Worker has no MPGD_NOTIFICATIONS_CATALOG.';
  }
  if (status === 500) {
    return 'the notifications configuration is broken; read the Worker log.';
  }
  return undefined;
}

/**
 * A `deliverNotification` answer: the service's own (`{ status, ... }`), or
 * the Worker RPC's wrapper around it (`{ ok: true, value }` or
 * `{ ok: false, error: { code } }`).
 */
function deliveryAnswer(result: unknown): { readonly status: unknown; readonly alreadyProcessed: boolean } {
  const record = typeof result === 'object' && result !== null ? result as JsonObject : {};
  if (record['ok'] === false) {
    const error = record['error'] as JsonObject | undefined;
    return { status: `error ${String(error?.['code'])}`, alreadyProcessed: false };
  }
  const value = record['ok'] === true && typeof record['value'] === 'object' && record['value'] !== null
    ? record['value'] as JsonObject
    : record;
  return { status: value['status'], alreadyProcessed: value['alreadyProcessed'] === true };
}

type JsonObject = Readonly<Record<string, unknown>>;

/** The answer's `field` as a list of objects, or `undefined` when it is not a list. */
function listField(answer: Answer, field: string): readonly JsonObject[] | undefined {
  const value = answer.body?.[field];
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonObject => typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    : undefined;
}

const maxPrintedAnswer = 600;
/** The latest test reminder the driver sets, in seconds from now. */
export const maxLiveFireInSeconds = 3600;
/** The set-and-cancel check's reminder: far enough ahead that no scheduler run takes it first. */
const spareReminderSeconds = 3600;
/** Waited past fireAt before the scheduler runs, for clock rounding. */
const dueMarginMs = 1000;
const reminderSetHints: Readonly<Record<string, string>> = {
  'permission-required':
    'no endpoint with a granted permission is registered for this player: allow notifications in the app '
      + '(signed in with the same player) or pass --fcm-token-file.',
  'request-missing': 'the player has not turned the topic on; the topic-preference step should have done it.',
  'preference-off': 'the player turned the topic off.',
  'advertising-consent-missing': 'the topic is advertising and the player has no advertising consent.',
  'capacity-exceeded': 'the player has too many pending reminders.',
  unavailable: 'no provider can deliver the topic to this player now.',
};

/** Replaces each secret in `text`, so a log line never carries one. */
export function redactLiveSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    // A string this short would blank common text out of the log; every
    // secret the driver holds (a bearer token, an FCM token) is far longer.
    if (secret.length >= 4) {
      result = result.split(secret).join('<redacted>');
    }
  }
  return result;
}

/**
 * Runs the live-test steps against the Worker, in order, and stops at the
 * first failure:
 *
 * 1. `GET /providers` answers the registry and serves `target`.
 * 2. A session route without `Authorization` answers 401 (the routes are
 *    mounted and authenticated).
 * 3. `GET /consent` with the session answers its records.
 * 4. With `fcmToken`: `POST /endpoints` and a granted delivery-permission
 *    report, as the app sends them. Without it: the player's latest
 *    delivery-permission record is checked (a warning when missing).
 * 5. `POST /consent`: the player turns `topic` on.
 * 6. A far reminder is set and cancelled (`cancelled: true`).
 * 7. The test reminder is set at now + `fireInSeconds` (`scheduled`).
 * 8. On a local Worker: after it is due, the scheduler runs once, and a
 *    cancel answers `cancelled: false` because the scheduler took it.
 * 9. With `deliver` and `dependencies.deliver`: one `deliverNotification` send.
 * 10. `GET /notices`; with `advertisingTextVersion`, advertising consent is
 *     recorded, its result notice listed, recorded as shown, and gone.
 * 11. Clean-up, which only warns: unless a passing run leaves a reminder
 *     for a deployed Worker's cron, the reminders still pending are
 *     cancelled and an endpoint the driver registered is unregistered.
 */
export async function runNotificationsLiveDriver(
  options: LiveDriverOptions,
  dependencies: LiveDriverDependencies,
): Promise<LiveDriverReport> {
  // The header value, and its credential without the scheme (`Bearer`, or any other).
  const secrets = [options.authorization, options.authorization.replace(/^\S+\s+/u, '')];
  if (options.fcmToken !== undefined) {
    secrets.push(options.fcmToken);
  }
  const redact = (text: string): string => redactLiveSecrets(text, secrets);
  const print = (line: string): void => dependencies.log(redact(line));
  const steps: LiveDriverStep[] = [];
  /** Records a step that passed, warned, or was skipped. */
  const record = (name: string, result: Exclude<LiveDriverStepResult, 'fail'>, detail: string): void => {
    steps.push({ name, result, detail: redact(detail) });
    print(`${result.toUpperCase().padEnd(4)} ${name}: ${detail}`);
  };
  /** Records a failed step and stops the run: later steps depend on it. */
  // Typed on the binding, so a call narrows like a throw.
  const fail: (name: string, detail: string) => never = (name, detail) => {
    steps.push({ name, result: 'fail', detail: redact(detail) });
    print(`FAIL ${name}: ${detail}`);
    throw new StepFailed(detail);
  };
  /** One request; a transport failure throws `TransportFailed` and records nothing. */
  const transport = async (
    method: 'GET' | 'POST',
    route: string,
    body?: unknown,
    authenticated = true,
  ): Promise<Answer> => {
    const url = route.startsWith('/cdn-cgi/')
      ? `${options.worker.origin}${route}`
      : `${options.worker.origin}${liveNotificationsRoutePrefix}${route}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(authenticated ? { authorization: options.authorization } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    let response: Awaited<ReturnType<LiveDriverFetch>>;
    try {
      response = await dependencies.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new TransportFailed(
        `the Worker could not be reached (${reason}). Is wrangler dev running?`,
      );
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new TransportFailed(`the answer (${response.status}) could not be read (${reason}).`);
    }
    let parsed: Readonly<Record<string, unknown>> | undefined;
    try {
      const value: unknown = text.length === 0 ? undefined : JSON.parse(text);
      parsed = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : undefined;
    } catch {
      parsed = undefined;
    }
    // Redacted before it is cut, so a secret across the cut cannot leave a prefix behind.
    const shown = Array.from(redact(text));
    print(`     ${method} ${route}${authenticated ? '' : ' (no Authorization)'} -> ${response.status} ${
      shown.length > maxPrintedAnswer ? `${shown.slice(0, maxPrintedAnswer).join('')}…` : shown.join('')
    }`);
    return { status: response.status, body: parsed, text };
  };
  /** One request of a step; a transport failure fails the step. */
  const call = async (
    method: 'GET' | 'POST',
    route: string,
    body?: unknown,
    authenticated = true,
  ): Promise<Answer> => {
    try {
      return await transport(method, route, body, authenticated);
    } catch (error) {
      if (error instanceof TransportFailed) {
        return fail(`${method} ${route}`, error.message);
      }
      throw error;
    }
  };
  const expectStatus = (name: string, answer: Answer, status: number, hint?: string): void => {
    if (answer.status !== status) {
      const code = typeof answer.body?.['error'] === 'string' ? ` (${answer.body['error']})` : '';
      fail(
        name,
        `expected ${status}, got ${answer.status}${code}${hint === undefined ? '' : `: ${hint}`}`,
      );
    }
  };
  const fireAt = (secondsFromNow: number): string =>
    new Date(dependencies.now() + secondsFromNow * 1000).toISOString();
  const reminderKey = `live-${options.runId}`;
  if (
    !Number.isInteger(options.fireInSeconds)
    || options.fireInSeconds < 0
    || options.fireInSeconds > maxLiveFireInSeconds
  ) {
    throw new LiveDriverUsageError(
      `fireInSeconds is whole seconds from 0 to ${maxLiveFireInSeconds}.`,
    );
  }
  if (options.triggerScheduler && !options.worker.local) {
    throw new LiveDriverUsageError(
      'The scheduler route exists only on a local wrangler dev Worker; pass --no-scheduler.',
    );
  }

  print(`Worker ${options.worker.origin} (${options.worker.local ? 'local' : 'staging'}), ${options.sessionLabel}, `
    + `target ${options.target}, topic ${options.topic}, run ${options.runId}`);
  let registered: string | undefined;
  /** Reminders this run may have set and not seen sent or cancelled. */
  const pending = new Set<string>();
  /** Set as the last step of a run that was not stopped. */
  let completed = false;
  try {
    // 1. The registry.
    const providers = await call('GET', '/providers', undefined, false);
    expectStatus('providers', providers, 200, providersHint(providers.status));
    const targets = providers.body?.['targets'];
    const provider = typeof targets === 'object' && targets !== null
      ? (targets as Readonly<Record<string, unknown>>)[options.target]
      : undefined;
    if (typeof provider !== 'string') {
      fail(
        'providers',
        `the Worker serves no provider for ${options.target}: is FCM_SERVICE_ACCOUNT set?`,
      );
    }
    record(
      'providers',
      'pass',
      `protocol ${String(providers.body?.['protocolVersion'])}, ${options.target} -> ${provider}`,
    );

    // 2. The session routes are mounted and refuse an anonymous call.
    const anonymous = await call('GET', '/consent', undefined, false);
    expectStatus(
      'session-required',
      anonymous,
      401,
      anonymous.status === 404
        ? 'the session routes are off: start the Worker with '
          + 'MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS = "true" (local only) or bind '
          + 'GAME_SERVICES_NOTIFICATIONS_AUTH.'
        : undefined,
    );
    record('session-required', 'pass', 'an anonymous session route answers 401');

    // 3. The session resolves.
    const consent = await call('GET', '/consent');
    expectStatus(
      'session',
      consent,
      200,
      sessionRefusedHint(consent.status, options.authorization),
    );
    const records = listField(consent, 'records');
    if (records === undefined) {
      return fail('session', 'GET /consent answered no records list.');
    }
    record('session', 'pass', `${records.length} consent record(s) for this player`);

    // 4. The device's endpoint and permission.
    if (options.fcmToken === undefined) {
      const permission = [...records].reverse().find(
        (entry) => entry['kind'] === 'delivery-permission',
      );
      record(
        'device-permission',
        permission?.['state'] === 'granted' ? 'pass' : 'warn',
        permission === undefined
          ? 'no delivery-permission record yet: allow notifications in the app, signed in as this player.'
          : `latest delivery-permission record: ${String(permission['state'])}`,
      );
    } else {
      // Tracked before the request, as reminders are: a lost answer may still have registered it.
      registered = provider;
      const registration = await call('POST', '/endpoints', {
        registration: {
          provider,
          address: { kind: 'fcm-token', value: options.fcmToken, permission: 'granted' },
        },
        target: options.target,
      });
      expectStatus('register-endpoint', registration, 200);
      record(
        'register-endpoint',
        'pass',
        `an FCM token (${options.fcmToken.length} characters) is registered for this session`,
      );
      const report = await call('POST', '/consent', {
        record: { kind: 'delivery-permission', state: 'granted', source: 'client-report' },
      });
      expectStatus('report-permission', report, 200);
      record('report-permission', 'pass', 'a granted delivery-permission report is recorded');
    }

    // 5. The player turns the topic on.
    const preference = await call('POST', '/consent', {
      record: { kind: 'topic-preference', topic: options.topic, state: 'granted', source: 'player' },
    });
    expectStatus('topic-preference', preference, 200);
    const preferenceRecord = preference.body?.['record'] as JsonObject | undefined;
    if (preferenceRecord?.['kind'] !== 'topic-preference' || preferenceRecord['state'] !== 'granted') {
      fail('topic-preference', 'the answer is not the granted topic-preference record.');
    }
    record('topic-preference', 'pass', `${options.topic} is on for this player`);

    // 6. Set and cancel by key.
    const spareKey = `${reminderKey}-cancel`;
    // Tracked before the request: an answer lost in transit may still have set it.
    pending.add(spareKey);
    const spare = await call('POST', '/reminders', {
      reminder: { key: spareKey, topic: options.topic, fireAt: fireAt(spareReminderSeconds) },
    });
    expectStatus('reminder-cancel', spare, 200);
    const spareStatus = spare.body?.['status'];
    if (spareStatus !== 'scheduled' && spareStatus !== 'replaced') {
      fail(
        'reminder-cancel',
        `a reminder answered ${JSON.stringify(spareStatus)}: ${reminderSetHints[String(spareStatus)] ?? 'see the RFC "Reminders".'}`,
      );
    }
    const cancelled = await call('POST', '/reminders/cancel', { key: spareKey });
    expectStatus('reminder-cancel', cancelled, 200);
    if (cancelled.body?.['cancelled'] !== true) {
      fail('reminder-cancel', 'cancelling a pending reminder did not answer cancelled: true.');
    }
    pending.delete(spareKey);
    record('reminder-cancel', 'pass', 'a pending reminder is set and cancelled by key');

    // 7. The test reminder.
    const due = fireAt(options.fireInSeconds);
    pending.add(reminderKey);
    const reminder = await call('POST', '/reminders', {
      reminder: { key: reminderKey, topic: options.topic, fireAt: due },
    });
    expectStatus('reminder', reminder, 200);
    const reminderStatus = reminder.body?.['status'];
    if (reminderStatus !== 'scheduled' && reminderStatus !== 'replaced') {
      fail(
        'reminder',
        `answered ${JSON.stringify(reminderStatus)}: ${reminderSetHints[String(reminderStatus)] ?? 'see the RFC "Reminders".'}`,
      );
    }
    record('reminder', 'pass', `${reminderKey} fires at ${due}`);

    // 8. The scheduler sends it.
    if (!options.triggerScheduler) {
      record(
        'scheduler',
        'skip',
        options.worker.local
          ? 'not run (--no-scheduler); the run cancels its reminder when it ends, so nothing is left to send.'
          : 'a deployed Worker runs its own cron; the push should arrive within a minute of fireAt.',
      );
    } else {
      const wait = Date.parse(due) - dependencies.now();
      if (wait > 0) {
        print(`     waiting ${Math.ceil(wait / 1000)} s for the reminder to be due`);
        await dependencies.sleep(wait + dueMarginMs);
      }
      const scheduled = await call(
        'GET',
        `${wranglerDevScheduledRoute}?cron=${encodeURIComponent('* * * * *')}`,
        undefined,
        false,
      );
      if (scheduled.status < 200 || scheduled.status >= 300) {
        fail(
          'scheduler',
          `the scheduled route answered ${scheduled.status}: is this wrangler dev 4.x?`,
        );
      }
      // A cancel after the scheduler run answers false once the reminder
      // fired and its send was not held back; true means it stopped what was
      // left: a reminder not yet due, or a send held (quiet hours, the daily
      // cap) or waiting to retry a provider failure.
      const taken = await call('POST', '/reminders/cancel', { key: reminderKey });
      expectStatus('scheduler', taken, 200);
      if (taken.body?.['cancelled'] !== false) {
        if (taken.body?.['cancelled'] === true) {
          pending.delete(reminderKey);
        }
        fail(
          'scheduler',
          'the scheduler did not send the reminder: it was not yet due, held by quiet hours or the daily cap, '
            + 'or waiting to retry a provider failure (read the Worker log). This check cancelled it.',
        );
      }
      pending.delete(reminderKey);
      // Sent is not delivered: a provider refusal shows only in the Worker log.
      record(
        'scheduler',
        'pass',
        'the reminder fired and no held send was left; whether FCM took it is in the Worker log and on the device.',
      );
    }

    // 9. One send through deliverNotification.
    if (options.deliver !== undefined) {
      if (dependencies.deliver === undefined || options.playerId === undefined) {
        record(
          'deliver',
          'skip',
          'deliverNotification is a service-binding RPC, not an HTTP route; the dry run covers it.',
        );
      } else {
        const result = await dependencies.deliver({
          idempotencyKey: `${reminderKey}-deliver`,
          player: options.playerId,
          topic: options.deliver.topic,
          ...(options.deliver.templateData === undefined ? {} : { templateData: options.deliver.templateData }),
        });
        print(`     deliverNotification ${options.deliver.topic} -> ${JSON.stringify(result)}`);
        const answer = deliveryAnswer(result);
        if (answer.status !== 'delivered') {
          fail('deliver', `deliverNotification answered ${JSON.stringify(answer.status)}`);
        }
        // A replay of an earlier run's key answers delivered without a new push.
        const replayed = answer.alreadyProcessed;
        record(
          'deliver',
          replayed ? 'warn' : 'pass',
          replayed
            ? 'deliverNotification answered an earlier send of this key; no new push'
            : 'deliverNotification answered "delivered"',
        );
      }
    }

    // 10. Notices.
    const notices = await call('GET', '/notices');
    expectStatus('notices', notices, 200);
    const listedNotices = listField(notices, 'notices');
    if (listedNotices === undefined) {
      return fail('notices', 'GET /notices answered no notices list.');
    }
    record('notices', 'pass', `${listedNotices.length} notice(s) listed`);
    if (options.advertisingTextVersion !== undefined) {
      const advertising = await call('POST', '/consent', {
        record: {
          kind: 'advertising',
          state: 'granted',
          source: 'player',
          textVersion: options.advertisingTextVersion,
        },
      });
      expectStatus('advertising-consent', advertising, 200);
      const listed = await call('GET', '/notices');
      expectStatus('advertising-notice', listed, 200);
      const notice = (listField(listed, 'notices') ?? []).find((entry) =>
        (entry['record'] as JsonObject | undefined)?.['kind'] === 'advertising');
      if (notice === undefined) {
        record(
          'advertising-notice',
          'warn',
          "no advertising result notice: the deployment's advertisingRules is not kr (or not set).",
        );
      } else {
        const noticeRecord = notice['record'] as JsonObject | undefined;
        const shown = await call('POST', '/notices/shown', {
          // As the client records it: the notice's kind, its record's kind and time, and dueBy.
          notice: {
            kind: notice['kind'],
            record: { kind: noticeRecord?.['kind'], at: noticeRecord?.['at'] },
            dueBy: notice['dueBy'],
          },
          channel: 'in-game',
        });
        expectStatus('advertising-notice', shown, 200);
        const after = await call('GET', '/notices');
        expectStatus('advertising-notice', after, 200);
        const still = (listField(after, 'notices') ?? []).some(
          (entry) => entry['variant'] === notice['variant'],
        );
        if (still) {
          fail('advertising-notice', 'the notice is still listed after it was recorded as shown.');
        }
        record(
          'advertising-notice',
          'pass',
          `${String(notice['variant'])} listed, shown, and gone`,
        );
      }
    }
    completed = true;
  } catch (error) {
    if (!(error instanceof StepFailed)) {
      throw error;
    }
  } finally {
    // 11. Clean-up never fails a run: each step warns at worst. A run that
    // stopped (a failed step or an unexpected error) or a local run without
    // the scheduler cancels the reminders it may have left and unregisters
    // its endpoint, so no push arrives later. A passing run on a deployed
    // Worker keeps both: its cron is meant to send the reminder.
    const keepForCron = completed && !options.worker.local;
    const cleanUp = async (
      name: string,
      route: string,
      body: unknown,
      done: (answer: Answer) => boolean,
    ) => {
      try {
        const answer = await transport('POST', route, body);
        record(name, done(answer) ? 'pass' : 'warn', `answered ${answer.status}`);
      } catch (error) {
        if (!(error instanceof TransportFailed)) {
          throw error;
        }
        record(name, 'warn', error.message);
      }
    };
    if (keepForCron) {
      if (registered !== undefined) {
        record(
          'keep-endpoint',
          'warn',
          'the endpoint this run registered stays, so the deployed cron can send; end the session to remove it.',
        );
      }
    } else {
      for (const key of pending) {
        await cleanUp('cancel-leftover-reminder', '/reminders/cancel', { key }, (answer) =>
          answer.status === 200);
      }
      if (registered !== undefined) {
        await cleanUp(
          'unregister-endpoint',
          '/endpoints/unregister',
          { provider: registered },
          (answer) => answer.status === 200,
        );
      }
    }
  }
  const ok = steps.every((step) => step.result !== 'fail');
  print(ok ? 'Live driver passed.' : 'Live driver failed; see the first FAIL above.');
  return { ok, steps, reminderKey };
}
