export interface VerifiedAdMobSsvCallback {
  readonly transactionId: string;
  readonly target: 'android' | 'ios';
  readonly playerId: string;
  readonly placementId: string;
  readonly idempotencyKey: string;
  readonly callbackUrl: string;
  readonly acceptedAdUnit: string;
  readonly keyId: string;
  readonly publicKeySpki: string;
  readonly receivedAt: string;
}

export type AdMobSsvCallbackRecordResult = 'created' | 'already-recorded' | 'conflict';

export interface AdMobSsvCallbackOperation {
  readonly target: 'android' | 'ios';
  readonly playerId: string;
  readonly placementId: string;
  readonly idempotencyKey: string;
}

interface AdMobSsvCallbackRow {
  readonly transaction_id: string;
  readonly target: 'android' | 'ios';
  readonly player_id: string;
  readonly placement_id: string;
  readonly idempotency_key: string;
  readonly callback_url: string;
  readonly accepted_ad_unit: string;
  readonly key_id: string;
  readonly public_key_spki: string;
  readonly received_at: string;
}

export function createD1AdMobSsvCallbackStore(db: D1Database) {
  return {
    async record(input: VerifiedAdMobSsvCallback): Promise<AdMobSsvCallbackRecordResult> {
      const inserted = await db.prepare(`INSERT OR IGNORE INTO admob_ssv_callbacks (
        transaction_id, target, player_id, placement_id, idempotency_key,
        callback_url, accepted_ad_unit, key_id, public_key_spki, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        input.transactionId,
        input.target,
        input.playerId,
        input.placementId,
        input.idempotencyKey,
        input.callbackUrl,
        input.acceptedAdUnit,
        input.keyId,
        input.publicKeySpki,
        input.receivedAt,
      ).run();
      if (inserted.meta.changes === 1) {
        return 'created';
      }
      const existing = await findByTransactionId(db, input.transactionId);
      return existing !== undefined && sameVerifiedCallback(existing, input)
        ? 'already-recorded'
        : 'conflict';
    },
    async find(input: AdMobSsvCallbackOperation): Promise<VerifiedAdMobSsvCallback | undefined> {
      const row = await db.prepare(`SELECT * FROM admob_ssv_callbacks
        WHERE target = ? AND player_id = ? AND placement_id = ? AND idempotency_key = ?`)
        .bind(input.target, input.playerId, input.placementId, input.idempotencyKey)
        .first<AdMobSsvCallbackRow>();
      return row === null ? undefined : fromRow(row);
    },
  };
}

async function findByTransactionId(
  db: D1Database,
  transactionId: string,
): Promise<VerifiedAdMobSsvCallback | undefined> {
  const row = await db.prepare('SELECT * FROM admob_ssv_callbacks WHERE transaction_id = ?')
    .bind(transactionId)
    .first<AdMobSsvCallbackRow>();
  return row === null ? undefined : fromRow(row);
}

function fromRow(row: AdMobSsvCallbackRow): VerifiedAdMobSsvCallback {
  return {
    transactionId: row.transaction_id,
    target: row.target,
    playerId: row.player_id,
    placementId: row.placement_id,
    idempotencyKey: row.idempotency_key,
    callbackUrl: row.callback_url,
    acceptedAdUnit: row.accepted_ad_unit,
    keyId: row.key_id,
    publicKeySpki: row.public_key_spki,
    receivedAt: row.received_at,
  };
}

function sameVerifiedCallback(
  left: VerifiedAdMobSsvCallback,
  right: VerifiedAdMobSsvCallback,
): boolean {
  return left.transactionId === right.transactionId
    && left.target === right.target
    && left.playerId === right.playerId
    && left.placementId === right.placementId
    && left.idempotencyKey === right.idempotencyKey
    && left.callbackUrl === right.callbackUrl
    && left.acceptedAdUnit === right.acceptedAdUnit
    && left.keyId === right.keyId
    && left.publicKeySpki === right.publicKeySpki;
}
