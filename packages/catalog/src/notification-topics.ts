import type { tags } from 'typia';

import {
  findNotificationCopy,
  notificationNoticeCopyIssues,
  notificationProviderCarriesNotices,
  notificationTopicDefinitionIssues,
  notificationTopicNeedsNoAgreement,
  resolveNotificationAdvertisingSettings,
  type NotificationDeployment,
  type NotificationNoticeCopy,
  type NotificationProviderRegistryEntry,
  type NotificationTopicDeclaration,
  type NotificationTopicDefinition,
  type NotificationTopicMapping,
} from '@mpgd/platform/notifications';

import {
  validateNotificationTopicCatalogShape,
  type NotificationTopicCatalog as NotificationTopicCatalogShape,
} from './notification-topics-shape.js';

export { isRootRelativeNotificationRoute } from '@mpgd/platform/notifications';

/**
 * The notification topic catalog a game declares (notifications v2 RFC,
 * "Topic catalog"): every topic with its purpose, channels, routes, copy per
 * locale, and one open-keyed mapping per target. The kit does not decide a
 * topic's purpose; it records and enforces what the game declares.
 */
export interface NotificationTopicCatalogEntry extends NotificationTopicDefinition {
  /** Mapping per open target name, read by the provider that target enables. */
  readonly targets?: Readonly<Record<string, NotificationTopicMapping>>;
}

/**
 * The consent notices the server sends; a backend takes the block as is, as
 * its `NotificationNoticeSettings`.
 */
export interface NotificationTopicCatalogNotices {
  /**
   * The `service` topic the server sends overdue consent notices through
   * when the deployment applies the Korean advertising rules. It keeps only
   * the delivery settings and declares no copy: its text is `copy` below.
   */
  readonly topic: string & tags.MinLength<1>;
  /**
   * Per locale, a title and a body for each notice variant
   * (`notificationNoticeVariants`), so a notice says whether the player
   * consented, refused, or withdrew, and to advertising or night sending. A
   * refusal's text is optional: without it a refusal is given in the
   * withdrawal's. The only placeholder is `{{consentDate}}`, the record's
   * Asia/Seoul date, which each variant uses; the text carries the rest of
   * what the decree requires, the sender's name and, for a result notice
   * (art. 62-2), the processing result or, for a re-confirmation
   * (art. 62-3(2)), how to keep or withdraw the consent.
   */
  readonly copy: NotificationNoticeCopy;
}

export interface NotificationTopicCatalog {
  readonly version: string & tags.MinLength<1>;
  /**
   * The locale every topic's `copy`, and `notices.copy`, must include,
   * matched without regard to case, and used when no other locale fits.
   */
  readonly defaultLocale: string & tags.MinLength<1>;
  readonly notices?: NotificationTopicCatalogNotices;
  readonly topics: readonly NotificationTopicCatalogEntry[];
}

export interface NotificationTopicCatalogIssue {
  /** Where the issue is, for example `topics[2].optOutRoute`. */
  readonly path: string;
  readonly message: string;
}

export interface NotificationTopicCatalogValidationOptions {
  /**
   * The provider registry entry each target name enables. A target with an
   * entry has its mappings checked against the entry's mapping rules and
   * purposes. Another target name is open: no provider's rules apply to its
   * mappings, but the catalog's own rules still do, such as no title or body
   * in the notice topic's mapping, and under the Korean rules the notice
   * topic on every target that delivers advertising.
   */
  readonly targetProviders?: Readonly<Record<string, NotificationProviderRegistryEntry>>;
  /**
   * The backend deployment settings the catalog is released with. A catalog
   * with an `advertising` topic needs them, with `advertisingRules`.
   */
  readonly deployment?: NotificationDeployment;
}

export type NotificationTopicCatalogValidation =
  | {
      readonly valid: true;
      readonly catalog: NotificationTopicCatalog;
      readonly issues: readonly NotificationTopicCatalogIssue[];
    }
  | { readonly valid: false; readonly issues: readonly NotificationTopicCatalogIssue[] };

