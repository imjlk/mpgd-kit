import Phaser from 'phaser';

import { createGameExecutionController, type ExecutionBlock } from '@mpgd/game-runtime';
import { bindGameLifecycle, type GameLifecycleState } from '@mpgd/game-runtime/platform';
import { createGameUiBridge } from '@mpgd/game-runtime/ui';
import { bindPhaserGameScene } from '@mpgd/phaser-game-runtime';

import { createMonetizationFixture } from './monetization';

type Command = 'settings' | 'background' | 'foreground' | 'rendering' | 'input' | 'restart';
const metrics = {
  gameplayUpdates: 0,
  gameplayRenders: 0,
  gameplayResumes: 0,
  uiUpdates: 0,
  gameplayClicks: 0,
  keyMoves: 0,
  resets: 0,
  generations: 0,
  scopeCleanups: 0,
};
const errors: string[] = [];
function report(error: unknown): void {
  errors.push(error instanceof Error ? error.message : String(error));
  if (errors.length > 10) {
    errors.shift();
  }
}
const controller = createGameExecutionController({ onListenerError: report });
const monetization = createMonetizationFixture(controller);
const pauses = new Set<() => void>();
const resumes = new Set<() => void>();
let lifecycleState: GameLifecycleState = new URLSearchParams(location.search).has('inactive')
  ? 'inactive'
  : 'active';
const bridge = createGameUiBridge<{ settingsOpen: boolean }, Command>({
  initialSnapshot: { settingsOpen: false },
  onListenerError: report,
});
const lifecycle = bindGameLifecycle({
  controller,
  readState: () => lifecycleState,
  source: {
    onPause(callback) {
      pauses.add(callback);
      return () => {
        pauses.delete(callback); };
    },
    onResume(callback) {
      resumes.add(callback);
      return () => {
        resumes.delete(callback); };
    },
  },
});
let settingsBlock: ExecutionBlock | undefined;
let renderingBlock: ExecutionBlock | undefined;
let inputBlock: ExecutionBlock | undefined;
let muted = false;
let ready = false;
let tornDown = false;

class Gameplay extends Phaser.Scene {
  private pressed = false;
  private square: Phaser.GameObjects.Rectangle | undefined;
  private counter: Phaser.GameObjects.Text | undefined;

  constructor() {
    super('Gameplay');
  }

  create(): void {
    metrics.generations += 1;
    this.pressed = false;
    this.add.rectangle(325, 345, 550, 450, 0xffffff);
    this.add.text(72, 138, 'GAMEPLAY', { fontFamily: 'Arial', fontSize: '14px', color: '#708097' });
    this.counter = this.add.text(72, 182, '', {
      fontFamily: 'Arial',
      fontSize: '46px',
      color: '#1f3550',
    });
    this.add.text(72, 250, 'Updates stop while a block remains.', {
      fontFamily: 'Arial',
      fontSize: '18px',
      color: '#708097',
    });
    this.add.text(72, 518, 'Hold RIGHT or tap the orange square.', {
      fontFamily: 'Arial',
      fontSize: '17px',
      color: '#708097',
    });
    this.square = this.add.rectangle(180, 370, 80, 80, 0xec8651).setInteractive();
    this.square.on('pointerdown', () => {
      metrics.gameplayClicks += 1;
    });
    this.input.keyboard?.on('keydown-RIGHT', () => {
      this.pressed = true;
    });
    this.input.keyboard?.on('keyup-RIGHT', () => {
      this.pressed = false;
    });
    const scope = bridge.createScope();
    scope.own(() => {
      metrics.scopeCleanups += 1;
    });
    const rendered = (): void => {
      metrics.gameplayRenders += 1;
    };
    const resumed = (): void => {
      metrics.gameplayResumes += 1;
    };
    this.sys.events.on('render', rendered);
    this.sys.events.on('resume', resumed);
    scope.own(() => {
      this.sys.events.off('render', rendered);
      this.sys.events.off('resume', resumed);
    });
    bindPhaserGameScene({
      controller,
      scene: this,
      uiScope: scope,
      resetInput: () => {
        this.pressed = false;
        metrics.resets += 1;
      },
      renderingPolicy: 'visibility',
      audio: {
        getMuted: () => muted,
        setMuted: (value) => {
          muted = value; },
      },
      onUnsupportedState: (_snapshot, reason) => report(reason),
      onError: report,
    });
  }

  override update(): void {
    metrics.gameplayUpdates += 1;
    this.counter?.setText(String(metrics.gameplayUpdates).padStart(5, '0'));
    if (this.pressed && this.square !== undefined) {
      this.square.x = Math.min(530, this.square.x + 2);
      metrics.keyMoves += 1;
    }
  }
}

class Controls extends Phaser.Scene {
  private status: Phaser.GameObjects.Text | undefined;
  private settingsLabel: Phaser.GameObjects.Text | undefined;

  constructor() {
    super({ key: 'Controls', active: true });
  }

