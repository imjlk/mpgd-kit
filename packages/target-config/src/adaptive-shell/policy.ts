import {
  resolveTargetViewportComposition,
  type TargetViewportBounds,
  type TargetViewportComposition,
  type TargetViewportOrientationPolicy,
  type TargetViewportSnapshot,
} from '../viewport.js';

/**
 * Game-owned stage policy. The shell owns the mechanism; each game adapter owns these numbers.
 */
export interface AdaptiveShellPolicy {
  /** Stage width divided by height when expanded viewports render side rails, e.g. `3 / 4`. */
  readonly gameAspectRatio: number;
  /** Narrowest rail that still justifies side rails; narrower viewports use the full bounds. */
  readonly minRailWidth: number;
  /** Orientation policy passed to the viewport snapshot. Defaults to `responsive`. */
  readonly orientationPolicy?: TargetViewportOrientationPolicy;
}

export type AdaptiveShellRailSide = 'left' | 'right';

/**
 * A centered panel slot inside one rail, such as a tutorial popover or an idle-game upgrade list.
 * The slot is ready only when the rail can hold `minWidth` plus the inline gutter and is at least
 * `minRailHeight` tall; its width then grows with the rail up to `maxWidth`.
 */
export interface AdaptiveShellRailSlot {
  readonly rail: AdaptiveShellRailSide;
  /** Shell attribute set to `"true"` while the slot is placed, e.g. `data-tutorial-rail-ready`. */
  readonly readyAttribute: `data-${string}`;
  /** Root custom-property prefix; the shell writes `<prefix>-left`, `-top` and `-width`. */
  readonly cssVariablePrefix: `--${string}`;
  readonly minWidth: number;
  readonly maxWidth: number;
  /** Total horizontal space kept free around the slot (split evenly on both sides). */
  readonly inlineGutter: number;
  readonly minRailHeight: number;
}

/** Viewport-pixel placement of a ready rail slot: centered on `left + width / 2` and on `top`. */
export interface AdaptiveShellRailSlotPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/**
 * Reject a policy the shared composition would refuse, using the same rules as
 * `@mpgd/target-config`, so mount can fail before it restructures the DOM.
 */
export function assertAdaptiveShellPolicy(
  policy: Pick<AdaptiveShellPolicy, 'gameAspectRatio' | 'minRailWidth'>,
): void {
  if (!Number.isFinite(policy.gameAspectRatio) || policy.gameAspectRatio <= 0) {
    throw new RangeError('Adaptive shell gameAspectRatio must be a positive finite number.');
  }

  if (!Number.isFinite(policy.minRailWidth) || policy.minRailWidth < 0) {
    throw new RangeError('Adaptive shell minRailWidth must be a non-negative finite number.');
  }
}

/** Apply a game's stage aspect and rail policy to shared target viewport geometry. */
export function resolveAdaptiveShellComposition(
  viewport: TargetViewportSnapshot,
  policy: Pick<AdaptiveShellPolicy, 'gameAspectRatio' | 'minRailWidth'>,
): TargetViewportComposition {
  return resolveTargetViewportComposition({
    viewport,
    expandedLayout: 'side-rails',
    gameAspectRatio: policy.gameAspectRatio,
    minRailWidth: policy.minRailWidth,
  });
}

/** Rail bounds for one side, or `undefined` when the composition renders no side rails. */
export function resolveAdaptiveShellRailBounds(
  composition: TargetViewportComposition,
  side: AdaptiveShellRailSide,
): TargetViewportBounds | undefined {
  if (composition.mode !== 'side-rails') {
    return undefined;
  }

  return side === 'left' ? composition.leftRailBounds : composition.rightRailBounds;
}

/** Fit a centered slot into rail bounds, or return `undefined` when the rail is too small. */
export function resolveAdaptiveShellRailSlot(
  railBounds: TargetViewportBounds | undefined,
  slot: Pick<AdaptiveShellRailSlot, 'minWidth' | 'maxWidth' | 'inlineGutter' | 'minRailHeight'>,
): AdaptiveShellRailSlotPlacement | undefined {
  if (
    railBounds === undefined
    || railBounds.width < slot.minWidth + slot.inlineGutter
    || railBounds.height < slot.minRailHeight
  ) {
    return undefined;
  }

  const width = Math.min(slot.maxWidth, railBounds.width - slot.inlineGutter);

  return {
    left: railBounds.x + (railBounds.width - width) / 2,
    top: railBounds.y + railBounds.height / 2,
    width,
  };
}

/** Reject slot definitions that could never place, or that would write unscoped names. */
export function assertAdaptiveShellRailSlot(slot: AdaptiveShellRailSlot): void {
  if (slot.rail !== 'left' && slot.rail !== 'right') {
    throw new TypeError(
      `Rail slot ${slot.readyAttribute} rail must be 'left' or 'right': ${String(slot.rail)}`,
    );
  }

  for (const key of ['minWidth', 'maxWidth', 'inlineGutter', 'minRailHeight'] as const) {
    if (!Number.isFinite(slot[key]) || slot[key] < 0) {
      throw new RangeError(
        `Rail slot ${slot.readyAttribute} ${key} must be a finite non-negative number.`,
      );
    }
  }

  if (slot.maxWidth < slot.minWidth) {
    throw new RangeError(
      `Rail slot ${slot.readyAttribute} maxWidth must not be less than minWidth.`,
    );
  }

  if (!/^data-[a-z][a-z0-9-]*$/u.test(slot.readyAttribute)) {
    throw new TypeError(
      `Rail slot readyAttribute must be a lower-case data-* name: ${slot.readyAttribute}`,
    );
  }

  if (!/^--[a-zA-Z][\w-]*$/u.test(slot.cssVariablePrefix)) {
    throw new TypeError(
      `Rail slot cssVariablePrefix must be a custom-property name: ${slot.cssVariablePrefix}`,
    );
  }
}

/** Names a slot must not take because the shell itself writes or reads them. */
export interface AdaptiveShellReservedNames {
  readonly attributes?: readonly string[];
  readonly variablePrefixes?: readonly string[];
}

/**
 * Validate a slot set. Slots share the shell element and the document root, so a repeated ready
 * attribute or variable prefix, or one the shell reserves, would overwrite or clear another
 * slot's placement or the shell's own state.
 */
export function assertAdaptiveShellRailSlots(
  slots: readonly AdaptiveShellRailSlot[],
  reserved: AdaptiveShellReservedNames = {},
): void {
  if (slots.length > 64) {
    throw new RangeError('Adaptive shell supports at most 64 rail slots.');
  }
  const readyAttributes = new Set(reserved.attributes);
  const variablePrefixes = new Set(reserved.variablePrefixes);

  for (const slot of slots) {
    assertAdaptiveShellRailSlot(slot);

    if (readyAttributes.has(slot.readyAttribute)) {
      throw new TypeError(`Rail slot readyAttribute is already in use: ${slot.readyAttribute}`);
    }

    if (variablePrefixes.has(slot.cssVariablePrefix)) {
      throw new TypeError(
        `Rail slot cssVariablePrefix is already in use: ${slot.cssVariablePrefix}`,
      );
    }

    readyAttributes.add(slot.readyAttribute);
    variablePrefixes.add(slot.cssVariablePrefix);
  }
}