/**
 * Validates a topic catalog and reports every issue it finds:
 *
 * - the shape (unknown keys are rejected, and each target's mapping is an
 *   object);
 * - each topic's own rules from `notificationTopicDefinitionIssues` in
 *   `@mpgd/platform/notifications`: a trimmed id that is not `__proto__`,
 *   channels that do not repeat, no `local` channel for `advertising`,
 *   `route` and `optOutRoute` that stay on the game's origin and never resolve
 *   to a protocol-relative path, as written or once percent-decoded (no `//`
 *   prefix, backslash, control character, or dot segment, percent-encoded
 *   dots included), an `optOutRoute` for `advertising`, and quiet hours that
 *   do not start and end at the same time;
 * - topic ids are unique, and every `copy` includes `defaultLocale` (matched
 *   without regard to case, as `findNotificationCopy` matches it);
 * - the notices: `notices.topic` names a declared `service` topic with the
 *   `remote` channel that keeps only the delivery settings (no `local`
 *   channel, no `copy`, no `title` or `body` in a mapping, not even one
 *   alone, and no provider that sends a host template or its mapping's own
 *   text, which could not state the record), and `notices.copy` follows
 *   `notificationNoticeCopyIssues` in `@mpgd/platform/notifications`: it
 *   includes `defaultLocale`, matched the same way, and gives every locale a
 *   title and a body for each of `notificationNoticeVariants` (a refusal's
 *   optional), none blank, with `{{consentDate}}` in one of them and no other
 *   placeholder or brace;
 * - for a target with a provider entry: each mapping field follows its rule
 *   (required, a string within `maxLength` Unicode code points, one of
 *   `values`, matching `pattern`, which the `u` flag reads; a pattern that
 *   does not compile is an issue too), a mapping that needs no host agreement
 *   (`agreement: 'none'`) belongs to a `service` topic and never to a
 *   `per-send` provider, which needs an acceptance for each send, a topic
 *   with the `remote` channel maps only to a provider whose `purposes`
 *   include its purpose, an `advertising` topic maps only to a provider that
 *   delivers advertising as free-form content (under the Korean rules, also
 *   with an expiry and actions, and able to carry the notice topic), and a
 *   topic on a free-form provider has its own text: `copy`, or a `title` and
 *   a `body` in the mapping, except the notice topic, whose text is
 *   `notices.copy`;
 * - given an `advertising` topic, the deployment settings: `advertisingRules`,
 *   and under `kr` the catalog's notice topic, mapped on every target that
 *   maps an advertising topic, and the advertising sender and opt-out line as
 *   gate step 8 reads them (`resolveNotificationAdvertisingSettings`): a
 *   contact, and no blank contact, name, or opt-out line.
 *
 * Issue paths spell locale and variant keys in brackets, such as
 * `notices.copy["ko-KR"]["reconfirmation.night"].title`.
 */
export function validateNotificationTopicCatalog(
  input: unknown,
  options: NotificationTopicCatalogValidationOptions = {},
): NotificationTopicCatalogValidation {
  const shape = validateNotificationTopicCatalogShape(input);
  if (!shape.success) {
    return {
      valid: false,
      issues: shape.errors.map((error) => ({
        path: bracketLocales(error.path.replace(/^\$input\.?/u, '')) || '(catalog)',
        message: `expected ${error.expected}`,
      })),
    };
  }
  const catalog = shape.data;
  const targetProviders = options.targetProviders ?? {};
  const rules = options.deployment?.advertisingRules;
  const noticeTopic = catalog.notices?.topic;
  const issues: NotificationTopicCatalogIssue[] = [];
  const ids = new Map<string, number>();
  catalog.topics.forEach((topic, index) => {
    const at = `topics[${index}]`;
    issues.push(...notificationTopicDefinitionIssues(topic, at));
    const previous = ids.get(topic.id);
    if (previous !== undefined) {
      issues.push({ path: `${at}.id`, message: `duplicates the id of topics[${previous}]: ${topic.id}` });
    } else {
      ids.set(topic.id, index);
    }
    // The same lookup a send makes: a locale matches a copy key without regard to case.
    if (topic.copy !== undefined && findNotificationCopy(topic, undefined, catalog.defaultLocale) === undefined) {
      issues.push({
        path: `${at}.copy`,
        message: `copy must include the default locale ${catalog.defaultLocale}`,
      });
    }
    // The shape check lets a locale's value be undefined, which a send would
    // find before the language or the default locale.
    for (const [locale, text] of Object.entries(topic.copy ?? {})) {
      if (text === undefined) {
        issues.push({
          path: `${at}.copy[${JSON.stringify(locale)}]`,
          message: 'expected NotificationTopicCopy, a title and a body',
        });
      }
    }
    for (const [target, mapping] of Object.entries(topic.targets ?? {})) {
      // The shape check lets a target's value be undefined.
      if (mapping === undefined) {
        issues.push({
          path: `${at}.targets.${target}`,
          message: 'expected NotificationTopicMapping, an object: {} maps a target that needs no fields',
        });
        continue;
      }
      const provider = providerFor(targetProviders, target);
      if (provider !== undefined) {
        issues.push(...mappingIssues(
          { at: `${at}.targets.${target}`, target },
          topic,
          mapping,
          provider,
          rules,
          topic.id === noticeTopic,
        ));
      }
    }
  });
  issues.push(...noticeIssues(catalog, ids, targetProviders));
  issues.push(...deploymentIssues(catalog, options.deployment, targetProviders));
  // With no issue, `notices.copy` has every variant for every locale: the
  // catalog has the declared type.
  return issues.length === 0
    ? { valid: true, catalog: catalog as NotificationTopicCatalog, issues }
    : { valid: false, issues };
}

