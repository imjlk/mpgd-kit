import {
  createGameExecutionController,
  type ExecutionChannel,
  type GameExecutionSnapshot,
} from '@mpgd/game-runtime';

const channel: ExecutionChannel = 'simulation';
const controller = createGameExecutionController();
const token = controller.acquireBlock({ reason: 'consumer', channels: [channel] });
const snapshot: GameExecutionSnapshot = controller.getSnapshot();
// @ts-expect-error Snapshots expose readonly channel flags.
snapshot.blocked.simulation = false;
// @ts-expect-error Token diagnostics cannot be used to mutate the block list.
snapshot.blocks.push(token.info);
token.release();
controller.destroy();
