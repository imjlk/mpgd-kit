import {
  createGameExecutionController,
  type ExecutionChannel,
  type GameExecutionSnapshot,
} from '@mpgd/game-runtime';
import { createGameUiBridge, type GameUiScope } from '@mpgd/game-runtime/ui';

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
