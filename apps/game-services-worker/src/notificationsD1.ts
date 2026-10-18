import {
  formatNotificationInstant,
  notificationSendDueAt,
  type NotificationConsentRecordInput,
  type NotificationEndpointWrite,
  type NotificationHistoryEntry,
  type NotificationNoticeGiven,
  type NotificationPlatformRegistration,
  type NotificationStore,
  type NotificationStoredEndpoint,
  type NotificationStoredSend,
} from '@mpgd/game-services/notifications';
import type { NotificationConsentRecord } from '@mpgd/platform/notifications';

/**
 * The notifications store over D1 (migration 0007_notifications.sql). Each
 * atomic step the store contract names is one statement or one batch:
 * consent records take their sequence and time in one INSERT … SELECT, an
 * endpoint write drops another installation's copy of its address in the
 * same batch, and a send is written only while it keeps its version.
 */
export function createD1NotificationStore(db: D1Database): NotificationStore {
  return {
    async appendConsent({ player, record, at }) {
      const atMs = millisOf(at);
      const recordJson = JSON.stringify(record);
      const topic = 'topic' in record && typeof record.topic === 'string' ? record.topic : null;
      // Two writers can take the same sequence; the primary key refuses one,
      // which retries. D1 serializes writes, so this guards other SQLite hosts.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const stored = await db.prepare(`INSERT INTO notification_consent_records
              (player_id, sequence, kind, topic, at_ms, record_json)
            SELECT ?1, COALESCE(MAX(sequence), 0) + 1, ?2, ?3, MAX(?4, COALESCE(MAX(at_ms) + 1, ?4)), ?5
            FROM notification_consent_records WHERE player_id = ?1
            RETURNING at_ms`)
            .bind(player, record.kind, topic, atMs, recordJson)
            .first<{ readonly at_ms: number }>();
          if (stored === null) {
            throw new Error('The consent record was not stored.');
          }
          return consentRecordOf(recordJson, stored.at_ms);
        } catch (error) {
          if (attempt === 4 || !isConstraintError(error)) {
            throw error;
          }
        }
      }
      throw new Error('The consent record was not stored.');
    },
    async listConsent(player) {
      const rows = await db.prepare(`SELECT record_json, at_ms FROM notification_consent_records
        WHERE player_id = ? ORDER BY sequence`)
        .bind(player)
        .all<{ readonly record_json: string; readonly at_ms: number }>();
      return rows.results.map((row) => consentRecordOf(row.record_json, row.at_ms));
    },

    async putEndpoint(write) {
      const json = JSON.stringify(write);
      const dead = `notification_endpoints.status = 'invalid'
        AND notification_endpoints.address_value = excluded.address_value`;
      const [, , selected] = await db.batch([
        db.prepare(`DELETE FROM notification_endpoints
          WHERE provider = ? AND address_value = ? AND installation_id <> ?`)
          .bind(write.provider, write.address.value, write.installationId),
        db.prepare(`INSERT INTO notification_endpoints (
            provider, installation_id, player_id, address_kind, address_value, environment,
            permission, status, locale, time_zone, target, session_id, session_expires_at_ms,
            last_registered_at_ms, invalidated_at_ms, endpoint_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?, ?, ?, ?, ?, NULL, ?)
          ON CONFLICT (provider, installation_id) DO UPDATE SET
            player_id = excluded.player_id,
            address_kind = excluded.address_kind,
            environment = excluded.environment,
            permission = excluded.permission,
            status = CASE WHEN ${dead} THEN 'invalid' ELSE 'valid' END,
            invalidated_at_ms = CASE WHEN ${dead} THEN notification_endpoints.invalidated_at_ms ELSE NULL END,
            address_value = excluded.address_value,
            locale = excluded.locale,
            time_zone = excluded.time_zone,
            target = excluded.target,
            session_id = excluded.session_id,
            session_expires_at_ms = excluded.session_expires_at_ms,
            last_registered_at_ms = excluded.last_registered_at_ms,
            endpoint_json = excluded.endpoint_json`)
          .bind(
            write.provider,
            write.installationId,
            write.player,
            write.address.kind,
            write.address.value,
            write.address.environment ?? null,
            write.permission,
            write.locale ?? null,
            write.timeZone ?? null,
            write.target ?? null,
            write.sessionId,
            write.sessionExpiresAt === undefined ? null : millisOf(write.sessionExpiresAt),
            millisOf(write.lastRegisteredAt),
            json,
          ),
        db.prepare(`SELECT status, invalidated_at_ms, endpoint_json FROM notification_endpoints
          WHERE provider = ? AND installation_id = ?`)
          .bind(write.provider, write.installationId),
      ]);
      const row = (selected?.results as readonly EndpointRow[] | undefined)?.[0];
      if (row === undefined) {
        throw new Error('The endpoint was not stored.');
      }
      return endpointOf(row);
    },
    async listEndpoints({ player, provider }) {
      const rows = await db.prepare(`SELECT status, invalidated_at_ms, endpoint_json FROM notification_endpoints
        WHERE player_id = ? AND provider = ? ORDER BY installation_id`)
        .bind(player, provider)
        .all<EndpointRow>();
      return rows.results.map(endpointOf);
    },
    async getEndpoint({ provider, installationId }) {
      const row = await db.prepare(`SELECT status, invalidated_at_ms, endpoint_json FROM notification_endpoints
        WHERE provider = ? AND installation_id = ?`)
        .bind(provider, installationId)
        .first<EndpointRow>();
      return row === null ? undefined : endpointOf(row);
    },
    async invalidateEndpoint({ provider, installationId, value, at }) {
      await db.prepare(`UPDATE notification_endpoints SET status = 'invalid', invalidated_at_ms = ?
        WHERE provider = ? AND installation_id = ? AND address_value = ? AND status = 'valid'`)
        .bind(millisOf(at), provider, installationId, value)
        .run();
    },
    async removeEndpoints({ installationId, player, provider }) {
      await (provider === undefined
        ? db.prepare('DELETE FROM notification_endpoints WHERE installation_id = ? AND player_id = ?')
          .bind(installationId, player)
        : db.prepare(`DELETE FROM notification_endpoints
            WHERE installation_id = ? AND player_id = ? AND provider = ?`)
          .bind(installationId, player, provider)
      ).run();
    },
    async removeSessionEndpoints({ sessionId }) {
      const result = await db.prepare('DELETE FROM notification_endpoints WHERE session_id = ?')
        .bind(sessionId)
        .run();
      return result.meta.changes;
    },
    async extendSessionEndpoints({ sessionId, expiresAt }) {
      // The endpoint JSON is what reads answer, so it moves with the column.
      const result = await (expiresAt === undefined
        ? db.prepare(`UPDATE notification_endpoints SET
              session_expires_at_ms = NULL,
              endpoint_json = json_remove(endpoint_json, '$.sessionExpiresAt')
            WHERE session_id = ? AND session_expires_at_ms IS NOT NULL`)
          .bind(sessionId)
        : db.prepare(`UPDATE notification_endpoints SET
              session_expires_at_ms = ?,
              endpoint_json = json_set(endpoint_json, '$.sessionExpiresAt', ?)
            WHERE session_id = ? AND session_expires_at_ms < ?`)
          .bind(millisOf(expiresAt), expiresAt, sessionId, millisOf(expiresAt))
      ).run();
      return result.meta.changes;
    },

    async putPlatformRegistration(registration) {
      await db.prepare(`INSERT INTO notification_platform_registrations (player_id, provider, registration_json)
        VALUES (?, ?, ?)
        ON CONFLICT (player_id, provider) DO UPDATE SET registration_json = excluded.registration_json`)
        .bind(registration.player, registration.provider, JSON.stringify(registration))
        .run();
    },
    async getPlatformRegistration({ player, provider }) {
      const row = await db.prepare(`SELECT registration_json FROM notification_platform_registrations
        WHERE player_id = ? AND provider = ?`)
        .bind(player, provider)
        .first<{ readonly registration_json: string }>();
      return row === null
        ? undefined
        : JSON.parse(row.registration_json) as NotificationPlatformRegistration;
    },

    async addNoticeGiven(notice) {
      await db.prepare(`INSERT INTO notification_notices_given
          (player_id, kind, record_kind, record_at_ms, due_by, channel, given_at_ms, notice_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (player_id, kind, record_kind, record_at_ms, due_by) DO NOTHING`)
        .bind(
          notice.player,
          notice.kind,
          notice.record.kind,
          millisOf(notice.record.at),
          notice.dueBy,
          notice.channel,
          millisOf(notice.at),
          JSON.stringify(notice),
        )
        .run();
    },
    async listNoticesGiven(player) {
      const rows = await db.prepare(`SELECT notice_json FROM notification_notices_given
        WHERE player_id = ? ORDER BY given_at_ms, kind, record_kind, record_at_ms, due_by`)
        .bind(player)
        .all<{ readonly notice_json: string }>();
      return rows.results.map((row) => JSON.parse(row.notice_json) as NotificationNoticeGiven);
    },

    async getSend(key) {
      const row = await db.prepare('SELECT version, send_json FROM notification_sends WHERE send_key = ?')
        .bind(key)
        .first<{ readonly version: string; readonly send_json: string }>();
      return row === null
        ? undefined
        : { version: row.version, send: JSON.parse(row.send_json) as NotificationStoredSend };
    },
    async createSend(send) {
      const version = crypto.randomUUID();
      const index = sendIndexOf(send);
      // Only an existing key is ignored; a row that breaks a constraint throws.
      const result = await db.prepare(`INSERT INTO notification_sends
          (send_key, version, player_id, in_flight, due_at_ms, changed_at_ms, send_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (send_key) DO NOTHING`)
        .bind(send.key, version, send.request.player, index.inFlight, index.dueAtMs, index.changedAtMs, JSON.stringify(send))
        .run();
      return result.meta.changes === 1 ? version : undefined;
    },
    async updateSend({ key, version, send }) {
      if (send === undefined) {
        const result = await db.prepare('DELETE FROM notification_sends WHERE send_key = ? AND version = ?')
          .bind(key, version)
          .run();
        return result.meta.changes === 1;
      }
      const index = sendIndexOf(send);
      const result = await db.prepare(`UPDATE notification_sends
        SET version = ?, player_id = ?, in_flight = ?, due_at_ms = ?, changed_at_ms = ?, send_json = ?
        WHERE send_key = ? AND version = ?`)
        .bind(
          crypto.randomUUID(),
          send.request.player,
          index.inFlight,
          index.dueAtMs,
          index.changedAtMs,
          JSON.stringify(send),
          key,
          version,
        )
        .run();
      return result.meta.changes === 1;
    },
    async listInFlightSends(player) {
      const rows = await db.prepare(`SELECT send_json FROM notification_sends
        WHERE player_id = ? AND in_flight = 1`)
        .bind(player)
        .all<{ readonly send_json: string }>();
      return rows.results.map((row) => JSON.parse(row.send_json) as NotificationStoredSend);
    },
    async listDueSends({ at, limit }) {
      const rows = await db.prepare(`SELECT send_key FROM notification_sends
        WHERE due_at_ms IS NOT NULL AND due_at_ms <= ? ORDER BY due_at_ms, send_key LIMIT ?`)
        // As the in-memory store slices: Infinity reads every due send (SQLite: a negative LIMIT), NaN none.
        .bind(millisOf(at), limitOf(limit))
        .all<{ readonly send_key: string }>();
      return rows.results.map((row) => row.send_key);
    },

    async addHistory(entry) {
      await db.prepare(`INSERT INTO notification_delivery_history
          (send_key, provider, player_id, topic, at_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (send_key, provider) DO NOTHING`)
        .bind(entry.sendKey, entry.provider, entry.player, entry.topic, millisOf(entry.at))
        .run();
    },
    async listHistory({ player, since }) {
      const rows = await db.prepare(`SELECT send_key, provider, player_id, topic, at_ms
        FROM notification_delivery_history
        WHERE player_id = ? AND at_ms >= ? ORDER BY at_ms, send_key, provider`)
        .bind(player, millisOf(since))
        .all<HistoryRow>();
      return rows.results.map((row): NotificationHistoryEntry => ({
        sendKey: row.send_key,
        provider: row.provider,
        player: row.player_id,
        topic: row.topic,
        at: formatNotificationInstant(row.at_ms),
      }));
    },

    async purge(cutoffs) {
      const [sends, history, endpoints] = await db.batch([
        db.prepare('DELETE FROM notification_sends WHERE changed_at_ms < ?')
          .bind(millisOf(cutoffs.sendsChangedBefore)),
        db.prepare('DELETE FROM notification_delivery_history WHERE at_ms < ?')
          .bind(millisOf(cutoffs.historyBefore)),
        db.prepare(`DELETE FROM notification_endpoints
          WHERE (status = 'invalid' AND invalidated_at_ms < ?)
            OR last_registered_at_ms < ?
            OR (session_expires_at_ms IS NOT NULL AND session_expires_at_ms < ?)`)
          .bind(
            millisOf(cutoffs.invalidEndpointsBefore),
            millisOf(cutoffs.staleEndpointsBefore),
            millisOf(cutoffs.sessionEndpointsBefore),
          ),
      ]);
      return {
        sends: sends?.meta.changes ?? 0,
        history: history?.meta.changes ?? 0,
        endpoints: endpoints?.meta.changes ?? 0,
      };
    },
  };
}

interface EndpointRow {
  readonly status: 'valid' | 'invalid';
  readonly invalidated_at_ms: number | null;
  readonly endpoint_json: string;
}

interface HistoryRow {
  readonly send_key: string;
  readonly provider: string;
  readonly player_id: string;
  readonly topic: string;
  readonly at_ms: number;
}

function limitOf(limit: number): number {
  if (limit === Number.POSITIVE_INFINITY) {
    return -1;
  }
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
}

/** Epoch milliseconds of a stored time; a time that does not parse is refused rather than bound as NULL. */
function millisOf(at: string): number {
  const millis = Date.parse(at);
  if (!Number.isFinite(millis)) {
    throw new TypeError(`Not a timestamp: ${JSON.stringify(at)}`);
  }
  return millis;
}

function consentRecordOf(recordJson: string, atMs: number): NotificationConsentRecord {
  const record = JSON.parse(recordJson) as NotificationConsentRecordInput;
  return { ...record, at: formatNotificationInstant(atMs) } as NotificationConsentRecord;
}

function endpointOf(row: EndpointRow): NotificationStoredEndpoint {
  const write = JSON.parse(row.endpoint_json) as NotificationEndpointWrite;
  return {
    ...write,
    status: row.status,
    ...(row.status === 'invalid' && row.invalidated_at_ms !== null
      ? { invalidatedAt: formatNotificationInstant(row.invalidated_at_ms) }
      : {}),
  };
}

function sendIndexOf(send: NotificationStoredSend): {
  readonly inFlight: 0 | 1;
  readonly dueAtMs: number | null;
  readonly changedAtMs: number;
} {
  const due = notificationSendDueAt(send);
  return {
    inFlight: send.rows.some((row) => row.state.status === 'in-flight') ? 1 : 0,
    dueAtMs: due === undefined ? null : millisOf(due),
    changedAtMs: millisOf(send.changedAt),
  };
}

/** Only the sequence collision is retried; a CHECK or NOT NULL failure is a bug and throws at once. */
function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed|SQLITE_CONSTRAINT_PRIMARYKEY/u.test(error.message);
}
