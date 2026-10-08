import {
  createGameExecutionController,
  type ExecutionChannel,
  type GameExecutionSnapshot,
} from '@mpgd/game-runtime';
import {
  createGameActionCoordinator,
  type PurchaseActionSnapshot,
} from '@mpgd/game-runtime/actions';
import { bindGameLifecycle } from '@mpgd/game-runtime/platform';
import { createFullScreenPresentationScope } from '@mpgd/game-runtime/presentation';
import {
  createAdClaimEvidenceRecoveryObserver,
  createCoordinatedAdProvider,
} from '@mpgd/game-runtime/ads';
import { adProtocol, adProtocolVersion } from '@mpgd/platform/ads';
import { createGameUiBridge, type GameUiScope } from '@mpgd/game-runtime/ui';
import type { GameServicesOperationClient } from '@mpgd/game-services/operations';

const channel: ExecutionChannel = 'simulation';
const presentationExecution = createGameExecutionController();
const presentation = createFullScreenPresentationScope({ execution: presentationExecution });
const ads = createCoordinatedAdProvider({
  presentation,
  provider: {
    id: 'headless',
    protocol: adProtocol,
    protocolVersion: adProtocolVersion,
    rewardSignal: 'immediate',
    getAvailability: async () => ({ state: 'unsupported', reason: 'unsupported' }),
    preload: async () => ({ status: 'unavailable', reason: 'unsupported' }),
    show: async (input) => ({
      providerId: 'headless',
      invocationId: input.invocationId,
      format: input.format,
      outcome: 'unavailable',
      presentation: 'not-started',
      eligibility: input.format === 'rewarded' ? 'not-earned' : 'not-applicable',
      reason: 'unsupported',
    }),
    subscribe: () => () => {},
  },
});
void ads.getAvailability({ placementId: 'headless', format: 'rewarded' });
const lateEvidenceObserver = createAdClaimEvidenceRecoveryObserver({
  recovery: { recoverRewardResult: async (_key, reward) => ({ status: 'pending', reward }) },
});
void lateEvidenceObserver;
const controller = createGameExecutionController();
const token = controller.acquireBlock({ reason: 'consumer', channels: [channel] });
const snapshot: GameExecutionSnapshot = controller.getSnapshot();
// @ts-expect-error Snapshots expose readonly channel flags.
snapshot.blocked.simulation = false;
// @ts-expect-error Token diagnostics cannot be used to mutate the block list.
snapshot.blocks.push(token.info);
token.release();
controller.destroy();

const bridge = createGameUiBridge<number, 'refresh', 'done'>({ initialSnapshot: 0 });
const scope: GameUiScope<number, 'refresh', 'done'> = bridge.createScope();
scope.subscribeSelector(
  (value) => String(value),
  (value: string) => {
    void value;
  },
);
scope.dispatch('refresh');
scope.emit('done');
// @ts-expect-error Commands and events are separate contracts.
scope.dispatch('done');
scope.dispose();

bindGameLifecycle({
  controller: createGameExecutionController(),
  initialState: 'inactive',
  source: { onPause: () => () => {}, onResume: () => () => {} },
}).dispose();

// Headless declaration consumer: tsconfig deliberately has ES2022 and no DOM/Node ambient types.
const servicePort: GameServicesOperationClient = {
  purchase: async () => ({
    status: 'cancelled',
    purchase: { status: 'cancelled', entitlementIds: [] },
  }),
  claimRewardedAd: async () => ({
    status: 'skipped',
    reward: { status: 'skipped', rewardGranted: false },
  }),
};
const coordinator = createGameActionCoordinator({
  execution: createGameExecutionController(),
  client: servicePort,
});
const owner = coordinator.createPurchaseController();
const actionSnapshot: PurchaseActionSnapshot = owner.getSnapshot();
const invalidPurchase: PurchaseActionSnapshot = {
  kind: 'purchase',
  // @ts-expect-error Ad-only outcomes cannot be assigned to a purchase snapshot.
  status: 'skipped',
  operationId: 1,
};
// @ts-expect-error Purchase inputs must not accept ad placement inputs.
void owner.execute({ placementId: 'revive', idempotencyKey: 'key' });
void actionSnapshot;
void invalidPurchase;

const recoverable = createGameActionCoordinator({
  execution: createGameExecutionController(),
  client: servicePort,
  reconciliation: {
    playerId: 'player',
    async recover(operation) {
      const grantId = operation.kind === 'purchase'
        ? operation.input.productId
        : operation.input.placementId;
      return {
        operationId: operation.operationId,
        transaction: {
          playerId: operation.playerId,
          source: operation.kind === 'purchase' ? 'purchase' : 'ad_reward',
          grantId,
          idempotencyKey: operation.input.idempotencyKey,
          ledgerEntryId: 'authoritative-ledger',
        },
      };
    },
  },
});
void recoverable.reconcile();
const unresolved = recoverable.getPendingOperation();
if (unresolved) {
  // @ts-expect-error Recovery identity must stay immutable.
  unresolved.input.idempotencyKey = 'different';
}

// New game/audio ports must also type-check with ES2022 and no DOM or Phaser.
import { bindGameAudio } from '@mpgd/game-runtime/audio';
import { createGamePlatformRuntime, type GameServicePorts } from '@mpgd/game-runtime/game';
const ports: GameServicePorts = {};
const audioProjection = bindGameAudio({
  execution: createGameExecutionController(),
  sink: { getMuted: () => false, setMuted: (_muted) => {} },
});
audioProjection.dispose();
void createGamePlatformRuntime;
void ports;
