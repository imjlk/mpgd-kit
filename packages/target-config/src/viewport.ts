import type { TargetConfig, TargetRuntimeKind } from './runtime.js';

export type TargetViewportOrientation = 'portrait' | 'landscape';
export type TargetViewportOrientationPolicyMode =
  | 'responsive'
  | 'prefer-landscape'
  | 'prefer-portrait'
  | 'lock-landscape'
  | 'lock-portrait';
export type TargetViewportOrientationMismatchBehavior =
  | 'continue'
  | 'letterbox'
  | 'show-rotate-prompt';
export type TargetViewportSizeClass = 'compact' | 'medium' | 'expanded';
export type TargetViewportShell = 'browser' | 'mobile-webview' | 'embedded-webview';
export type TargetViewportMeasurementSource = 'container' | 'visual-viewport' | 'window' | 'unknown';
export type TargetViewportControlPlacement = 'bottom' | 'side';
export type TargetViewportPanelPlacement = 'below' | 'side' | 'drawer';

export interface TargetViewportBreakpoints {
  readonly compactMaxWidth: number;
  readonly expandedMinWidth: number;
}

export interface TargetViewportInput {
  readonly width: number;
  readonly height: number;
  readonly runtime?: TargetRuntimeKind;
  readonly source?: TargetViewportMeasurementSource;
  readonly orientationPolicy?: TargetViewportOrientationPolicy;
}

/**
 * Insets expressed in CSS pixels between a viewport edge and content that can
 * safely receive persistent controls. A target adapter or browser host owns
 * measuring these values; the viewport helpers only normalize their use.
 */
export interface TargetViewportSafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** A rectangular region expressed in the coordinate space of a viewport. */
export interface TargetViewportBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * An optional safe-area extension for an otherwise ordinary viewport
 * measurement. Omitted values are treated as zero.
 */
export interface TargetViewportSnapshotInput extends TargetViewportInput {
  readonly safeAreaInsets?: Partial<TargetViewportSafeAreaInsets>;
}

export interface TargetViewportLayout {
  readonly width: number;
  readonly height: number;
  readonly shortSide: number;
  readonly longSide: number;
  readonly aspectRatio: number;
  readonly orientation: TargetViewportOrientation;
  readonly sizeClass: TargetViewportSizeClass;
  readonly shell: TargetViewportShell;
  readonly source: TargetViewportMeasurementSource;
}

export interface TargetViewportRecommendation {
  readonly primaryControls: TargetViewportControlPlacement;
  readonly secondaryPanels: TargetViewportPanelPlacement;
  readonly safeAreaAware: boolean;
}

export interface TargetViewportOrientationPolicy {
  readonly mode: TargetViewportOrientationPolicyMode;
  readonly mismatchBehavior?: TargetViewportOrientationMismatchBehavior;
}

export interface TargetViewportOrientationPlan {
  readonly mode: TargetViewportOrientationPolicyMode;
  readonly preferredOrientation?: TargetViewportOrientation;
  readonly lockedOrientation?: TargetViewportOrientation;
  readonly mismatchBehavior: TargetViewportOrientationMismatchBehavior;
  readonly isMismatch: boolean;
  readonly shouldLetterbox: boolean;
  readonly shouldShowRotatePrompt: boolean;
}

export interface TargetViewportPlan {
  readonly layout: TargetViewportLayout;
  readonly recommendation: TargetViewportRecommendation;
  readonly orientation: TargetViewportOrientationPlan;
}

/**
 * The effective safe-area insets and the remaining rectangle for a game board
 * or persistent HUD. Insets are clamped to the measured viewport so a malformed
 * host measurement cannot produce a negative-sized content region.
 */
export interface TargetViewportSafeArea {
  readonly insets: TargetViewportSafeAreaInsets;
  readonly contentBounds: TargetViewportBounds;
}

/**
 * A viewport plan enriched with concrete safe-area geometry. It is assignable
 * to `TargetViewportPlan`, so existing scene code can adopt it incrementally.
 */
