import {
  findNotificationCopy,
  notificationNoticeTextIssues,
  type NotificationNoticeVariant,
  type NotificationResolvedCopy,
  type NotificationTemplateData,
  type NotificationTopicCopy,
  type NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

/**
 * Server-side copy for remote sends (notifications v2 RFC, "Remote copy",
 * open question 4). A send's title and body come from a copy resolver: by
 * default the catalog's `copy` for the recipient's locale
 * (`resolveCatalogNotificationCopy`), or a project's own resolver passed to
 * `createNotificationService` as `resolveCopy`. The service asks the
 * resolver only where the content comes from copy
 * (`notificationContentSource` is `catalog`): a target mapping's own title
 * and body (Devvit) and a host template (Apps in Toss) never reach it.
 *
 * The text never comes from the request: a send or a reminder carries no
 * title or body, only template data for the `{{name}}` placeholders of the
 * text the resolver answers. The policy gate then renders the answer exactly
 * as it renders catalog copy, so under the Korean rules an advertising send
 * still gets the `(광고)` label, the sender line, the opt-out line, and the
 * opt-out action.
 */

/** What a copy resolver is asked: one topic, for one recipient's locale, on one provider. */
export interface NotificationCopyResolverInput {
  /**
   * The topic as declared for the recipient's target, with its mapping and
   * its catalog `copy`; for a consent notice, the notice topic with the
   * variant's `notices.copy` as its `copy`.
   */
  readonly topic: NotificationTopicDeclaration;
  /** The provider the send goes through. */
  readonly provider: string;
  /**
   * The send's locale, else the recipient's registered locale; absent when
   * neither names one. A resolver falls back from it as the catalog lookup
   * does: the exact locale, then its language, then `defaultLocale`.
   */
  readonly locale?: string;
  /** The catalog's `defaultLocale`. */
  readonly defaultLocale: string;
  /**
   * The send's template data, which fills the answer's placeholders after
   * the resolver answers. It may come from a player's reminder: a resolver
   * must not copy it into the text it answers.
   */
  readonly templateData?: NotificationTemplateData;
  /** Set for a consent notice the scheduler pushes: the variant whose text it sends. */
  readonly notice?: { readonly variant: NotificationNoticeVariant };
}

/**
 * Chooses the title and body templates of one send for one locale, or
 * answers `undefined` when it has none: the send is then skipped as
 * `unavailable: copy-missing`, never sent with empty text. The answer's
 * `{{name}}` placeholders are filled from the send's template data, as
 * catalog copy is. A resolver that throws fails the attempt as a host
 * that cannot answer does, and the send is retried.
 */
export type NotificationCopyResolver = (
  input: NotificationCopyResolverInput,
) => NotificationTopicCopy | undefined | Promise<NotificationTopicCopy | undefined>;

/**
 * The default resolver: the topic's catalog `copy` for the locale, then its
 * language (`en` for `en-US`), then the catalog's `defaultLocale`, each
 * matched without regard to case (`findNotificationCopy`). A project's
 * resolver can fall back to it for the topics or locales it does not cover:
 * `(input) => mine(input) ?? resolveCatalogNotificationCopy(input)`.
 */
export const resolveCatalogNotificationCopy: NotificationCopyResolver = (input) =>
  findNotificationCopy(input.topic, input.locale, input.defaultLocale);

/** A resolver's answer as a send uses it, with why an answer was not usable. */
export interface NotificationCopyResolution extends NotificationResolvedCopy {
  /** Set when the resolver answered something that cannot be sent; `copy` is then absent. */
  readonly issue?: string;
}

/**
 * Asks `resolver` once and checks the answer: a title and a body that are
 * strings and not blank, and for a consent notice the notice text rules
 * (`notificationNoticeTextIssues`: only `{{consentDate}}`, which one of them
 * uses). An answer that fails is no copy, with the reason in `issue`. The
 * result's `copy` is what the gate takes as `resolvedCopy`.
 */
export async function resolveNotificationCopy(
  resolver: NotificationCopyResolver,
  input: NotificationCopyResolverInput,
): Promise<NotificationCopyResolution> {
  const answer: unknown = await resolver(input);
  if (answer === undefined || answer === null) {
    return {};
  }
  const issue = copyIssue(answer, input);
  if (issue !== undefined) {
    return { issue };
  }
  const { title, body } = answer as NotificationTopicCopy;
  return { copy: { title, body } };
}

/**
 * Resolves one topic for several locales, asking `resolver` once per
 * distinct locale (an absent locale counts as one): a bulk send groups its
 * recipients by locale and sends each group the copy resolved for it. The
 * map is keyed by the locales as given.
 */
export async function resolveNotificationCopyByLocale(
  resolver: NotificationCopyResolver,
  input: Omit<NotificationCopyResolverInput, 'locale'> & {
    readonly locales: Iterable<string | undefined>;
  },
): Promise<Map<string | undefined, NotificationCopyResolution>> {
  const { locales, ...shared } = input;
  const resolved = new Map<string | undefined, NotificationCopyResolution>();
  for (const locale of locales) {
    if (!resolved.has(locale)) {
      resolved.set(
        locale,
        await resolveNotificationCopy(resolver, {
          ...shared,
          ...(locale === undefined ? {} : { locale }),
        }),
      );
    }
  }
  return resolved;
}

function copyIssue(answer: unknown, input: NotificationCopyResolverInput): string | undefined {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return 'the copy resolver answered something other than a title and a body';
  }
  const { title, body } = answer as Readonly<Record<string, unknown>>;
  if (typeof title !== 'string' || typeof body !== 'string') {
    return 'the copy resolver answered no string title and body';
  }
  if (title.trim().length === 0 || body.trim().length === 0) {
    return 'the copy resolver answered a blank title or body';
  }
  if (input.notice !== undefined) {
    const issues = notificationNoticeTextIssues({ title, body }, input.notice.variant);
    if (issues.length > 0) {
      return `the copy resolver's notice text breaks the notice rules: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`;
    }
  }
  return undefined;
}
