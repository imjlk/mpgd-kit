import { readFileSync } from 'node:fs';

import { validateNotificationTopicCatalog } from '@mpgd/catalog';
import {
  assertNotificationDeployment,
  notificationDeploymentPlaceholders,
  referenceNotificationProviders,
  referenceNotificationTargetProviders,
  type NotificationDeployment,
} from '@mpgd/platform/notifications';

// Checks notifications/topics.json against the notifications v2 rules, the
// providers each target enables (android and ios: FCM, ait: Apps in Toss,
// reddit: Devvit), and notifications/deployment.json, the settings the game
// backend takes as MPGD_NOTIFICATIONS_DEPLOYMENT. Run it before every
// release: `pnpm validate:notifications`.

const gameRoot = new URL('../', import.meta.url);

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, gameRoot), 'utf8')) as unknown;
}

const problems: string[] = [];
let deployment: NotificationDeployment | undefined;
try {
  // Placeholders are reported below, so the catalog is still checked against
  // the deployment's rules in the same run.
  deployment = assertNotificationDeployment(readJson('notifications/deployment.json'), {
    allowPlaceholders: true,
  });
} catch (error) {
  problems.push(
    `notifications/deployment.json: ${error instanceof Error ? error.message : String(error)}`,
  );
}
// Under the Korean rules every advertising push names its sender and their
// phone number or address; the starter ships a placeholder contact. The game
// backend refuses a placeholder too (`assertNotificationDeployment`), so a
// Worker given this file would not start its notifications.
for (const field of deployment === undefined
  ? []
  : notificationDeploymentPlaceholders(deployment)) {
  problems.push(
    field === 'advertisingSender.contact'
      ? `notifications/deployment.json: replace the ${field} placeholder with the sender's real contact `
        + '(a phone number or an address), which every advertising push carries.'
      : `notifications/deployment.json: replace the ${field} placeholder with the real value.`,
  );
}
const result = validateNotificationTopicCatalog(readJson('notifications/topics.json'), {
  targetProviders: Object.fromEntries(
    Object.entries(referenceNotificationTargetProviders).map(([target, provider]) => [
      target,
      referenceNotificationProviders[provider],
    ]),
  ),
  ...(deployment === undefined ? {} : { deployment }),
});
// A refused deployment is reported above, not again as a missing one.
problems.unshift(
  ...result.issues
    .filter((issue) => deployment !== undefined || !issue.path.startsWith('deployment.'))
    .map((issue) => `${issue.path}: ${issue.message}`),
);
if (!result.valid || problems.length > 0) {
  console.error(
    `Notification settings are not ready:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  );
  process.exitCode = 1;
} else {
  console.info(
    `Notification topics: ${result.catalog.topics.length}; advertising rules: ${deployment?.advertisingRules ?? 'none'}.`,
  );
}
