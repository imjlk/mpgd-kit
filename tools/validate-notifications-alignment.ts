import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { notificationsProtocolVersion } from '@mpgd/platform/notifications';
import {
  assertNotificationConformanceVector,
  notificationConformanceVectorNameOf,
} from '@mpgd/platform/notifications-vectors';

import { isCliEntrypoint, readJsonFile } from './io';
import {
  notificationsSchemaDirectory,
  notificationsSchemaRegenerateCommand,
  renderNotificationsSchemaFiles,
} from './notifications/generate-notifications-schemas';

export const notificationsVectorDirectory = 'docs/specs/notifications/vectors';

export interface NotificationsAlignmentReport {
  readonly protocolVersion: string;
  readonly vectors: readonly string[];
  readonly schemaFiles: readonly string[];
}

/**
 * Checks that the notifications protocol constant, every conformance vector
 * (shape, file name, protocol, and its own `appliesTo`), and the committed
 * JSON Schemas agree. It reads source only; no package build runs.
 */
export function validateNotificationsAlignment(input: {
  readonly vectorDirectory?: string;
  readonly schemaDirectory?: string;
} = {}): NotificationsAlignmentReport {
  const vectorDirectory = input.vectorDirectory ?? notificationsVectorDirectory;
  const schemaDirectory = input.schemaDirectory ?? notificationsSchemaDirectory;
  const failures: string[] = [];

  const vectorFiles = readdirSync(vectorDirectory).filter((file) => file.endsWith('.json')).sort();
  if (vectorFiles.length === 0) {
    failures.push(`No conformance vectors found in ${vectorDirectory}.`);
  }
  const vectors: string[] = [];
  for (const file of vectorFiles) {
    const path = join(vectorDirectory, file);
    try {
      const vector = assertNotificationConformanceVector(readJsonFile(path));
      const expectedName = notificationConformanceVectorNameOf(file);
      if (vector.vector !== expectedName) {
        failures.push(
          `${path}: vector name ${vector.vector} must equal the file name ${expectedName}.`,
        );
      }
      if (vector.protocol !== notificationsProtocolVersion) {
        failures.push(
          `${path}: protocol ${vector.protocol} must equal notificationsProtocolVersion `
            + `${notificationsProtocolVersion}.`,
        );
      }
      vectors.push(vector.vector);
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const rendered = renderNotificationsSchemaFiles();
  const changed: string[] = [];
  for (const file of rendered) {
    const path = join(schemaDirectory, file.fileName);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== file.content) {
      changed.push(file.fileName);
      continue;
    }
    const document = readJsonFile(path) as Readonly<Record<string, unknown>>;
    const version = file.fileName === 'index.json'
      ? document.protocolVersion
      : document['x-mpgd-protocol-version'];
    if (version !== notificationsProtocolVersion) {
      failures.push(
        `${path}: schema protocol version ${String(version)} must equal `
          + `${notificationsProtocolVersion}.`,
      );
    }
  }
  const expectedFiles = new Set(rendered.map((file) => file.fileName));
  const stale = existsSync(schemaDirectory)
    ? readdirSync(schemaDirectory).filter(
        (file) => file.endsWith('.json') && !expectedFiles.has(file),
      )
    : [];
  if (changed.length > 0 || stale.length > 0) {
    failures.push(
      `Notifications schemas in ${schemaDirectory} are out of date `
        + `(changed: ${changed.join(', ') || 'none'}; stale: ${stale.join(', ') || 'none'}). `
        + `Run ${notificationsSchemaRegenerateCommand} and commit the result.`,
    );
  }

  if (failures.length > 0) {
    throw new Error(`Notifications v2 alignment failed:\n- ${failures.join('\n- ')}`);
  }
  return {
    protocolVersion: notificationsProtocolVersion,
    vectors,
    schemaFiles: rendered.map((file) => file.fileName),
  };
}

if (isCliEntrypoint(import.meta.url)) {
  const report = validateNotificationsAlignment();
  console.info(
    `Notifications v2 alignment ${report.protocolVersion}: ${report.vectors.length} vectors, `
      + `${report.schemaFiles.length} schema files`,
  );
}
