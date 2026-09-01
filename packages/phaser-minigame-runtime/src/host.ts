export type MiniGameHostKind = 'wechat' | 'tiktok';

export interface MiniGameWindowInfo {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly platform?: string;
  readonly language?: string;
}

export interface MiniGameTouch {
  readonly identifier: number;
  readonly clientX: number;
  readonly clientY: number;
}

export type MiniGameRequestResponseType = 'text' | 'arraybuffer' | 'json';

export interface MiniGameRequest {
  readonly url: string;
  readonly method: 'GET';
  readonly headers: Readonly<Record<string, string>>;
  readonly responseType: MiniGameRequestResponseType;
}

export interface MiniGameResponse {
  readonly status: number;
  readonly data: string | ArrayBuffer;
  readonly headers?: Readonly<Record<string, string>>;
  /** Final transport URL after redirects, when the host can report it. */
  readonly url?: string;
}

export interface MiniGameHost {
  readonly kind: MiniGameHostKind;
  getWindowInfo(): MiniGameWindowInfo;
  createCanvas(input?: Readonly<{ readonly type?: 'primary' | 'offscreen' }>): unknown;
  createImage(): unknown;
  requestAnimationFrame(callback: (time: number) => void): number | void;
  cancelAnimationFrame?(id: number): void;
  onTouchStart(callback: (touches: readonly MiniGameTouch[]) => void): () => void;
  onTouchMove(callback: (touches: readonly MiniGameTouch[]) => void): () => void;
  onTouchEnd(callback: (touches: readonly MiniGameTouch[]) => void): () => void;
  onTouchCancel(callback: (touches: readonly MiniGameTouch[]) => void): () => void;
  onPause?(callback: () => void): () => void;
  onResume?(callback: () => void): () => void;
  readLocalFile?(path: string): Promise<ArrayBuffer>;
  request?(input: MiniGameRequest): Promise<MiniGameResponse>;
}

export interface MiniGameTransportOptions {
  /** Exact HTTPS origins permitted for non-package assets. Remote requests are denied by default. */
  readonly allowedRemoteOrigins?: readonly string[];
  readonly requestTimeoutMs?: number;
}

export interface MiniGameImageOptions {
  readonly pollIntervalMs?: number;
  readonly loadTimeoutMs?: number;
  readonly allowedRemoteOrigins?: readonly string[];
}

export interface MiniGameRuntimeOptions {
  readonly image?: MiniGameImageOptions;
  readonly transport?: MiniGameTransportOptions;
  readonly onAnimationFrameError?: (error: unknown) => void;
}

export class MiniGameRuntimeError extends Error {
  override readonly name = 'MiniGameRuntimeError';
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function assertMiniGameWindowInfo(info: MiniGameWindowInfo): void {
  if (!isPositiveFinite(info.width) || !isPositiveFinite(info.height)) {
    throw new MiniGameRuntimeError(
      'MINIGAME_INVALID_WINDOW_SIZE',
      'Mini-game window width and height must be positive finite numbers.',
    );
  }

  if (!isPositiveFinite(info.pixelRatio)) {
    throw new MiniGameRuntimeError(
      'MINIGAME_INVALID_PIXEL_RATIO',
      'Mini-game window pixelRatio must be a positive finite number.',
    );
  }
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
