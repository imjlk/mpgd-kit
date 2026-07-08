import type { TargetConfig, TargetRuntimeKind } from './runtime';

export type TargetViewportOrientation = 'portrait' | 'landscape';
export type TargetViewportSizeClass = 'compact' | 'medium' | 'expanded';
export type TargetViewportShell = 'browser' | 'mobile-webview' | 'embedded-webview';
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
}

export interface TargetViewportLayout {
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: number;
  readonly orientation: TargetViewportOrientation;
  readonly sizeClass: TargetViewportSizeClass;
  readonly shell: TargetViewportShell;
}

export interface TargetViewportComposition {
  readonly primaryControls: TargetViewportControlPlacement;
  readonly secondaryPanels: TargetViewportPanelPlacement;
  readonly safeAreaAware: boolean;
}

export interface TargetViewportPlan {
  readonly layout: TargetViewportLayout;
  readonly composition: TargetViewportComposition;
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
    aspectRatio,
    orientation: width >= height ? 'landscape' : 'portrait',
    sizeClass: viewportSizeClass(width, normalizedBreakpoints),
    shell: input.runtime === undefined ? 'browser' : targetViewportShellForRuntime(input.runtime),
  };
}

export function resolveTargetViewportComposition(
  layout: TargetViewportLayout,
): TargetViewportComposition {
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
    composition: resolveTargetViewportComposition(layout),
  };
}

function viewportSizeClass(
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

  if (compactMaxWidth >= expandedMinWidth) {
    throw new Error('compactMaxWidth must be smaller than expandedMinWidth.');
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
