import typia, { type IValidation } from 'typia';

import type {
  NotificationTopicCatalog as DeclaredCatalog,
  NotificationTopicCatalogNotices as DeclaredNotices,
} from './notification-topics.js';

/*
 * The topic catalog as the shape check reads it. The types keep the public
 * names, so a shape issue names the type a game writes against.
 * `notices.copy` is left to `notificationNoticeCopyIssues`, which reports a
 * missing, misnamed, or blank variant by name, with every other issue.
 */

export interface NotificationTopicCatalogNotices extends Omit<DeclaredNotices, 'copy'> {
  readonly copy: unknown;
}

export interface NotificationTopicCatalog extends Omit<DeclaredCatalog, 'notices'> {
  readonly notices?: NotificationTopicCatalogNotices;
}

const validateShape = typia.createValidateEquals<NotificationTopicCatalog>();

export function validateNotificationTopicCatalogShape(
  input: unknown,
): IValidation<NotificationTopicCatalog> {
  return validateShape(input);
}
