/** Stage size in CSS pixels plus the device pixel ratio used for backing stores. */
export interface StageSize {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/**
 * Renderer extension point. The shell owns layout, input, and the frame loop;
 * a renderer owns one surface element. Canvas2D ships today; DOM or SVG
 * renderers implement the same contract.
 */
export interface LiteRenderer<Surface = unknown> {
  readonly kind: LiteRendererKind;
  readonly element: HTMLElement | SVGElement;
  readonly surface: Surface;
  resize(size: StageSize): void;
  dispose(): void;
}

export type LiteRendererKind = 'canvas' | 'dom' | 'svg';

export interface CanvasSurface {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  /** Current stage size; drawing uses CSS pixel coordinates. */
  readonly size: StageSize;
}

export function createCanvasRenderer(options: { readonly maxDpr?: number } = {}): LiteRenderer<CanvasSurface> {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('Canvas2D is unavailable.');
  }
  const maxDpr = options.maxDpr ?? 3;
  let size: StageSize = { width: 0, height: 0, dpr: 1 };
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';

  return {
    kind: 'canvas',
    element: canvas,
    surface: {
      canvas,
      context,
      get size() {
        return size;
      },
    },
    resize(next) {
      const dpr = Math.min(next.dpr, maxDpr);
      size = { ...next, dpr };
      canvas.width = Math.max(1, Math.round(next.width * dpr));
      canvas.height = Math.max(1, Math.round(next.height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    },
    dispose() {
      canvas.remove();
    },
  };
}