/** Validates a topic catalog and throws one error listing every issue. */
export function assertNotificationTopicCatalog(
  input: unknown,
  options: NotificationTopicCatalogValidationOptions = {},
): NotificationTopicCatalog {
  const result = validateNotificationTopicCatalog(input, options);
  if (!result.valid) {
    throw new Error(
      `Invalid notification topic catalog:\n${result.issues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  return result.catalog;
}

/**
 * The catalog resolved for one target: the topics that map to it, each with
 * that target's mapping, as providers, the runtime, and the policy gate read
 * them. A topic without a mapping for the target is not available there.
 */
export function resolveNotificationTopicsForTarget(
  catalog: NotificationTopicCatalog,
  target: string,
): readonly NotificationTopicDeclaration[] {
  const declarations: NotificationTopicDeclaration[] = [];
  for (const { targets, ...definition } of catalog.topics) {
    if (targets !== undefined && Object.prototype.hasOwnProperty.call(targets, target)) {
      const mapping = targets[target];
      declarations.push(mapping === undefined ? definition : { ...definition, mapping });
    }
  }
  return declarations;
}

function mappingIssues(
  { at, target }: { readonly at: string; readonly target: string },
  topic: NotificationTopicCatalogEntry,
  mapping: NotificationTopicMapping,
  provider: NotificationProviderRegistryEntry,
  rules: NotificationDeployment['advertisingRules'],
  noticeTopic: boolean,
): NotificationTopicCatalogIssue[] {
  // A notice says what the player did, which only notices.copy can say: a
  // provider that sends a host template, or its mapping's own approved text,
  // cannot carry it, so its mapping rules do not apply either.
  if (noticeTopic && sendsOwnText(provider)) {
    const text = provider.content === 'host-template'
      ? 'its own template'
      : 'the text of its mapping';
    return [{
      path: at,
      message: `${provider.provider} sends ${text}, which cannot state what the player did; the notice topic must not map to it`,
    }];
  }
  const issues: NotificationTopicCatalogIssue[] = [];
  for (const [field, rule] of Object.entries(provider.mapping)) {
    const path = `${at}.${field}`;
    const value = Object.prototype.hasOwnProperty.call(mapping, field) ? mapping[field] : undefined;
    if (value === undefined) {
      if (rule.required) {
        issues.push({ path, message: `${provider.provider} needs ${field}` });
      }
      continue;
    }
    if (typeof value !== 'string') {
      issues.push({ path, message: `${provider.provider} reads ${field} as a string` });
      continue;
    }
    if (rule.required && value.trim().length === 0) {
      issues.push({ path, message: `${provider.provider} needs a non-empty ${field}` });
    }
    const length = [...value].length;
    if (rule.maxLength !== undefined && length > rule.maxLength) {
      issues.push({
        path,
        message: `${provider.provider} accepts at most ${rule.maxLength} characters in ${field}; got ${length}`,
      });
    }
    if (rule.values !== undefined && !rule.values.includes(value)) {
      issues.push({
        path,
        message: `${provider.provider} accepts ${field} ${rule.values.map((accepted) => JSON.stringify(accepted)).join(' or ')}; got ${JSON.stringify(value)}`,
      });
    }
    if (rule.pattern !== undefined) {
      const pattern = compileMappingPattern(rule.pattern);
      if (pattern === undefined) {
        issues.push({
          path,
          message: `${provider.provider}'s pattern for ${field} does not compile with the u flag: ${rule.pattern}`,
        });
      } else if (!pattern.test(value)) {
        issues.push({
          path,
          message: `${provider.provider} needs ${field} to match ${rule.pattern}; got ${JSON.stringify(value)}`,
        });
      }
    }
  }
  // Only a service template may skip the host agreement: the console sends
  // payment and refund messages without one, never a requested or
  // advertising message.
  if (notificationTopicNeedsNoAgreement({ mapping }) && topic.purpose !== 'service') {
    issues.push({
      path: `${at}.agreement`,
      message: `only a service topic's template may need no agreement; ${topic.id} is ${topic.purpose}`,
    });
  }
  // Such a topic never prompts, so a per-send provider would never get the
  // acceptance each send needs, and gate step 3 would refuse every send.
  if (notificationTopicNeedsNoAgreement({ mapping }) && provider.permission.allowance === 'per-send') {
    issues.push({
      path: `${at}.agreement`,
      message: `${provider.provider} needs the player's acceptance for each send, which a topic that needs no agreement never asks for`,
    });
  }
  // Gate step 1 refuses a send whose purpose the provider does not deliver,
  // and advertising unless the provider delivers it as free-form content,
  // which can carry the label and the sender, and under the Korean rules with
  // an expiry and the opt-out action.
  if (topic.purpose === 'advertising') {
    if (!provider.purposes.includes('advertising') || provider.content !== 'free-form') {
      issues.push({
        path: at,
        message: `${provider.provider} does not deliver advertising as free-form content; an advertising topic must not map to it`,
      });
    } else if (rules === 'kr' && (!provider.expiry || !provider.actions)) {
      issues.push({
        path: at,
        message: `${provider.provider} cannot carry the expiry and the opt-out action the Korean advertising rules need`,
      });
    } else if (rules === 'kr' && sendsOwnText(provider)) {
      // The notice topic cannot map here, so this is reported once, here,
      // instead of as a notice topic missing from the target.
      issues.push({
        path: at,
        message: `${provider.provider} sends the text of its mapping, so it cannot carry the consent notices that advertising on ${target} needs under the Korean rules; an advertising topic must not map to it`,
      });
    }
  } else if (topic.channels.includes('remote') && !provider.purposes.includes(topic.purpose)) {
    // A local-only topic is never sent remotely, so the remote purposes do not apply to it.
    issues.push({
      path: at,
      message: `${provider.provider} does not deliver ${topic.purpose} topics; a ${topic.purpose} topic with the remote channel must not map to it`,
    });
  }
  // A free-form provider sends, and a local notification shows, the topic's
  // own text: the mapping's title and body, else the copy. Without either a
  // send has nothing to say and a local reminder answers `unavailable`. The
  // notice topic's text is `notices.copy`.
  if (
    provider.content === 'free-form'
    && !noticeTopic
    && topic.copy === undefined
    && !(typeof mapping['title'] === 'string' && typeof mapping['body'] === 'string')
  ) {
    issues.push({
      path: at,
      message: `${provider.provider} shows the topic's own text; declare copy, or a title and a body in this mapping`,
    });
  }
  return issues;
}

