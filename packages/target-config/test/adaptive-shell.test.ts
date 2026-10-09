// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveTargetViewportSnapshot } from '../src/viewport.js';

import {
  adaptiveShellAttributes,
  assertAdaptiveShellRailSlot,
  assertAdaptiveShellRailSlots,
  mountAdaptiveGameShell,
  resolveAdaptiveShellComposition,
  resolveAdaptiveShellRailSlot,
  type AdaptiveShellRailSlot,
} from '../src/adaptive-shell/index.js';

const widePolicy = { gameAspectRatio: 4 / 3, minRailWidth: 200 };
const panelSlot: AdaptiveShellRailSlot = {
  rail: 'left',
  readyAttribute: 'data-upgrade-panel-ready',
  cssVariablePrefix: '--sample-upgrade-panel',
  minWidth: 220,
  maxWidth: 320,
  inlineGutter: 32,
  minRailHeight: 400,
};

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('style');
  vi.unstubAllGlobals();
});

describe('adaptive shell composition', () => {
  it('applies the supplied aspect ratio and rail policy', () => {
    const composition = resolveAdaptiveShellComposition(
      resolveTargetViewportSnapshot({ width: 1_920, height: 1_080, runtime: 'web-preview' }),
      widePolicy,
    );

    expect(composition).toMatchObject({
      mode: 'side-rails',
      gameBounds: { x: 240, y: 0, width: 1_440, height: 1_080 },
      leftRailBounds: { x: 0, y: 0, width: 240, height: 1_080 },
    });
  });

  it('drops rails narrower than the policy minimum', () => {
    const composition = resolveAdaptiveShellComposition(
      resolveTargetViewportSnapshot({ width: 1_600, height: 1_080, runtime: 'web-preview' }),
      widePolicy,
    );

    expect(composition.mode).not.toBe('side-rails');
    expect(composition.gameBounds).toEqual({ x: 0, y: 0, width: 1_600, height: 1_080 });
  });

  it('keeps a portrait window in a single full-bounds stage', () => {
    const composition = resolveAdaptiveShellComposition(
      resolveTargetViewportSnapshot({ width: 480, height: 900, runtime: 'web-preview' }),
      widePolicy,
    );

    expect(composition.mode).toBe('compact-portrait');
    expect(composition.gameBounds).toEqual({ x: 0, y: 0, width: 480, height: 900 });
  });
});

describe('rail slots', () => {
  it('centers a slot and caps its width', () => {
    expect(resolveAdaptiveShellRailSlot({ x: 0, y: 20, width: 400, height: 600 }, panelSlot))
      .toEqual({ left: 40, top: 320, width: 320 });
    expect(resolveAdaptiveShellRailSlot({ x: 0, y: 0, width: 252, height: 600 }, panelSlot))
      .toEqual({ left: 16, top: 300, width: 220 });
  });

  it('withholds a slot from narrow, short or absent rails', () => {
    expect(resolveAdaptiveShellRailSlot({ x: 0, y: 0, width: 251, height: 600 }, panelSlot))
      .toBeUndefined();
    expect(resolveAdaptiveShellRailSlot({ x: 0, y: 0, width: 400, height: 399 }, panelSlot))
      .toBeUndefined();
    expect(resolveAdaptiveShellRailSlot(undefined, panelSlot)).toBeUndefined();
  });

  it('rejects impossible or unscoped slot definitions', () => {
    expect(() => assertAdaptiveShellRailSlot({ ...panelSlot, maxWidth: 100 })).toThrow(/maxWidth/u);
    expect(() => assertAdaptiveShellRailSlot({ ...panelSlot, inlineGutter: -1 })).toThrow(/inlineGutter/u);
    expect(() => assertAdaptiveShellRailSlot({ ...panelSlot, readyAttribute: 'data-Upper' }))
      .toThrow(/readyAttribute/u);
    expect(() => assertAdaptiveShellRailSlot({ ...panelSlot, cssVariablePrefix: '--' }))
      .toThrow(/cssVariablePrefix/u);
    expect(() => assertAdaptiveShellRailSlot({
      ...panelSlot,
      rail: 'Left' as AdaptiveShellRailSlot['rail'],
    })).toThrow(/rail must be 'left' or 'right'/u);
  });

  it('rejects slots that would overwrite each other or a shell attribute', () => {
    const tutorialSlot: AdaptiveShellRailSlot = {
      ...panelSlot,
      rail: 'right',
      readyAttribute: 'data-tutorial-ready',
      cssVariablePrefix: '--sample-tutorial',
    };

    expect(() => assertAdaptiveShellRailSlots([panelSlot, tutorialSlot])).not.toThrow();
    expect(() => assertAdaptiveShellRailSlots([
      panelSlot,
      { ...tutorialSlot, readyAttribute: panelSlot.readyAttribute },
    ])).toThrow(/readyAttribute is already in use/u);
    expect(() => assertAdaptiveShellRailSlots([
      panelSlot,
      { ...tutorialSlot, cssVariablePrefix: panelSlot.cssVariablePrefix },
    ])).toThrow(/cssVariablePrefix is already in use/u);
    expect(() => mountAdaptiveGameShell({
      gameRoot: mountStage(),
      runtime: 'web-preview',
      policy: { gameAspectRatio: 3 / 4, minRailWidth: 160 },
      railSlots: [{ ...panelSlot, readyAttribute: 'data-composition-mode' }],
    })).toThrow(/readyAttribute is already in use/u);
    expect(() => mountAdaptiveGameShell({
      gameRoot: mountStage(),
      runtime: 'web-preview',
      policy: { gameAspectRatio: 3 / 4, minRailWidth: 160 },
      railSlots: [{ ...panelSlot, cssVariablePrefix: '--mpgd-safe-area' }],
    })).toThrow(/cssVariablePrefix is already in use/u);
  });
});

