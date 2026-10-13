import {
  createCanvasRenderer,
  createLiteShell,
  type CanvasSurface,
  type LiteShell,
} from '@mpgd/lite-shell';

import { startCollapse, type Collapse } from './collapse';
import { createStarterRunState, stepStarterRunState, type StarterRunState } from '../game/state';

export interface TapGameOptions {
  readonly mount: HTMLElement;
  readonly title: string;
  readonly onHit?: (hits: number) => void;
}

/**
 * Renderer-agnostic starter gameplay: tap the orbiting target. State lives in
 * `src/game/state.ts`; this file only draws and routes taps. Swap
 * `createCanvasRenderer` for another `LiteRenderer` (dom/svg) when one exists.
 */
export function createTapGame(options: TapGameOptions): LiteShell<CanvasSurface> {
  let run: StarterRunState = createStarterRunState();
  let hits = 0;
  let pulse = 0;
  let collapse: Collapse | undefined;
  const target = (width: number, height: number) => {
    const angle = run.phase * Math.PI * 2;
    const radius = Math.min(width, height) * 0.28;
    return {
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
      r: 22,
    };
  };

  const shell = createLiteShell<CanvasSurface>({
    mount: options.mount,
    renderer: createCanvasRenderer(),
    frame({ context, size }, deltaMs) {
      run = stepStarterRunState(run, deltaMs);
      pulse = Math.max(0, pulse - deltaMs / 300);
      const { width, height } = size;
      context.fillStyle = '#07111f';
      context.fillRect(0, 0, width, height);
      const dot = target(width, height);
      context.beginPath();
      context.arc(dot.x, dot.y, dot.r * (1 + pulse * 0.4), 0, Math.PI * 2);
      context.fillStyle = pulse > 0 ? '#5eead4' : '#38bdf8';
      context.fill();
      const physicsActive = collapse?.step(deltaMs) === true;
      collapse?.draw({ context, size, canvas: context.canvas });
      context.fillStyle = '#ffffff';
      context.font = '600 16px system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillText(`${options.title} · ${hits}`, width / 2, 28);
      // Keep animating only while the document is visible; the loop sleeps otherwise.
      return physicsActive || document.visibilityState === 'visible';
    },
    onTap({ x, y }) {
      const dot = target(shell.size.width, shell.size.height);
      if (Math.hypot(x - dot.x, y - dot.y) <= dot.r * 1.6) {
        hits += 1;
        pulse = 1;
        options.onHit?.(hits);
        if (hits === 5 && collapse === undefined) {
          void startCollapse(shell.size.width, shell.size.height).then((next) => {
            collapse = next;
            shell.invalidate();
          });
        }
      }
    },
  });
  document.addEventListener('visibilitychange', () => shell.invalidate());
  return shell;
}