/**
 * Whether a provider cannot carry a consent notice
 * (`notificationProviderCarriesNotices`): it sends a host template, or a
 * title and a body that its mapping must carry.
 */
function sendsOwnText(provider: NotificationProviderRegistryEntry): boolean {
  return !notificationProviderCarriesNotices(provider)
    || provider.mapping['title']?.required === true
    || provider.mapping['body']?.required === true;
}

/** The registry entry a target name enables; `undefined` for an open target. */
function providerFor(
  targetProviders: Readonly<Record<string, NotificationProviderRegistryEntry>>,
  target: string,
): NotificationProviderRegistryEntry | undefined {
  return Object.prototype.hasOwnProperty.call(targetProviders, target)
    ? targetProviders[target]
    : undefined;
}

/** A typia path with a topic's `copy` locale key in brackets, as the notice rules spell it. */
function bracketLocales(path: string): string {
  return path.replace(
    /^(topics\[\d+\]\.copy)\.([A-Za-z_$][\w$]*)/u,
    (_match, copy: string, locale: string) => `${copy}[${JSON.stringify(locale)}]`,
  );
}

/** A registry pattern as the `u` flag reads it, or `undefined` when it does not compile. */
function compileMappingPattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return undefined;
  }
}

/** The notices block: the topic that delivers them, and their copy per variant. */
function noticeIssues(
  catalog: NotificationTopicCatalogShape,
  ids: ReadonlyMap<string, number>,
  targetProviders: Readonly<Record<string, NotificationProviderRegistryEntry>>,
): NotificationTopicCatalogIssue[] {
  if (catalog.notices === undefined) {
    return [];
  }
  return [
    ...noticeTopicIssues(catalog, catalog.notices.topic, ids, targetProviders),
    ...notificationNoticeCopyIssues(catalog.notices.copy, catalog.defaultLocale),
  ];
}