describe('mounted shell', () => {
  it('creates game-named elements with the package attribute contract', () => {
    const frames = stubFrameLoop();
    setViewportSize(1_280, 720);
    const stage = mountStage();
    const controller = mountAdaptiveGameShell({
      gameRoot: stage,
      runtime: 'web-preview',
      policy: { gameAspectRatio: 3 / 4, minRailWidth: 160 },
      elements: { shellId: 'sample-shell', shellClassName: 'sample-shell', railClassName: 'sample-rail' },
    });

    const shell = document.getElementById('sample-shell');
    expect(shell).toBe(controller.shell);
    expect(controller.stage).toBe(stage);
    expect(shell?.className).toBe('sample-shell');
    expect(shell?.hasAttribute(adaptiveShellAttributes.shell)).toBe(true);
    expect(stage.hasAttribute(adaptiveShellAttributes.stage)).toBe(true);
    expect([...(shell?.children ?? [])]).toEqual([controller.leftRail, stage, controller.rightRail]);
    expect(controller.leftRail.className).toBe('sample-rail');
    expect(controller.leftRail.getAttribute(adaptiveShellAttributes.rail)).toBe('left');
    expect(controller.rightRail.getAttribute(adaptiveShellAttributes.rail)).toBe('right');
    expect(shell?.getAttribute('data-composition-mode')).toBe('side-rails');
    expect(shell?.getAttribute('data-primary-controls')).toBe('side');
    expect(stage.getAttribute('data-layout-mode')).toBe('side-rails');
    expect(stage.getAttribute('data-viewport-orientation')).toBe('landscape');
    expect(stage.style.left).toBe('370px');
    expect(stage.style.width).toBe('540px');
    expect(controller.leftRail.hasAttribute('aria-hidden')).toBe(false);

    const listener = vi.fn();
    controller.subscribe(listener);
    setViewportSize(390, 844);
    window.dispatchEvent(new Event('resize'));
    frames.shift()?.(0);
    expect(listener).toHaveBeenCalledOnce();
    expect(controller.state.composition.mode).toBe('compact-portrait');
    expect(stage.getAttribute('data-viewport-orientation')).toBe('portrait');
    expect(controller.leftRail.style.display).toBe('none');
    expect(controller.leftRail.getAttribute('aria-hidden')).toBe('true');
    controller.destroy();
  });

  it('keeps notifying the other listeners when one throws', async () => {
    const frames = stubFrameLoop();
    setViewportSize(1_280, 720);
    const controller = mountAdaptiveGameShell({
      gameRoot: mountStage(),
      runtime: 'web-preview',
      policy: { gameAspectRatio: 3 / 4, minRailWidth: 160 },
    });
    const failure = new Error('subscriber failed');
    const rethrown: unknown[] = [];
    vi.stubGlobal('queueMicrotask', (task: () => void) => {
      try {
        task();
      } catch (error) {
        rethrown.push(error);
      }
    });
    const later = vi.fn();
    controller.subscribe(() => {
      throw failure;
    });
    controller.subscribe(later);

    setViewportSize(390, 844);
    window.dispatchEvent(new Event('resize'));
    expect(() => frames.shift()?.(0)).not.toThrow();
    expect(later).toHaveBeenCalledOnce();
    expect(rethrown).toEqual([failure]);
    controller.destroy();
  });

  it('omits class names the game does not supply', () => {
    stubFrameLoop();
    setViewportSize(1_280, 720);
    const controller = mountAdaptiveGameShell({
      gameRoot: mountStage(),
      runtime: 'web-preview',
      policy: { gameAspectRatio: 3 / 4, minRailWidth: 160 },
    });

    expect(controller.shell.id).toBe('game-shell');
    expect(controller.shell.hasAttribute('class')).toBe(false);
    expect(controller.leftRail.hasAttribute('class')).toBe(false);
    controller.destroy();
  });

  it('reuses an authored shell and requires both rails', () => {
    stubFrameLoop();
    setViewportSize(1_280, 720);
    document.body.innerHTML = `
      <main id="game-shell">
        <aside data-game-shell-rail="left"></aside>
        <div id="game"></div>
        <aside data-game-shell-rail="right"></aside>
      </main>`;
    const stage = document.getElementById('game') as HTMLElement;
    const controller = mountAdaptiveGameShell({
      gameRoot: stage,
      runtime: 'web-preview',
      policy: { gameAspectRatio: 3 / 4, minRailWidth: 160 },
    });

    expect(document.querySelectorAll('#game-shell')).toHaveLength(1);
    expect(controller.shell.hasAttribute(adaptiveShellAttributes.shell)).toBe(true);
    expect(stage.hasAttribute(adaptiveShellAttributes.stage)).toBe(true);
    controller.destroy();

    document.body.innerHTML = '<main id="game-shell"><div id="game"></div></main>';
    expect(() => mountAdaptiveGameShell({
      gameRoot: document.getElementById('game') as HTMLElement,
      runtime: 'web-preview',
      policy: { gameAspectRatio: 3 / 4, minRailWidth: 160 },
    })).toThrow(/left rail is missing/u);
  });

  it('places rail slots on the document root and clears them on destroy', () => {
    const frames = stubFrameLoop();
    setViewportSize(1_280, 720);
    const controller = mountAdaptiveGameShell({
      gameRoot: mountStage(),
      runtime: 'web-preview',
      policy: { gameAspectRatio: 3 / 4, minRailWidth: 160 },
      railSlots: [panelSlot],
    });
    const rootStyle = document.documentElement.style;

    expect(controller.shell.getAttribute('data-upgrade-panel-ready')).toBe('true');
    expect(rootStyle.getPropertyValue('--sample-upgrade-panel-left')).toBe('25px');
    expect(rootStyle.getPropertyValue('--sample-upgrade-panel-top')).toBe('360px');
    expect(rootStyle.getPropertyValue('--sample-upgrade-panel-width')).toBe('320px');

    setViewportSize(1_280, 390);
    window.dispatchEvent(new Event('resize'));
    frames.shift()?.(0);
    expect(controller.shell.hasAttribute('data-upgrade-panel-ready')).toBe(false);
    expect(rootStyle.getPropertyValue('--sample-upgrade-panel-left')).toBe('');

    setViewportSize(1_280, 720);
    window.dispatchEvent(new Event('resize'));
    frames.shift()?.(0);
    expect(controller.shell.getAttribute('data-upgrade-panel-ready')).toBe('true');
    controller.destroy();
    expect(controller.shell.hasAttribute('data-upgrade-panel-ready')).toBe(false);
    expect(rootStyle.getPropertyValue('--sample-upgrade-panel-width')).toBe('');
  });

  it('refuses an unmeasurable host before touching the DOM', () => {
    stubFrameLoop();
    setViewportSize(0, 0);
    vi.stubGlobal('visualViewport', null);
    const stage = mountStage();

    expect(() => mountAdaptiveGameShell({
      gameRoot: stage,
      runtime: 'web-preview',
      policy: { gameAspectRatio: 3 / 4, minRailWidth: 160 },
    })).toThrow(/measurable viewport/u);
    expect(stage.parentElement).toBe(document.body);
    expect(stage.hasAttribute(adaptiveShellAttributes.stage)).toBe(false);
    expect(document.getElementById('game-shell')).toBeNull();
  });

  it('names an id-less detached stage by its tag', () => {
    stubFrameLoop();
    setViewportSize(1_280, 720);

    expect(() => mountAdaptiveGameShell({
      gameRoot: document.createElement('section'),
      runtime: 'web-preview',
      policy: { gameAspectRatio: 3 / 4, minRailWidth: 160 },
    })).toThrow('Game mount section must have a parent element.');
  });

  it('validates the policy before touching the DOM', () => {
    const stage = mountStage();

    for (const policy of [
      { gameAspectRatio: Number.NaN, minRailWidth: 160 },
      { gameAspectRatio: 0, minRailWidth: 160 },
      { gameAspectRatio: 3 / 4, minRailWidth: Number.POSITIVE_INFINITY },
      { gameAspectRatio: 3 / 4, minRailWidth: -1 },
    ]) {
      expect(() => mountAdaptiveGameShell({ gameRoot: stage, runtime: 'web-preview', policy }))
        .toThrow(/gameAspectRatio|minRailWidth/u);
    }
    expect(stage.parentElement).toBe(document.body);
  });

  it('validates slots before touching the DOM', () => {
    const stage = mountStage();

    expect(() => mountAdaptiveGameShell({
      gameRoot: stage,
      runtime: 'web-preview',
      policy: { gameAspectRatio: 3 / 4, minRailWidth: 160 },
      railSlots: [{ ...panelSlot, minWidth: Number.NaN }],
    })).toThrow(/minWidth/u);
    expect(stage.parentElement).toBe(document.body);
  });
});

