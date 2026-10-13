import type { CanvasSurface } from '@mpgd/lite-shell';

export interface CollapseBody {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

export interface Collapse {
  /** Advance physics; returns false once every body sleeps. */
  step(deltaMs: number): boolean;
  draw(surface: CanvasSurface): void;
}

/**
 * Optional physics burst. matter-js is loaded with dynamic import() only when
 * the collapse starts, so it never counts against the Devvit inline first-load
 * budget (see `inlineBudget` in mpgd.targets.json).
 */
export async function startCollapse(width: number, height: number, count = 24): Promise<Collapse> {
  const { default: Matter } = await import('matter-js');
  const engine = Matter.Engine.create({ enableSleeping: true });
  const wall = { isStatic: true, friction: 1 };
  Matter.Composite.add(engine.world, [
    Matter.Bodies.rectangle(width / 2, height + 20, width * 2, 40, wall),
    Matter.Bodies.rectangle(-20, height / 2, 40, height * 2, wall),
    Matter.Bodies.rectangle(width + 20, height / 2, 40, height * 2, wall),
  ]);
  const size = Math.max(10, Math.min(width, height) / 12);
  const bodies = Array.from({ length: count }, (_, index) =>
    Matter.Bodies.rectangle(
      (width / (count + 1)) * (index + 1),
      -size * (1 + (index % 4)),
      size,
      size,
      { restitution: 0, friction: 0.8 },
    ),
  );
  Matter.Composite.add(engine.world, bodies);

  return {
    step(deltaMs) {
      Matter.Engine.update(engine, Math.min(deltaMs, 33));
      return bodies.some((body) => !body.isSleeping);
    },
    draw({ context }) {
      context.fillStyle = '#38bdf8';
      for (const body of bodies) {
        context.save();
        context.translate(body.position.x, body.position.y);
        context.rotate(body.angle);
        context.fillRect(-size / 2, -size / 2, size, size);
        context.restore();
      }
    },
  };
}
