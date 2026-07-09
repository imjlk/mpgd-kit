import type { TargetConfig, TargetRuntimeKind } from './runtime';

export type TargetViewportOrientation = 'portrait' | 'landscape';
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

export interface TargetViewportPlan {
  readonly layout: TargetViewportLayout;
  readonly recommendation: TargetViewportRecommendation;
}

export const defaultTargetViewportBreakpoints = {
  compactMaxWidth: 599,
  expandedMinWidth: 900,
} as const satisfies TargetViewportBreakpoints;

export function targetViewportShellForRuntime(
  runtime: TargetRuntimeKind,
): TargetViewportShell {
  switch (runtime) {
    case 'capacitor-android':
    case 'capacitor-ios':
    case 'apps-in-toss':
      return 'mobile-webview';
    case 'devvit-web':
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

  return {
    primaryControls: narrowOrPortrait ? 'bottom' : 'side',
    secondaryPanels: resolveTargetViewportPanelPlacement(layout),
    safeAreaAware: layout.shell !== 'browser' || layout.sizeClass === 'compact',
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
