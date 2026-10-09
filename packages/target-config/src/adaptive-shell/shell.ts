import type { TargetRuntimeKind } from '../runtime.js';
import {
  measureTargetViewport,
  readTargetViewportSafeAreaInsets,
  resolveTargetViewportSnapshot,
  waitForTargetViewportMeasurement,
  type TargetViewportBounds,
  type TargetViewportComposition,
  type TargetViewportMeasurement,
  type TargetViewportSnapshot,
} from '../viewport.js';

import {
  assertAdaptiveShellPolicy,
  assertAdaptiveShellRailSlots,
  resolveAdaptiveShellComposition,
  resolveAdaptiveShellRailBounds,
  resolveAdaptiveShellRailSlot,
  type AdaptiveShellPolicy,
  type AdaptiveShellRailSide,
  type AdaptiveShellRailSlot,
} from './policy.js';

/**
 * DOM attributes the shell owns. `base.css` selects the marker attributes; game stylesheets may
 * select the state attributes. Element ids and class names stay game-owned.
 */
export const adaptiveShellAttributes = {
  /** Marker on the outer full-viewport shell element. */
  shell: 'data-game-shell',
  /** Marker on the game mount (the stage). */
  stage: 'data-game-shell-stage',
  /** `left` or `right` on each rail element. */
  rail: 'data-game-shell-rail',
  /** Shell: `side-rails`, `bottom-controls` or `compact-portrait`. */
  compositionMode: 'data-composition-mode',
  /** Shell: where primary controls belong for the current composition. */
  primaryControls: 'data-primary-controls',
  /** Stage: the same composition mode, for selectors scoped under the game mount. */
  layoutMode: 'data-layout-mode',
  /** Stage: `portrait` or `landscape` from the measured viewport layout. */
  viewportOrientation: 'data-viewport-orientation',
} as const;

/** Element naming for a shell the package creates. Defaults to `#game-shell` with no classes. */
export interface AdaptiveShellElementNames {
  readonly shellId?: string;
  readonly shellClassName?: string;
  readonly railClassName?: string;
}

export const defaultAdaptiveShellId = 'game-shell';
const shellOwners = new WeakMap<HTMLElement, () => void>();

/**
 * Root custom-property prefixes the shell reads back (`--mpgd-safe-area-top`, ...). A rail slot
 * using one would shadow the safe-area tokens and skew every composition.
 */
export const adaptiveShellReservedVariablePrefixes = ['--mpgd-safe-area'] as const;

export interface AdaptiveGameShellState {
  readonly composition: TargetViewportComposition;
  readonly viewport: TargetViewportSnapshot;
}

export interface AdaptiveGameShellController {
  readonly shell: HTMLElement;
  readonly stage: HTMLElement;
  readonly leftRail: HTMLElement;
  readonly rightRail: HTMLElement;
  readonly state: AdaptiveGameShellState;
  readonly subscribe: (listener: (state: AdaptiveGameShellState) => void) => () => void;
  /**
   * Stop observing and clear rail slots. The shell, rails, attributes and inline bounds stay in
   * the DOM; the game owns unmounting them, usually by unloading the page.
   */
  readonly destroy: () => void;
}

export interface MountAdaptiveGameShellInput {
  /** The game mount. It becomes the stage between the two rails. */
  readonly gameRoot: HTMLElement;
  readonly runtime: TargetRuntimeKind;
  readonly policy: AdaptiveShellPolicy;
  /** Measurement already obtained from `waitForAdaptiveShellViewport`. */
  readonly initialMeasurement?: TargetViewportMeasurement | undefined;
  readonly elements?: AdaptiveShellElementNames;
  readonly railSlots?: readonly AdaptiveShellRailSlot[];
}

interface ShellElements {
  readonly shell: HTMLElement;
  readonly gameRoot: HTMLElement;
  readonly leftRail: HTMLElement;
  readonly rightRail: HTMLElement;
}