function mountStage(): HTMLElement {
  const stage = document.createElement('div');
  stage.id = 'game';
  document.body.append(stage);
  return stage;
}

function stubFrameLoop(): FrameRequestCallback[] {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); });
  return frames;
}

function setViewportSize(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

describe('shell lifetime and input ownership', () => {
  it('disposes the previous owner and ignores late frame callbacks', () => {
    const frames = stubFrameLoop();
    setViewportSize(1280, 720);
    const stage = mountStage();
    const first = mountAdaptiveGameShell({ gameRoot: stage, runtime: 'web-preview', policy: widePolicy });
    const stale = vi.fn();
    first.subscribe(stale);
    window.dispatchEvent(new Event('resize'));
    const second = mountAdaptiveGameShell({ gameRoot: stage, runtime: 'web-preview', policy: widePolicy });
    const current = vi.fn();
    second.subscribe(current);
    first.destroy();
    first.destroy();
    setViewportSize(390, 844);
    while (frames.length) { frames.shift()?.(0); }
    expect(stale).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('resize'));
    frames.shift()?.(0);
    expect(current).toHaveBeenCalledOnce();
    second.destroy();
    window.dispatchEvent(new Event('resize'));
    expect(frames).toHaveLength(0);
  });
  it('snapshots rail slots and policy before later resize events', () => {
    const frames = stubFrameLoop();
    setViewportSize(1280, 720);
    const policy = { gameAspectRatio: 3 / 4, minRailWidth: 160 };
    const slots = [{ ...panelSlot }];
    const controller = mountAdaptiveGameShell({ gameRoot: mountStage(), runtime: 'web-preview', policy, railSlots: slots });
    policy.gameAspectRatio = 100;
    slots[0]!.minWidth = 10000;
    setViewportSize(1920, 1080);
    window.dispatchEvent(new Event('resize'));
    frames.shift()?.(0);
    expect(controller.state.composition.mode).toBe('side-rails');
    expect(controller.shell.getAttribute(panelSlot.readyAttribute)).toBe('true');
    controller.destroy();
  });
  it('rejects excessive slots and invalid measurements before restructuring the DOM', () => {
    stubFrameLoop();
    setViewportSize(1280, 720);
    const stage = mountStage();
    expect(() => mountAdaptiveGameShell({ gameRoot: stage, runtime: 'web-preview', policy: widePolicy,
      railSlots: Array.from({ length: 65 }, () => panelSlot) })).toThrow('64');
    expect(() => mountAdaptiveGameShell({ gameRoot: stage, runtime: 'web-preview', policy: widePolicy,
      initialMeasurement: { width: -1, height: 1, source: 'window' } })).toThrow();
    expect(stage.parentElement).toBe(document.body);
  });
  it('uses the stage document window for embedded surfaces', () => {
    stubFrameLoop();
    setViewportSize(1280, 720);
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    const view = iframe.contentWindow!;
    Object.assign(view, { ResizeObserver: class { observe() {} disconnect() {} },
      requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn() });
    Object.defineProperty(view, 'innerWidth', { value: 390 });
    Object.defineProperty(view, 'innerHeight', { value: 844 });
    const stage = doc.createElement('div');
    doc.body.append(stage);
    const controller = mountAdaptiveGameShell({ gameRoot: stage, runtime: 'web-preview', policy: widePolicy });
    expect(controller.shell.ownerDocument).toBe(doc);
    expect(controller.state.viewport.layout.orientation).toBe('portrait');
    expect(document.getElementById('game-shell')).toBeNull();
    controller.destroy();
  });
});
