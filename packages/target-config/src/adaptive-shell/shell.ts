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
const documentSlotOwners = new WeakMap<Document, Map<string, () => void>>();

interface InlineStyleEntry {
  readonly value: string;
  readonly priority: string;
  applied: string;
}

interface InlineStyleClaim {
  readonly owners: Set<object>;
  /** The `style` attribute before the shell's first write. */
  readonly authored: string | null;
  readonly entries: Map<string, InlineStyleEntry>;
}

/**
 * Inline properties the shell replaced on each element, so destroy can hand the element back as
 * authored. Claims are per element, not per controller: stages sharing an authored shell keep the
 * first original value, and it is restored only once every controller that wrote it is destroyed.
 */
const inlineStyleClaims = new WeakMap<HTMLElement, InlineStyleClaim>();

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
   * Stop observing, clear rail slots and restore the inline layout the shell wrote on the shell,
   * stage and rails. The elements and their attributes stay in the DOM; the game owns unmounting
   * them, usually by unloading the page.
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
export function waitForAdaptiveShellViewport(
  container: HTMLElement,
  options: { readonly signal?: AbortSignal } = {},
): Promise<TargetViewportMeasurement> {
  const view = requireWindow(container);
  const doc = container.ownerDocument;
  return waitForTargetViewportMeasurement({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    measure: () => measureContainer(container),
    subscribe: (refresh) => {
      const observer = new view.ResizeObserver(refresh);
      observer.observe(container);
      view.addEventListener('resize', refresh);
      view.visualViewport?.addEventListener('resize', refresh);
      view.visualViewport?.addEventListener('scroll', refresh);
      doc.addEventListener('visibilitychange', refresh);
      return () => {
        observer.disconnect();
        view.removeEventListener('resize', refresh);
        view.visualViewport?.removeEventListener('resize', refresh);
        view.visualViewport?.removeEventListener('scroll', refresh);
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
  const doc = input.gameRoot.ownerDocument;
  const previousOwner = shellOwners.get(input.gameRoot);
  const slotOwners = documentSlotOwners.get(doc) ?? new Map<string, () => void>();
  for (const slot of railSlots) {
    const owner = slotOwners.get(slot.cssVariablePrefix);
    if (owner !== undefined && owner !== previousOwner) {
      throw new Error(
        `Rail slot cssVariablePrefix is already in use in this document: ${slot.cssVariablePrefix}`,
      );
    }
  }
  // Measure before restructuring the DOM, so an unmeasurable host fails without a half-built shell.
  // Prefer the visible viewport for this fixed full-window shell.
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
  previousOwner?.();
  const elements = ensureShellElements(input.gameRoot, input.elements ?? {});
  const listeners = new Set<(state: AdaptiveGameShellState) => void>();
  let animationFrame: number | undefined;
  let destroyed = false;
  let state = resolveShellState(elements.shell, ownedInput, initialMeasurement);
  let offset = visualViewportOffset(elements.shell);
  const styleOwner = {};

  applyShellState(styleOwner, elements, state, railSlots, offset);

  const refresh = (): void => {
    animationFrame = undefined;
    if (destroyed) {
      return;
    }
    const next = resolveShellState(elements.shell, ownedInput);
    const nextOffset = visualViewportOffset(elements.shell);

    if (next === null || (shellStateSignature(next) === shellStateSignature(state)
      && nextOffset.x === offset.x && nextOffset.y === offset.y)) {
      return;
    }

    state = next;
    offset = nextOffset;
    applyShellState(styleOwner, elements, state, railSlots, offset);

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
  view.visualViewport?.addEventListener('scroll', scheduleRefresh);

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
      view.visualViewport?.removeEventListener('scroll', scheduleRefresh);

      if (animationFrame !== undefined) {
        view.cancelAnimationFrame(animationFrame);
      }

      for (const slot of railSlots) {
        if (slotOwners.get(slot.cssVariablePrefix) === controller.destroy) {
          slotOwners.delete(slot.cssVariablePrefix);
          clearRailSlot(elements.shell, slot);
        }
      }
      for (const element of [elements.shell, elements.gameRoot, elements.leftRail, elements.rightRail]) {
        releaseInlineStyles(styleOwner, element);
      }
    },
  };
  shellOwners.set(input.gameRoot, controller.destroy);
  documentSlotOwners.set(doc, slotOwners);
  for (const slot of railSlots) {
    slotOwners.set(slot.cssVariablePrefix, controller.destroy);
  }
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
  return measureTargetViewport({ visualViewport: view.visualViewport, window: view })
    ?? measureTargetViewport({ container });
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
  owner: object,
  elements: ShellElements,
  state: AdaptiveGameShellState,
  railSlots: readonly AdaptiveShellRailSlot[],
  offset: { readonly x: number; readonly y: number },
): void {
  const { composition } = state;
  writeInlineStyle(owner, elements.shell, 'left', `${offset.x}px`);
  writeInlineStyle(owner, elements.shell, 'top', `${offset.y}px`);
  writeInlineStyle(owner, elements.shell, 'right', 'auto');
  writeInlineStyle(owner, elements.shell, 'bottom', 'auto');
  writeInlineStyle(owner, elements.shell, 'width', `${state.viewport.layout.width}px`);
  writeInlineStyle(owner, elements.shell, 'height', `${state.viewport.layout.height}px`);
  elements.shell.setAttribute(adaptiveShellAttributes.compositionMode, composition.mode);
  elements.shell.setAttribute(adaptiveShellAttributes.primaryControls, composition.primaryControls);
  elements.gameRoot.setAttribute(adaptiveShellAttributes.layoutMode, composition.mode);
  elements.gameRoot.setAttribute(
    adaptiveShellAttributes.viewportOrientation,
    state.viewport.layout.orientation,
  );
  const leftRailBounds = resolveAdaptiveShellRailBounds(composition, 'left');
  const rightRailBounds = resolveAdaptiveShellRailBounds(composition, 'right');
  applyBounds(owner, elements.gameRoot, composition.gameBounds);
  applyOptionalBounds(owner, elements.leftRail, leftRailBounds);
  applyOptionalBounds(owner, elements.rightRail, rightRailBounds);
  for (const slot of railSlots) {
    const bounds = slot.rail === 'left' ? leftRailBounds : rightRailBounds;
    applyRailSlot(
      elements.shell,
      slot,
      bounds === undefined
        ? undefined
        : { ...bounds, x: bounds.x + offset.x, y: bounds.y + offset.y },
    );
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

/** `base.css` insets the stage to fill the shell after teardown; `auto` keeps px bounds in RTL. */
function applyBounds(owner: object, element: HTMLElement, bounds: TargetViewportBounds): void {
  writeInlineStyle(owner, element, 'display', '');
  writeInlineStyle(owner, element, 'left', `${bounds.x}px`);
  writeInlineStyle(owner, element, 'top', `${bounds.y}px`);
  writeInlineStyle(owner, element, 'right', 'auto');
  writeInlineStyle(owner, element, 'bottom', 'auto');
  writeInlineStyle(owner, element, 'width', `${bounds.width}px`);
  writeInlineStyle(owner, element, 'height', `${bounds.height}px`);
}

function applyOptionalBounds(
  owner: object,
  element: HTMLElement,
  bounds: TargetViewportBounds | undefined,
): void {
  if (bounds === undefined) {
    writeInlineStyle(owner, element, 'display', 'none');
    return;
  }

  applyBounds(owner, element, bounds);
}

/** Write an inline property, remembering the value it replaced on first write. */
function writeInlineStyle(owner: object, element: HTMLElement, property: string, value: string): void {
  let claim = inlineStyleClaims.get(element);
  if (claim === undefined) {
    claim = { owners: new Set(), authored: element.getAttribute('style'), entries: new Map() };
    inlineStyleClaims.set(element, claim);
  }
  claim.owners.add(owner);
  let entry = claim.entries.get(property);
  if (entry === undefined) {
    entry = {
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
      applied: '',
    };
    claim.entries.set(property, entry);
  }
  element.style.setProperty(property, value);
  // Read back the serialized value so the destroy comparison matches the browser's spelling.
  entry.applied = element.style.getPropertyValue(property);
}

/**
 * Restore what the shell replaced once no live controller still writes the element. A property
 * the game changed after the shell's last write is the game's and stays.
 */
function releaseInlineStyles(owner: object, element: HTMLElement): void {
  const claim = inlineStyleClaims.get(element);
  if (claim === undefined || !claim.owners.delete(owner) || claim.owners.size > 0) {
    return;
  }
  inlineStyleClaims.delete(element);
  // The shell writes without priority, so an added `!important` is the game's too.
  const shellOwned = [...claim.entries].filter(([property, entry]) =>
    element.style.getPropertyValue(property) === entry.applied
    && element.style.getPropertyPriority(property) === '');
  if (shellOwned.length === claim.entries.size
    && withoutProperties(element, element.getAttribute('style'), claim.entries)
      === withoutProperties(element, claim.authored, claim.entries)) {
    // Nothing else changed: put the authored text back verbatim. Per-property restore loses a
    // `var()` shorthand and the order of physical and logical declarations.
    if (claim.authored === null) {
      element.removeAttribute('style');
    } else {
      element.setAttribute('style', claim.authored);
    }
    return;
  }
  for (const [property, entry] of shellOwned) {
    if (entry.value === '') {
      element.style.removeProperty(property);
    } else {
      element.style.setProperty(property, entry.value, entry.priority);
    }
  }
}

function withoutProperties(
  element: HTMLElement,
  styleText: string | null,
  properties: ReadonlyMap<string, unknown>,
): string {
  const probe = element.ownerDocument.createElement('div');
  probe.setAttribute('style', styleText ?? '');
  for (const property of properties.keys()) {
    probe.style.removeProperty(property);
  }
  return probe.style.cssText;
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

function visualViewportOffset(element: HTMLElement): { readonly x: number; readonly y: number } {
  const viewport = requireWindow(element).visualViewport;
  if ((viewport === null || viewport === undefined) || measureTargetViewport({ visualViewport: viewport }) === null) {
    return { x: 0, y: 0 };
  }
  return {
    x: Number.isFinite(viewport.offsetLeft) ? viewport.offsetLeft : 0,
    y: Number.isFinite(viewport.offsetTop) ? viewport.offsetTop : 0,
  };
}