/**
 * `notices.topic` names a declared `service` topic the server can send, which
 * keeps only the delivery settings: its text is `notices.copy`.
 */
function noticeTopicIssues(
  catalog: NotificationTopicCatalogShape,
  id: string,
  ids: ReadonlyMap<string, number>,
  targetProviders: Readonly<Record<string, NotificationProviderRegistryEntry>>,
): NotificationTopicCatalogIssue[] {
  const index = ids.get(id);
  const topic = index === undefined ? undefined : catalog.topics[index];
  if (topic === undefined) {
    return [{ path: 'notices.topic', message: `names no declared topic: ${id}` }];
  }
  if (topic.purpose !== 'service' || !topic.channels.includes('remote')) {
    return [{
      path: 'notices.topic',
      message: `consent notices are service notifications the server sends; ${topic.id} must be a service topic with the remote channel`,
    }];
  }
  const at = `topics[${index}]`;
  const issues: NotificationTopicCatalogIssue[] = [];
  // Only the server sends a notice; a local reminder of it would have no text.
  if (topic.channels.includes('local')) {
    issues.push({
      path: `${at}.channels`,
      message: 'only the server sends consent notices; the notice topic declares no local channel',
    });
  }
  if (topic.copy !== undefined) {
    issues.push({
      path: `${at}.copy`,
      message: `the notice topic's text is notices.copy, one per notice variant; ${topic.id} declares no copy of its own`,
    });
  }
  // The notice topic's mappings carry no text, so nothing can stand in for
  // notices.copy: not a title or a body, and not one of them alone. A
  // provider that needs them is reported with the mapping rules.
  for (const [target, mapping] of Object.entries(topic.targets ?? {})) {
    const provider = providerFor(targetProviders, target);
    if (mapping === undefined || (provider !== undefined && sendsOwnText(provider))) {
      continue;
    }
    for (const field of ['title', 'body'] as const) {
      if (mapping[field] !== undefined) {
        issues.push({
          path: `${at}.targets.${target}.${field}`,
          message: `the notice topic's text is notices.copy, so its mappings carry no title or body, not even one alone; remove ${field}`,
        });
      }
    }
  }
  return issues;
}

/** The deployment settings an advertising topic needs. */
function deploymentIssues(
  catalog: NotificationTopicCatalogShape,
  deployment: NotificationDeployment | undefined,
  targetProviders: Readonly<Record<string, NotificationProviderRegistryEntry>>,
): NotificationTopicCatalogIssue[] {
  const issues: NotificationTopicCatalogIssue[] = [];
  if (!catalog.topics.some((topic) => topic.purpose === 'advertising')) {
    return issues;
  }
  if (deployment?.advertisingRules === undefined) {
    issues.push({
      path: 'deployment.advertisingRules',
      message: "a catalog with an advertising topic needs the deployment's advertisingRules: 'kr' or 'none'",
    });
    return issues;
  }
  if (deployment.advertisingRules === 'kr') {
    const noticeTopic = catalog.notices === undefined
      ? undefined
      : catalog.topics.find((topic) => topic.id === catalog.notices?.topic);
    if (catalog.notices === undefined) {
      issues.push({
        path: 'notices.topic',
        message: 'the Korean advertising rules send overdue consent notices through a service topic; declare notices.topic',
      });
    } else if (noticeTopic !== undefined) {
      // A target that delivers advertising also delivers its notices. A
      // provider that cannot carry them is reported at the advertising mapping.
      const unmapped = new Set<string>();
      for (const topic of catalog.topics) {
        if (topic.purpose !== 'advertising') {
          continue;
        }
        for (const target of Object.keys(topic.targets ?? {})) {
          const provider = providerFor(targetProviders, target);
          if (
            !Object.prototype.hasOwnProperty.call(noticeTopic.targets ?? {}, target)
            && !(provider !== undefined && sendsOwnText(provider))
          ) {
            unmapped.add(target);
          }
        }
      }
      for (const target of unmapped) {
        issues.push({
          path: 'notices.topic',
          message: `${noticeTopic.id} has no mapping for ${target}, which delivers an advertising topic and so its consent notices`,
        });
      }
    }
    // The sender and the opt-out line as gate step 8 reads them.
    issues.push(...resolveNotificationAdvertisingSettings(deployment).issues);
  }
  return issues;
}