export interface TargetViewportSnapshot extends TargetViewportPlan {
  readonly safeArea: TargetViewportSafeArea;
}

/**
 * The minimal browser style surface needed to read CSS safe-area custom
 * properties. Keeping this structural avoids a runtime DOM dependency in the
 * target-config package.
 */
export interface TargetViewportComputedStyle {
  getPropertyValue(property: string): string;
}

export interface TargetViewportSafeAreaCssVariables {
  readonly top: string;
  readonly right: string;
  readonly bottom: string;
  readonly left: string;
}

interface TargetViewportOrientationPolicyModeDescriptor {
  readonly preferredOrientation: TargetViewportOrientation | undefined;
  readonly lockedOrientation: TargetViewportOrientation | undefined;
  readonly isLocked: boolean;
}

export const defaultTargetViewportBreakpoints = {
  compactMaxWidth: 599,
  expandedMinWidth: 900,
} as const satisfies TargetViewportBreakpoints;

export const defaultTargetViewportOrientationPolicy = {
  mode: 'responsive',
  mismatchBehavior: 'continue',
} as const satisfies TargetViewportOrientationPolicy;

export const defaultTargetViewportSafeAreaInsets = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
} as const satisfies TargetViewportSafeAreaInsets;

/**
 * CSS variables emitted by the Phaser starter. They deliberately mirror the
 * platform `safe-area-inset-*` environment variables while remaining readable
 * from a Phaser/TypeScript layout pass.
 */
export const defaultTargetViewportSafeAreaCssVariables = {
  top: '--mpgd-safe-area-top',
  right: '--mpgd-safe-area-right',
  bottom: '--mpgd-safe-area-bottom',
  left: '--mpgd-safe-area-left',
} as const satisfies TargetViewportSafeAreaCssVariables;

const targetViewportOrientationPolicyModeDescriptors = {
  responsive: {
    preferredOrientation: undefined,
    lockedOrientation: undefined,
    isLocked: false,
  },
  'prefer-landscape': {
    preferredOrientation: 'landscape',
    lockedOrientation: undefined,
    isLocked: false,
  },
  'prefer-portrait': {
    preferredOrientation: 'portrait',
    lockedOrientation: undefined,
    isLocked: false,
  },
  'lock-landscape': {
    preferredOrientation: 'landscape',
    lockedOrientation: 'landscape',
    isLocked: true,
  },
  'lock-portrait': {
    preferredOrientation: 'portrait',
    lockedOrientation: 'portrait',
    isLocked: true,
  },
} as const satisfies Record<
  TargetViewportOrientationPolicyMode,
  TargetViewportOrientationPolicyModeDescriptor
>;

export function targetViewportShellForRuntime(
  runtime: TargetRuntimeKind,
): TargetViewportShell {
  switch (runtime) {
    case 'capacitor-android':
    case 'capacitor-ios':
    case 'apps-in-toss':
      return 'mobile-webview';
    case 'devvit-web':
    case 'verse8-web':
      return 'embedded-webview';
    case 'web-preview':
    case 'microsoft-store-pwa':
      return 'browser';
  }

  const exhaustive: never = runtime;
  return exhaustive;
}

export function targetViewportShellForConfig(
  config: Pick<TargetConfig, 'runtime'>,
): TargetViewportShell {
  return targetViewportShellForRuntime(config.runtime);
}

export function resolveTargetViewportLayout(
  input: TargetViewportInput,
  breakpoints: TargetViewportBreakpoints = defaultTargetViewportBreakpoints,
): TargetViewportLayout {
  const normalizedBreakpoints = normalizeTargetViewportBreakpoints(breakpoints);
  const width = normalizeViewportDimension(input.width, 'width');
  const height = normalizeViewportDimension(input.height, 'height');
  const aspectRatio = width / height;

  return {
    width,
    height,
    shortSide: Math.min(width, height),
    longSide: Math.max(width, height),
    aspectRatio,
    orientation: width >= height ? 'landscape' : 'portrait',
    sizeClass: classifyTargetViewportSize(width, normalizedBreakpoints),
    shell: input.runtime === undefined ? 'browser' : targetViewportShellForRuntime(input.runtime),
    source: input.source ?? 'unknown',
  };
}