/** Wait for host layout instead of booting the engine with a zero-sized viewport. */
export function waitForAdaptiveShellViewport(container: HTMLElement): Promise<TargetViewportMeasurement> {
  const view = requireWindow(container);
  const doc = container.ownerDocument;
  return waitForTargetViewportMeasurement({
    measure: () => measureContainer(container),
    subscribe: (refresh) => {
      const observer = new view.ResizeObserver(refresh);
      observer.observe(container);
      view.addEventListener('resize', refresh);
      view.visualViewport?.addEventListener('resize', refresh);
      doc.addEventListener('visibilitychange', refresh);
      return () => {
        observer.disconnect();
        view.removeEventListener('resize', refresh);
        view.visualViewport?.removeEventListener('resize', refresh);
        doc.removeEventListener('visibilitychange', refresh);
      };
    },
  });
}

/**
 * Mount the full-viewport shell around `gameRoot` and keep stage/rail bounds in sync.
 * An existing ancestor with the shell id is reused when it already contains both rails.
 */
export function mountAdaptiveGameShell(input: MountAdaptiveGameShellInput): AdaptiveGameShellController {
  const view = requireWindow(input.gameRoot);
  const ownedInput = { ...input, policy: structuredClone(input.policy) };
  const providedRailSlots = input.railSlots ?? [];
  assertAdaptiveShellPolicy(ownedInput.policy);
  assertAdaptiveShellRailSlots(providedRailSlots, {
    attributes: Object.values(adaptiveShellAttributes),
    variablePrefixes: adaptiveShellReservedVariablePrefixes,
  });
  const railSlots = providedRailSlots.map((slot) => Object.freeze({ ...slot }));
  // Measure before restructuring the DOM, so an unmeasurable host fails without a half-built shell.
  // The container measurement falls back to the window, so the shell would measure no better.
  const initialMeasurement = input.initialMeasurement ?? measureContainer(input.gameRoot);
  if (initialMeasurement === null) {
    throw new Error('Wait for a measurable viewport before mounting the game shell.');
  }
  // Validate the viewport/orientation before restructuring an authored mount.
  resolveAdaptiveShellComposition(
    resolveTargetViewportSnapshot({
      ...initialMeasurement,
      runtime: input.runtime,
      orientationPolicy: ownedInput.policy.orientationPolicy ?? { mode: 'responsive' },
    }),
    ownedInput.policy,
  );
  shellOwners.get(input.gameRoot)?.();
  const elements = ensureShellElements(input.gameRoot, input.elements ?? {});
  const listeners = new Set<(state: AdaptiveGameShellState) => void>();
  let animationFrame: number | undefined;
  let destroyed = false;
  let state = resolveShellState(elements.shell, ownedInput, initialMeasurement);

  applyShellState(elements, state, railSlots);

  const refresh = (): void => {
    animationFrame = undefined;
    if (destroyed) {
      return;
    }
    const next = resolveShellState(elements.shell, ownedInput);

    if (next === null || shellStateSignature(next) === shellStateSignature(state)) {
      return;
    }

    state = next;
    applyShellState(elements, state, railSlots);

    for (const listener of listeners) {
      notifyListener(listener, state);
    }
  };
  const scheduleRefresh = (): void => {
    if (destroyed || animationFrame !== undefined) {
      return;
    }

    animationFrame = view.requestAnimationFrame(refresh);
  };
  const resizeObserver = new view.ResizeObserver(scheduleRefresh);

  resizeObserver.observe(elements.shell);
  view.addEventListener('resize', scheduleRefresh);
  view.visualViewport?.addEventListener('resize', scheduleRefresh);

  const controller: AdaptiveGameShellController = {
    shell: elements.shell,
    stage: elements.gameRoot,
    leftRail: elements.leftRail,
    rightRail: elements.rightRail,
    get state() {
      return state;
    },
    subscribe(listener) {
      if (destroyed) {
        return () => undefined;
      }
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      if (shellOwners.get(input.gameRoot) === controller.destroy) {
        shellOwners.delete(input.gameRoot);
      }
      listeners.clear();
      resizeObserver.disconnect();
      view.removeEventListener('resize', scheduleRefresh);
      view.visualViewport?.removeEventListener('resize', scheduleRefresh);

      if (animationFrame !== undefined) {
        view.cancelAnimationFrame(animationFrame);
      }

      for (const slot of railSlots) {
        clearRailSlot(elements.shell, slot);
      }
    },
  };
  shellOwners.set(input.gameRoot, controller.destroy);
  return controller;
}