  create(): void {
    this.add.text(52, 42, 'Runtime controls', {
      fontFamily: 'Arial',
      fontSize: '30px',
      color: '#1f3550',
    });
    this.add.text(52, 82, 'Gameplay and UI have independent lifetimes.', {
      fontFamily: 'Arial',
      fontSize: '18px',
      color: '#708097',
    });
    const scope = bridge.createScope();
    this.events.once('shutdown', () => scope.dispose());
    const button = (y: number, label: string, command: Command): Phaser.GameObjects.Text => {
      const background = this.add.rectangle(795, y, 300, 48, 0x254363).setInteractive();
      const text = this.add.text(795, y, label, { fontFamily: 'Arial', fontSize: '18px', color: '#ffffff' }).setOrigin(
        0.5,
      );
      background.on('pointerdown', () => scope.dispatch(command));
      return text;
    };
    this.settingsLabel = button(156, 'Open settings', 'settings');
    button(218, 'Background', 'background');
    button(280, 'Foreground', 'foreground');
    button(342, 'Toggle rendering', 'rendering');
    button(404, 'Toggle gameplay input', 'input');
    button(466, 'Restart gameplay', 'restart');
    this.status = this.add.text(650, 515, '', {
      fontFamily: 'Arial',
      fontSize: '16px',
      color: '#405b76',
      lineSpacing: 8,
    });
    ready = true;
  }

  override update(): void {
    metrics.uiUpdates += 1;
    const state = controller.getSnapshot();
    this.settingsLabel?.setText(
      bridge.getSnapshot().settingsOpen ? 'Close settings' : 'Open settings',
    );
    this.status?.setText([
      `UI updates: ${metrics.uiUpdates}`,
      `Gameplay: ${state.blocked.simulation ? 'paused' : 'running'} · Audio: ${muted ? 'muted' : 'on'}`,
    ]);
  }
}

const game = new Phaser.Game({
  type: Phaser.CANVAS,
  parent: 'game',
  width: 1000,
  height: 620,
  backgroundColor: '#edf2f8',
  banner: false,
  audio: { noAudio: true },
  scene: [Gameplay, Controls],
});

function command(value: Command): void {
  switch (value) {
    case 'settings': {
      if (settingsBlock === undefined) {
        settingsBlock = controller.acquireBlock({
          reason: 'settings',
          channels: ['simulation', 'gameplay-input'],
        });
      } else {
        settingsBlock.release();
        settingsBlock = undefined;
      }
      bridge.setSnapshot({ settingsOpen: settingsBlock !== undefined });
      break;
    }
    case 'background': {
      lifecycleState = 'inactive';
      pauses.forEach((callback) => callback());
      break;
    }
    case 'foreground': {
      lifecycleState = 'active';
      resumes.forEach((callback) => callback());
      break;
    }
    case 'rendering': {
      if (renderingBlock === undefined) {
        renderingBlock = controller.acquireBlock({
          reason: 'render-toggle',
          channels: ['rendering'],
        });
      } else {
        renderingBlock.release();
        renderingBlock = undefined;
      }
      break;
    }
    case 'input': {
      if (inputBlock === undefined) {
        inputBlock = controller.acquireBlock({
          reason: 'input-toggle',
          channels: ['gameplay-input'],
        });
      } else {
        inputBlock.release();
        inputBlock = undefined;
      }
      break;
    }
    case 'restart': {
      game.scene.stop('Gameplay');
      game.scene.start('Gameplay');
      break;
    }
  }
}
bridge.onCommand(command);

function state() {
  const gameplay = tornDown ? undefined : game.scene.getScene('Gameplay');
  return {
    ready,
    monetization: monetization.state(),
    coordinateSystem: '1000x620 canvas, origin top-left, x right, y down',
    ...metrics,
    settingsOpen: bridge.getSnapshot().settingsOpen,
    lifecycleState,
    muted,
    blocked: controller.getSnapshot().blocked,
    controllerStatus: controller.getSnapshot().status,
    gameplayStatus: gameplay?.sys.getStatus(),
    gameplayActive: gameplay?.sys.isActive(),
    gameplayVisible: gameplay?.sys.isVisible(),
    gameplayInputEnabled: gameplay?.input.enabled,
    gameplayCanInput: gameplay?.sys.canInput(),
    runtimeCreateListeners: gameplay?.sys.events.listenerCount('create'),
    errors: [...errors],
  };
}

let virtualTime = performance.now();
const fixture = {
  state,
  command,
  stopGameplay: () => game.scene.stop('Gameplay'),
  sleepGameplay: () => game.scene.sleep('Gameplay'),
  wakeGameplay: () => game.scene.wake('Gameplay'),
  destroy(): void {
    if (tornDown) {
      return;
    }
    tornDown = true;
    ready = false;
    // Terminate coordination before cleanup releases any lifecycle/settings blocks.
    controller.destroy();
    monetization.dispose();
    lifecycle.dispose();
    bridge.destroy();
    game.destroy(true);
    // Manual test stepping stopped RAF; flush Phaser's deferred destruction explicitly.
    game.step(virtualTime, 0);
  },
};

declare global {
  interface Window {
    fixture: typeof fixture;
    render_game_to_text: () => string;
    advanceTime: (milliseconds: number) => void;
  }
}

window.fixture = fixture;
window.render_game_to_text = () => JSON.stringify(state());
window.advanceTime = (milliseconds) => {
  game.loop.stop();
  const frames = Math.max(1, Math.round(milliseconds / (1000 / 60)));
  for (let index = 0; index < frames; index += 1) {
    virtualTime += 1000 / 60;
    game.step(virtualTime, 1000 / 60);
  }
};
