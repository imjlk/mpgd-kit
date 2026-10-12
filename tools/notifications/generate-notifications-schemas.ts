import typia from 'typia';

import {
  notificationsProtocol,
  notificationsProtocolVersion,
  type LocalNotificationRequest,
  type LocalScheduleResult,
  type NotificationBridgeCancelLocalPayload,
  type NotificationBridgeCancelLocalResult,
  type NotificationBridgeGetCapabilitiesPayload,
  type NotificationBridgeGetCapabilitiesResult,
  type NotificationBridgeGetPermissionPayload,
  type NotificationBridgeGetPermissionResult,
  type NotificationBridgeListLocalPayload,
  type NotificationBridgeListLocalResult,
  type NotificationBridgeOpenSettingsPayload,
  type NotificationBridgeOpenSettingsResult,
  type NotificationBridgeRegisterPayload,
  type NotificationBridgeRegisterResult,
  type NotificationBridgeRequestPermissionPayload,
  type NotificationBridgeRequestPermissionResult,
  type NotificationBridgeRevokePermissionPayload,
  type NotificationBridgeRevokePermissionResult,
  type NotificationBridgeScheduleLocalPayload,
  type NotificationBridgeScheduleLocalResult,
  type NotificationCapabilities,
  type NotificationConsentRecord,
  type NotificationDeliveryProviderEntry,
  type NotificationDeployment,
  type NotificationEndpointRegistration,
  type NotificationEvent,
  type NotificationEventEnvelope,
  type NotificationNotice,
  type NotificationPermissionResult,
  type NotificationPermissionSnapshot,
} from '@mpgd/platform/notifications';
import type { NotificationConformanceVector } from '@mpgd/platform/notifications-vectors';

import { isCliEntrypoint } from '../io';
import {
  renderJsonSchemaFiles,
  writeJsonSchemaFiles,
  type JsonSchemaCollection,
  type JsonSchemaFile,
} from '../json-schema-files';

export const notificationsSchemaDirectory = 'docs/specs/notifications/schemas';
export const notificationsSchemaIndexFile = 'index.json';
export const notificationsSchemaRegenerateCommand = 'pnpm generate:notifications-schemas';

/** Named types published as JSON Schema, in file order. */
const notificationsSchemaNames = [
  'NotificationCapabilities',
  'NotificationPermissionSnapshot',
  'NotificationPermissionResult',
  'NotificationEndpointRegistration',
  'LocalNotificationRequest',
  'LocalScheduleResult',
  'NotificationEvent',
  'NotificationEventEnvelope',
  'NotificationConsentRecord',
  'NotificationNotice',
  'NotificationDeliveryProviderEntry',
  'NotificationDeployment',
  'NotificationBridgeGetCapabilitiesPayload',
  'NotificationBridgeGetCapabilitiesResult',
  'NotificationBridgeGetPermissionPayload',
  'NotificationBridgeGetPermissionResult',
  'NotificationBridgeRequestPermissionPayload',
  'NotificationBridgeRequestPermissionResult',
  'NotificationBridgeRevokePermissionPayload',
  'NotificationBridgeRevokePermissionResult',
  'NotificationBridgeRegisterPayload',
  'NotificationBridgeRegisterResult',
  'NotificationBridgeScheduleLocalPayload',
  'NotificationBridgeScheduleLocalResult',
  'NotificationBridgeCancelLocalPayload',
  'NotificationBridgeCancelLocalResult',
  'NotificationBridgeListLocalPayload',
  'NotificationBridgeListLocalResult',
  'NotificationBridgeOpenSettingsPayload',
  'NotificationBridgeOpenSettingsResult',
  'NotificationConformanceVector',
] as const;

/**
 * Renders every schema file in memory. The output depends only on the
 * platform types and the typia version, so the alignment validator can compare
 * it byte for byte with the committed files.
 */
export function renderNotificationsSchemaFiles(): readonly JsonSchemaFile[] {
  const collection = typia.json.schemas<[
    NotificationCapabilities,
    NotificationPermissionSnapshot,
    NotificationPermissionResult,
    NotificationEndpointRegistration,
    LocalNotificationRequest,
    LocalScheduleResult,
    NotificationEvent,
    NotificationEventEnvelope,
    NotificationConsentRecord,
    NotificationNotice,
    NotificationDeliveryProviderEntry,
    NotificationDeployment,
    NotificationBridgeGetCapabilitiesPayload,
    NotificationBridgeGetCapabilitiesResult,
    NotificationBridgeGetPermissionPayload,
    NotificationBridgeGetPermissionResult,
    NotificationBridgeRequestPermissionPayload,
    NotificationBridgeRequestPermissionResult,
    NotificationBridgeRevokePermissionPayload,
    NotificationBridgeRevokePermissionResult,
    NotificationBridgeRegisterPayload,
    NotificationBridgeRegisterResult,
    NotificationBridgeScheduleLocalPayload,
    NotificationBridgeScheduleLocalResult,
    NotificationBridgeCancelLocalPayload,
    NotificationBridgeCancelLocalResult,
    NotificationBridgeListLocalPayload,
    NotificationBridgeListLocalResult,
    NotificationBridgeOpenSettingsPayload,
    NotificationBridgeOpenSettingsResult,
    NotificationConformanceVector,
  ]>() as unknown as JsonSchemaCollection;
  return renderJsonSchemaFiles({
    label: 'notifications',
    names: notificationsSchemaNames,
    collection,
    directory: notificationsSchemaDirectory,
    indexFile: notificationsSchemaIndexFile,
    protocol: notificationsProtocol,
    protocolVersion: notificationsProtocolVersion,
    regenerate: notificationsSchemaRegenerateCommand,
  });
}

export function writeNotificationsSchemaFiles(
  directory = notificationsSchemaDirectory,
): readonly string[] {
  return writeJsonSchemaFiles(directory, renderNotificationsSchemaFiles());
}

if (isCliEntrypoint(import.meta.url)) {
  const written = writeNotificationsSchemaFiles();
  console.info(
    `Notifications v2 schemas (${notificationsProtocolVersion}): wrote ${written.length} files to `
      + `${notificationsSchemaDirectory}`,
  );
}