export function resolveTargetViewportSizeClass(
  width: number,
  breakpoints: TargetViewportBreakpoints = defaultTargetViewportBreakpoints,
): TargetViewportSizeClass {
  return classifyTargetViewportSize(
    normalizeViewportDimension(width, 'width'),
    normalizeTargetViewportBreakpoints(breakpoints),
  );
}

export function resolveTargetViewportRecommendation(
  layout: TargetViewportLayout,
): TargetViewportRecommendation {
  const narrowOrPortrait = layout.sizeClass === 'compact' || layout.orientation === 'portrait';
  const browserSafeAreaRisk =
    layout.shell === 'browser' &&
    layout.orientation === 'landscape' &&
    layout.shortSide <= defaultTargetViewportBreakpoints.compactMaxWidth;

  return {
    primaryControls: narrowOrPortrait ? 'bottom' : 'side',
    secondaryPanels: resolveTargetViewportPanelPlacement(layout),
    safeAreaAware:
      layout.shell !== 'browser' || layout.sizeClass === 'compact' || browserSafeAreaRisk,
  };
}

export function resolveTargetViewportOrientationPlan(
  layout: Pick<TargetViewportLayout, 'orientation'>,
  policy: TargetViewportOrientationPolicy = defaultTargetViewportOrientationPolicy,
): TargetViewportOrientationPlan {
  const normalizedPolicy = normalizeTargetViewportOrientationPolicy(policy);
  const descriptor = targetViewportOrientationPolicyModeDescriptors[normalizedPolicy.mode];
  const preferredOrientation = descriptor.preferredOrientation;
  const lockedOrientation = descriptor.lockedOrientation;
  const isMismatch =
    preferredOrientation !== undefined && layout.orientation !== preferredOrientation;
  const mismatchBehavior = normalizedPolicy.mismatchBehavior;

  return {
    mode: normalizedPolicy.mode,
    ...(preferredOrientation === undefined ? {} : { preferredOrientation }),
    ...(lockedOrientation === undefined ? {} : { lockedOrientation }),
    mismatchBehavior,
    isMismatch,
    shouldLetterbox: isMismatch && mismatchBehavior === 'letterbox',
    shouldShowRotatePrompt: isMismatch && mismatchBehavior === 'show-rotate-prompt',
  };
}

export function resolveTargetViewportPlan(
  input: TargetViewportInput,
  breakpoints: TargetViewportBreakpoints = defaultTargetViewportBreakpoints,
): TargetViewportPlan {
  const layout = resolveTargetViewportLayout(input, breakpoints);

  return {
    layout,
    recommendation: resolveTargetViewportRecommendation(layout),
    orientation: resolveTargetViewportOrientationPlan(layout, input.orientationPolicy),
  };
}

/**
 * Build a target viewport plan together with safe-area geometry for games that
 * render persistent DOM controls or position Phaser HUD elements themselves.
 */
export function resolveTargetViewportSnapshot(
  input: TargetViewportSnapshotInput,
  breakpoints: TargetViewportBreakpoints = defaultTargetViewportBreakpoints,
): TargetViewportSnapshot {
  const plan = resolveTargetViewportPlan(input, breakpoints);

  return {
    ...plan,
    safeArea: resolveTargetViewportSafeArea(plan.layout, input.safeAreaInsets),
  };
}

export function resolveTargetViewportSafeArea(
  layout: Pick<TargetViewportLayout, 'width' | 'height'>,
  insets?: Partial<TargetViewportSafeAreaInsets>,
): TargetViewportSafeArea {
  const requested = normalizeTargetViewportSafeAreaInsets(insets);
  const top = Math.min(requested.top, layout.height);
  const bottom = Math.min(requested.bottom, layout.height - top);
  const left = Math.min(requested.left, layout.width);
  const right = Math.min(requested.right, layout.width - left);

  return {
    insets: {
      top,
      right,
      bottom,
      left,
    },
    contentBounds: {
      x: left,
      y: top,
      width: layout.width - left - right,
      height: layout.height - top - bottom,
    },
  };
}

