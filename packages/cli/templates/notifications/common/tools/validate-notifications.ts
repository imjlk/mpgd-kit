import { readFileSync } from 'node:fs';

import { validateNotificationTopicCatalog } from '@mpgd/catalog';
import {
  assertNotificationDeployment,
  referenceNotificationProviders,
  referenceNotificationTargetProviders,
} from '@mpgd/platform/notifications';

// Checks notifications/topics.json against the notifications v2 rules, the
// providers each target enables (android and ios: FCM, ait: Apps in Toss,
// reddit: Devvit), and notifications/deployment.json, the settings the game
// backend takes as MPGD_NOTIFICATIONS_DEPLOYMENT. Run it before every
// release: `pnpm validate:notifications`.

const gameRoot = new URL('../', import.meta.url);
const placeholder = 'REPLACE-WITH-';

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, gameRoot), 'utf8')) as unknown;
}

const deployment = assertNotificationDeployment(readJson('notifications/deployment.json'));
const result = validateNotificationTopicCatalog(readJson('notifications/topics.json'), {
  targetProviders: Object.fromEntries(
    Object.entries(referenceNotificationTargetProviders).map(([target, provider]) => [
      target,
      referenceNotificationProviders[provider],
    ]),
  ),
  deployment,
});
const problems = result.issues.map((issue) => `${issue.path}: ${issue.message}`);
// Under the Korean rules every advertising push names its sender's phone
// number or address; the starter ships a placeholder that must be replaced.
if (JSON.stringify(deployment).includes(placeholder)) {
  problems.push(
    `notifications/deployment.json: replace the ${placeholder}... value with the sender's real contact `
      + '(a phone number or an address), which every advertising push carries.',
  );
}
if (!result.valid || problems.length > 0) {
  console.error(
    `Notification settings are not ready:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  );
  process.exitCode = 1;
} else {
  console.info(
    `Notification topics: ${result.catalog.topics.length}; advertising rules: ${deployment.advertisingRules ?? 'none'}.`,
  );
}
