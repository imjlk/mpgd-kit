import type {
  GameplayE2EDriver,
  GameplayE2EObservation,
  GameplayE2EState,
} from './gameplay-e2e.js';

export interface BrowserGameplayE2EViewport {
  readonly width: number;
  readonly height: number;
}

export interface BrowserGameplayE2EScreenshotOptions {
  readonly path: string;
  readonly type: 'png';
}

/**
 * The minimal Playwright-compatible page surface used by the browser driver.
 * Consumers keep Playwright and browser credentials in their own test harness.
 */
export interface BrowserGameplayE2EPage {
  viewportSize(): BrowserGameplayE2EViewport | null;
  readonly mouse: {
    click(x: number, y: number): Promise<unknown>;
  };
  readonly keyboard: {
    press(key: string): Promise<unknown>;
  };
  waitForTimeout(durationMs: number): Promise<unknown>;
  screenshot(options: BrowserGameplayE2EScreenshotOptions): Promise<unknown>;
}

export interface BrowserGameplayE2EInspectInput<
  TPage extends BrowserGameplayE2EPage = BrowserGameplayE2EPage,
> {
  readonly page: TPage;
  readonly state: GameplayE2EState;
  readonly phase: 'after' | 'before' | 'resumed';
}

export interface CreateBrowserGameplayE2EDriverInput<
  TPage extends BrowserGameplayE2EPage = BrowserGameplayE2EPage,
> {
  readonly page: TPage;
  readonly pause: (page: TPage) => Promise<void>;
  readonly resume: (page: TPage) => Promise<void>;
  readonly inspect: (
    input: BrowserGameplayE2EInspectInput<TPage>,
  ) => Promise<GameplayE2EObservation>;
}

/**
 * Creates a browser driver for generic input and screenshot operations while
 * leaving lifecycle orchestration and game-state inspection with the game.
 */
export function createBrowserGameplayE2EDriver<
  TPage extends BrowserGameplayE2EPage,
>(input: CreateBrowserGameplayE2EDriverInput<TPage>): GameplayE2EDriver {
  return {
    perform: async (action) => {
      switch (action.type) {
        case 'tap': {
          const viewport = readBrowserGameplayE2EViewport(input.page);
          const x = resolveBrowserGameplayE2ETapCoordinate(action.x, viewport.width, 'x');
          const y = resolveBrowserGameplayE2ETapCoordinate(action.y, viewport.height, 'y');

          await input.page.mouse.click(x, y);
          return;
        }
        case 'key':
          await input.page.keyboard.press(action.key);
          return;
        case 'wait':
          await input.page.waitForTimeout(action.durationMs);
          return;
        default: {
          const unsupportedAction: never = action;

          throw new Error(
            `Unsupported browser Gameplay E2E action: ${String(unsupportedAction)}`,
          );
        }
      }
    },
    pause: () => input.pause(input.page),
    resume: () => input.resume(input.page),
    inspect: ({ state, phase }) => input.inspect({ page: input.page, state, phase }),
    captureScreenshot: async ({ file }) => {
      await input.page.screenshot({ path: file, type: 'png' });
    },
  };
}

function readBrowserGameplayE2EViewport(
  page: BrowserGameplayE2EPage,
): BrowserGameplayE2EViewport {
  const viewport = page.viewportSize();

  if (viewport === null) {
    throw new Error('Browser Gameplay E2E taps require a configured page viewport.');
  }

  if (
    !Number.isSafeInteger(viewport.width)
    || viewport.width <= 0
    || !Number.isSafeInteger(viewport.height)
    || viewport.height <= 0
  ) {
    throw new Error('Browser Gameplay E2E viewport dimensions must be positive safe integers.');
  }

  return viewport;
}

function resolveBrowserGameplayE2ETapCoordinate(
  coordinate: number,
  viewportSize: number,
  axis: 'x' | 'y',
): number {
  if (!Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1) {
    throw new Error(`Browser Gameplay E2E ${axis} tap coordinates must be between 0 and 1.`);
  }

  return Math.min(viewportSize - 1, Math.floor(coordinate * viewportSize));
}