/**
 * One failing subscriber must not skip the others for this update. Its error is rethrown from a
 * microtask, so it still reaches the host's uncaught-error reporting.
 */
function notifyListener(
  listener: (state: AdaptiveGameShellState) => void,
  state: AdaptiveGameShellState,
): void {
  try {
    listener(state);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

function resolveShellState(
  shell: HTMLElement,
  input: Pick<MountAdaptiveGameShellInput, 'policy' | 'runtime'>,
  fallback: TargetViewportMeasurement,
): AdaptiveGameShellState;
function resolveShellState(
  shell: HTMLElement,
  input: Pick<MountAdaptiveGameShellInput, 'policy' | 'runtime'>,
): AdaptiveGameShellState | null;
function resolveShellState(
  shell: HTMLElement,
  input: Pick<MountAdaptiveGameShellInput, 'policy' | 'runtime'>,
  fallback?: TargetViewportMeasurement,
): AdaptiveGameShellState | null {
  const measurement = measureContainer(shell) ?? fallback;
  if (measurement === undefined) {
    return null;
  }
  const viewport = resolveTargetViewportSnapshot({
    ...measurement,
    runtime: input.runtime,
    orientationPolicy: input.policy.orientationPolicy ?? { mode: 'responsive' },
    safeAreaInsets: readTargetViewportSafeAreaInsets(
      requireWindow(shell).getComputedStyle(shell.ownerDocument.documentElement),
    ),
  });

  return {
    viewport,
    composition: resolveAdaptiveShellComposition(viewport, input.policy),
  };
}

function measureContainer(container: HTMLElement): TargetViewportMeasurement | null {
  const view = requireWindow(container);
  return measureTargetViewport({ container, visualViewport: view.visualViewport, window: view });
}

function ensureShellElements(gameRoot: HTMLElement, names: AdaptiveShellElementNames): ShellElements {
  const shellId = names.shellId ?? defaultAdaptiveShellId;
  const existingShell = findAncestorById(gameRoot, shellId);

  if (existingShell !== null) {
    const leftRail = requireRail(existingShell, 'left');
    const rightRail = requireRail(existingShell, 'right');
    markShellElements(existingShell, gameRoot);

    return { shell: existingShell, gameRoot, leftRail, rightRail };
  }

  const parent = gameRoot.parentElement;

  if (parent === null) {
    const mountLabel = gameRoot.id === '' ? gameRoot.tagName.toLowerCase() : `#${gameRoot.id}`;
    throw new Error(`Game mount ${mountLabel} must have a parent element.`);
  }

  const doc = gameRoot.ownerDocument;
  const shell = doc.createElement('main');
  const leftRail = createRail(doc, 'left', names.railClassName);
  const rightRail = createRail(doc, 'right', names.railClassName);
  shell.id = shellId;
  if (names.shellClassName !== undefined) {
    shell.className = names.shellClassName;
  }
  markShellElements(shell, gameRoot);
  parent.insertBefore(shell, gameRoot);
  shell.append(leftRail, gameRoot, rightRail);

  return { shell, gameRoot, leftRail, rightRail };
}

function findAncestorById(element: HTMLElement, id: string): HTMLElement | null {
  for (let current = element.parentElement; current !== null; current = current.parentElement) {
    if (current.id === id) {
      return current;
    }
  }

  return null;
}

function markShellElements(shell: HTMLElement, gameRoot: HTMLElement): void {
  shell.setAttribute(adaptiveShellAttributes.shell, '');
  gameRoot.setAttribute(adaptiveShellAttributes.stage, '');
}

function requireRail(shell: HTMLElement, side: AdaptiveShellRailSide): HTMLElement {
  const rail = shell.querySelector<HTMLElement>(`[${adaptiveShellAttributes.rail}="${side}"]`);

  if (rail === null) {
    throw new Error(`Game shell ${side} rail is missing.`);
  }

  return rail;
}

function createRail(doc: Document, side: AdaptiveShellRailSide, className: string | undefined): HTMLElement {
  const rail = doc.createElement('aside');
  if (className !== undefined) {
    rail.className = className;
  }
  rail.setAttribute(adaptiveShellAttributes.rail, side);
  rail.setAttribute('aria-hidden', 'true');
  return rail;
}

function applyShellState(
  elements: ShellElements,
  state: AdaptiveGameShellState,
  railSlots: readonly AdaptiveShellRailSlot[],
): void {
  const { composition } = state;
  elements.shell.setAttribute(adaptiveShellAttributes.compositionMode, composition.mode);
  elements.shell.setAttribute(adaptiveShellAttributes.primaryControls, composition.primaryControls);
  elements.gameRoot.setAttribute(adaptiveShellAttributes.layoutMode, composition.mode);
  elements.gameRoot.setAttribute(
    adaptiveShellAttributes.viewportOrientation,
    state.viewport.layout.orientation,
  );
  const leftRailBounds = resolveAdaptiveShellRailBounds(composition, 'left');
  const rightRailBounds = resolveAdaptiveShellRailBounds(composition, 'right');
  applyBounds(elements.gameRoot, composition.gameBounds);
  applyOptionalBounds(elements.leftRail, leftRailBounds);
  applyOptionalBounds(elements.rightRail, rightRailBounds);
  for (const slot of railSlots) {
    applyRailSlot(elements.shell, slot, slot.rail === 'left' ? leftRailBounds : rightRailBounds);
  }
  applyRailVisibility(elements.leftRail, leftRailBounds);
  applyRailVisibility(elements.rightRail, rightRailBounds);
}

function applyRailVisibility(rail: HTMLElement, bounds: TargetViewportBounds | undefined): void {
  if (bounds === undefined) {
    rail.setAttribute('aria-hidden', 'true');
  } else {
    rail.removeAttribute('aria-hidden');
  }
}

/**
 * Slot variables live on the document root so body-mounted overlays (popovers, dialogs) outside
 * the shell subtree can position themselves against the rail.
 */
function applyRailSlot(
  shell: HTMLElement,
  slot: AdaptiveShellRailSlot,
  railBounds: TargetViewportBounds | undefined,
): void {
  const placement = resolveAdaptiveShellRailSlot(railBounds, slot);

  if (placement === undefined) {
    clearRailSlot(shell, slot);
    return;
  }

  const rootStyle = shell.ownerDocument.documentElement.style;
  shell.setAttribute(slot.readyAttribute, 'true');
  rootStyle.setProperty(`${slot.cssVariablePrefix}-left`, `${placement.left}px`);
  rootStyle.setProperty(`${slot.cssVariablePrefix}-top`, `${placement.top}px`);
  rootStyle.setProperty(`${slot.cssVariablePrefix}-width`, `${placement.width}px`);
}

function clearRailSlot(shell: HTMLElement, slot: AdaptiveShellRailSlot): void {
  shell.removeAttribute(slot.readyAttribute);
  const rootStyle = shell.ownerDocument.documentElement.style;
  rootStyle.removeProperty(`${slot.cssVariablePrefix}-left`);
  rootStyle.removeProperty(`${slot.cssVariablePrefix}-top`);
  rootStyle.removeProperty(`${slot.cssVariablePrefix}-width`);
}

function applyBounds(element: HTMLElement, bounds: TargetViewportBounds): void {
  element.style.display = '';
  element.style.left = `${bounds.x}px`;
  element.style.top = `${bounds.y}px`;
  element.style.width = `${bounds.width}px`;
  element.style.height = `${bounds.height}px`;
}

function applyOptionalBounds(element: HTMLElement, bounds: TargetViewportBounds | undefined): void {
  if (bounds === undefined) {
    element.style.display = 'none';
    return;
  }

  applyBounds(element, bounds);
}

function shellStateSignature(state: AdaptiveGameShellState): string {
  return JSON.stringify({
    composition: state.composition,
    layout: state.viewport.layout,
    safeArea: state.viewport.safeArea,
  });
}

function requireWindow(element: HTMLElement): Window & typeof globalThis {
  const view = element.ownerDocument.defaultView;
  if (view === null) {
    throw new Error('Adaptive shell needs a document with a window.');
  }
  return view as Window & typeof globalThis;
}
