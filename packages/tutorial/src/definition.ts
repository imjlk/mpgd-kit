export type TutorialInteraction = 'blocked' | 'target' | 'gameplay' | 'hidden';

export type TutorialAdvance<TAction extends string = string, TSignal extends string = string> =
  | { readonly kind: 'acknowledge' }
  | { readonly action: TAction; readonly kind: 'action' }
  | { readonly kind: 'signal'; readonly signal: TSignal };

export interface TutorialStep<
  TStepId extends string = string,
  TScene extends string = string,
  TTarget extends string = string,
  TAction extends string = string,
  TSignal extends string = string,
  TContent = unknown,
  TMeta = unknown,
> {
  readonly advance: TutorialAdvance<TAction, TSignal>;
  readonly align?: 'start' | 'center' | 'end';
  readonly content?: TContent;
  readonly id: TStepId;
  readonly interaction: TutorialInteraction;
  readonly meta?: TMeta;
  readonly scene: TScene;
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  readonly target: TTarget | null;
}

export interface TutorialDefinition<TStep extends TutorialStep = TutorialStep> {
  readonly id: string;
  readonly initialScene: TStep['scene'];
  readonly revision: number;
  readonly steps: readonly TStep[];
}

export type TutorialStepOf<TDefinition extends TutorialDefinition> =
  TDefinition['steps'][number];
export type TutorialStepIdOf<TDefinition extends TutorialDefinition> =
  TutorialStepOf<TDefinition>['id'];
export type TutorialSceneOf<TDefinition extends TutorialDefinition> =
  TutorialStepOf<TDefinition>['scene'];
export type TutorialActionOf<TDefinition extends TutorialDefinition> =
  Extract<TutorialStepOf<TDefinition>['advance'], { readonly kind: 'action' }>['action'];
export type TutorialSignalOf<TDefinition extends TutorialDefinition> =
  Extract<TutorialStepOf<TDefinition>['advance'], { readonly kind: 'signal' }>['signal'];

export function defineTutorial<const TDefinition extends TutorialDefinition>(
  definition: TDefinition,
): TDefinition {
  if (definition.id.trim().length === 0) {
    throw new Error('Tutorial id must not be empty.');
  }

  if (!Number.isSafeInteger(definition.revision) || definition.revision <= 0) {
    throw new Error('Tutorial revision must be a positive safe integer.');
  }

  if (definition.steps.length === 0) {
    throw new Error('Tutorial must define at least one step.');
  }

  const stepIds = new Set<string>();
  const scenes = new Set<string>();

  for (const step of definition.steps) {
    if (step.id.trim().length === 0) {
      throw new Error('Tutorial step id must not be empty.');
    }

    if (stepIds.has(step.id)) {
      throw new Error(`Duplicate tutorial step id: ${step.id}`);
    }

    if (step.scene.trim().length === 0) {
      throw new Error(`Tutorial step scene must not be empty: ${step.id}`);
    }

    stepIds.add(step.id);
    scenes.add(step.scene);
  }

  if (!scenes.has(definition.initialScene)) {
    throw new Error(`Tutorial initial scene is not used by any step: ${definition.initialScene}`);
  }

  return definition;
}

export function findTutorialStep<TDefinition extends TutorialDefinition>(
  definition: TDefinition,
  stepId: TutorialStepIdOf<TDefinition>,
): TutorialStepOf<TDefinition> | null {
  return definition.steps.find((step) => step.id === stepId) ?? null;
}