/**
 * Read the starter's computed CSS variables. Unknown or non-pixel values are
 * intentionally treated as zero so browser shells without CSS env support keep
 * the same full-viewport layout as before.
 */
export function readTargetViewportSafeAreaInsets(
  style: TargetViewportComputedStyle,
  variables: TargetViewportSafeAreaCssVariables = defaultTargetViewportSafeAreaCssVariables,
): TargetViewportSafeAreaInsets {
  return {
    top: readTargetViewportCssPixels(style, variables.top),
    right: readTargetViewportCssPixels(style, variables.right),
    bottom: readTargetViewportCssPixels(style, variables.bottom),
    left: readTargetViewportCssPixels(style, variables.left),
  };
}

function classifyTargetViewportSize(
  width: number,
  breakpoints: TargetViewportBreakpoints,
): TargetViewportSizeClass {
  if (width <= breakpoints.compactMaxWidth) {
    return 'compact';
  }

  if (width < breakpoints.expandedMinWidth) {
    return 'medium';
  }

  return 'expanded';
}

function resolveTargetViewportPanelPlacement(
  layout: TargetViewportLayout,
): TargetViewportPanelPlacement {
  if (layout.sizeClass === 'compact') {
    return 'drawer';
  }

  if (layout.orientation === 'portrait') {
    return 'below';
  }

  return 'side';
}

function normalizeTargetViewportOrientationPolicy(
  policy: TargetViewportOrientationPolicy,
): Required<TargetViewportOrientationPolicy> {
  const descriptor = targetViewportOrientationPolicyModeDescriptors[policy.mode];

  return {
    mode: policy.mode,
    mismatchBehavior:
      policy.mismatchBehavior ??
      (descriptor.isLocked ? 'show-rotate-prompt' : 'continue'),
  };
}

function normalizeTargetViewportBreakpoints(
  breakpoints: TargetViewportBreakpoints,
): TargetViewportBreakpoints {
  const compactMaxWidth = normalizeViewportDimension(
    breakpoints.compactMaxWidth,
    'compactMaxWidth',
  );
  const expandedMinWidth = normalizeViewportDimension(
    breakpoints.expandedMinWidth,
    'expandedMinWidth',
  );

  if (compactMaxWidth + 1 >= expandedMinWidth) {
    throw new Error(
      'compactMaxWidth must leave at least one integer width below expandedMinWidth for medium viewports.',
    );
  }

  return {
    compactMaxWidth,
    expandedMinWidth,
  };
}

function normalizeTargetViewportSafeAreaInsets(
  insets: Partial<TargetViewportSafeAreaInsets> | undefined,
): TargetViewportSafeAreaInsets {
  return {
    top: normalizeViewportInset(insets?.top ?? 0, 'top'),
    right: normalizeViewportInset(insets?.right ?? 0, 'right'),
    bottom: normalizeViewportInset(insets?.bottom ?? 0, 'bottom'),
    left: normalizeViewportInset(insets?.left ?? 0, 'left'),
  };
}

function normalizeViewportInset(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Viewport safe-area inset ${name} must be a non-negative finite number.`);
  }

  return Math.round(value);
}

function readTargetViewportCssPixels(
  style: TargetViewportComputedStyle,
  property: string,
): number {
  const value = style.getPropertyValue(property).trim();
  const match = /^(\d+(?:\.\d+)?)px$/u.exec(value);

  return match === null ? 0 : Math.round(Number(match[1]));
}

function normalizeViewportDimension(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Viewport ${name} must be a positive finite number.`);
  }

  const rounded = Math.round(value);

  if (rounded <= 0) {
    throw new Error(`Viewport ${name} must round to at least 1.`);
  }

  return rounded;
}
