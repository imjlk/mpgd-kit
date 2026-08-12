import type { TutorialDefinition, TutorialSceneOf, TutorialStepIdOf } from './definition.js';

export type TutorialProgressStatus = 'active' | 'completed' | 'skipped';

export interface TutorialProgress<TStepId extends string = string, TScene extends string = string> {
  readonly checkpoint: TScene;
  readonly completedAt: string | null;
  readonly completedStepIds: readonly TStepId[];
  readonly definitionRevision: number;
  readonly schemaVersion: 1;
  readonly skippedAt: string | null;
  readonly status: TutorialProgressStatus;
  readonly tutorialId: string;
  readonly updatedAt: string;
}

export type TutorialProgressOf<TDefinition extends TutorialDefinition> = TutorialProgress<
  TutorialStepIdOf<TDefinition>,
  TutorialSceneOf<TDefinition>
>;

export interface TutorialProgressStore<TProgress extends TutorialProgress = TutorialProgress> {
  readonly available: boolean;
  flush(): Promise<void>;
  getSnapshot(): TProgress | null;
  save(progress: TProgress): Promise<void>;
}

export function createInitialTutorialProgress<TDefinition extends TutorialDefinition>(
  definition: TDefinition,
  now = new Date().toISOString(),
): TutorialProgressOf<TDefinition> {
  return {
    checkpoint: definition.initialScene,
    completedAt: null,
    completedStepIds: [],
    definitionRevision: definition.revision,
    schemaVersion: 1,
    skippedAt: null,
    status: 'active',
    tutorialId: definition.id,
    updatedAt: now,
  };
}

export function createTutorialProgressAtStep<TDefinition extends TutorialDefinition>(
  definition: TDefinition,
  stepId: TutorialStepIdOf<TDefinition>,
  now = new Date().toISOString(),
): TutorialProgressOf<TDefinition> {
  const stepIndex = definition.steps.findIndex((step) => step.id === stepId);

  if (stepIndex < 0) {
    throw new Error(`Unknown tutorial step: ${stepId}`);
  }

  const step = definition.steps[stepIndex];

  if (step === undefined) {
    throw new Error(`Unknown tutorial step: ${stepId}`);
  }

  return {
    ...createInitialTutorialProgress(definition, now),
    checkpoint: step.scene,
    completedStepIds: definition.steps.slice(0, stepIndex).map((candidate) => candidate.id),
  };
}

export function parseTutorialProgress<TDefinition extends TutorialDefinition>(
  definition: TDefinition,
  value: unknown,
): TutorialProgressOf<TDefinition> | null {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.tutorialId !== definition.id
    || value.definitionRevision !== definition.revision
    || !isProgressStatus(value.status)
    || !isTimestamp(value.updatedAt)
    || !(value.completedAt === null || isTimestamp(value.completedAt))
    || !(value.skippedAt === null || isTimestamp(value.skippedAt))
    || typeof value.checkpoint !== 'string'
    || !Array.isArray(value.completedStepIds)) {
    return null;
  }

  const scenes = new Set<string>(definition.steps.map((step) => step.scene));
  const completedStepIds = value.completedStepIds;

  if (!scenes.has(value.checkpoint)
    || completedStepIds.some((id) => typeof id !== 'string')
    || new Set(completedStepIds).size !== completedStepIds.length
    || completedStepIds.length > definition.steps.length
    || completedStepIds.some((id, index) => definition.steps[index]?.id !== id)) {
    return null;
  }

  const complete = completedStepIds.length === definition.steps.length;

  if ((value.status === 'active'
      && (complete || value.completedAt !== null || value.skippedAt !== null))
    || (value.status === 'completed'
      && (!complete || value.completedAt === null || value.skippedAt !== null))
    || (value.status === 'skipped'
      && (complete || value.completedAt !== null || value.skippedAt === null))) {
    return null;
  }

  return {
    checkpoint: value.checkpoint as TutorialSceneOf<TDefinition>,
    completedAt: value.completedAt,
    completedStepIds: completedStepIds as TutorialStepIdOf<TDefinition>[],
    definitionRevision: definition.revision,
    schemaVersion: 1,
    skippedAt: value.skippedAt,
    status: value.status,
    tutorialId: definition.id,
    updatedAt: value.updatedAt,
  };
}

function isProgressStatus(value: unknown): value is TutorialProgressStatus {
  return value === 'active' || value === 'completed' || value === 'skipped';
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
