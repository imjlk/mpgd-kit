export interface ImpactParticipant {
  readonly id?: number | string;
  readonly kind: string;
  readonly tags?: readonly string[];
}

export interface ImpactContact {
  readonly atMs: number;
  readonly intensity: number;
  readonly normalX: number;
  readonly normalY: number;
  readonly source: ImpactParticipant;
  readonly target: ImpactParticipant;
  readonly x: number;
  readonly y: number;
}

export interface CreateImpactContactInput {
  readonly atMs: number;
  readonly intensity?: number;
  readonly normalX?: number;
  readonly normalY?: number;
  readonly source: ImpactParticipant;
  readonly target: ImpactParticipant;
  readonly x: number;
  readonly y: number;
}

export interface ImpactParticipantSelector {
  readonly kinds?: readonly string[];
  readonly tags?: readonly string[];
}

export interface ImpactFeedbackRule {
  readonly id: string;
  readonly priority?: number;
  readonly recipeId: string;
  readonly source?: ImpactParticipantSelector;
  readonly target?: ImpactParticipantSelector;
}

export interface ImpactRingRecipe {
  readonly color: number;
  readonly endAlpha?: number;
  readonly endRadius: number;
  readonly lineWidth?: number;
  readonly startAlpha?: number;
  readonly startRadius: number;
}

export interface ImpactSparkRecipe {
  /** Local geometry, oriented along the contact normal and the authored spread. */
  readonly shape?: 'line' | 'chevron' | 'bracket' | 'cross';
  readonly color: number;
  readonly count: number;
  readonly endDistance: number;
  readonly length: number;
  readonly spreadRadians: number;
  readonly startDistance?: number;
  readonly width: number;
}

export interface ImpactFlashRecipe {
  readonly color: number;
  readonly durationMs: number;
}

export interface ImpactFeedbackRecipe {
  readonly durationMs: number;
  readonly flash?: ImpactFlashRecipe;
  readonly id: string;
  readonly ring?: ImpactRingRecipe;
  readonly sparks?: ImpactSparkRecipe;
}

export interface ImpactFeedbackCatalogInput {
  readonly recipes: readonly ImpactFeedbackRecipe[];
  readonly rules: readonly ImpactFeedbackRule[];
}

export interface ImpactFeedbackCatalog {
  readonly recipes: ReadonlyMap<string, ImpactFeedbackRecipe>;
  readonly rules: readonly ImpactFeedbackRule[];
}

export interface ImpactFeedbackCarrier {
  readonly impact: ImpactContact;
}

export const MAX_IMPACT_RECIPES = 256;
export const MAX_IMPACT_RULES = 1_024;
const sparkShapes = ['line', 'chevron', 'bracket', 'cross'] as const;
const DEFAULT_NORMAL_X = 0;
const DEFAULT_NORMAL_Y = -1;

export function createImpactContact(input: CreateImpactContactInput): ImpactContact {
  assertNonNegative('atMs', input.atMs);
  assertParticipant(input.source);
  assertParticipant(input.target);
  assertFinite('x', input.x);
  assertFinite('y', input.y);

  const intensity = input.intensity ?? 1;
  assertFinite('intensity', intensity);

  if (intensity < 0) {
    throw new Error('Impact intensity must be greater than or equal to zero.');
  }

  const normalX = input.normalX ?? DEFAULT_NORMAL_X;
  const normalY = input.normalY ?? DEFAULT_NORMAL_Y;
  assertFinite('normalX', normalX);
  assertFinite('normalY', normalY);
  const scale = Math.max(Math.abs(normalX), Math.abs(normalY));
  const length = scale === 0 ? 0 : Math.hypot(normalX / scale, normalY / scale);

  return {
    atMs: input.atMs,
    intensity,
    normalX: length > 0 ? (normalX / scale) / length : DEFAULT_NORMAL_X,
    normalY: length > 0 ? (normalY / scale) / length : DEFAULT_NORMAL_Y,
    source: input.source,
    target: input.target,
    x: input.x,
    y: input.y,
  };
}

export function defineImpactFeedbackCatalog(
  input: ImpactFeedbackCatalogInput,
): ImpactFeedbackCatalog {
  if (!Array.isArray(input.recipes) || input.recipes.length > MAX_IMPACT_RECIPES
    || !Array.isArray(input.rules) || input.rules.length > MAX_IMPACT_RULES) {
    throw new Error('Impact catalog exceeds recipe or rule bounds.');
  }
  const recipes = new Map<string, ImpactFeedbackRecipe>();

  for (const recipe of input.recipes) {
    assertIdentifier('recipe', recipe.id);

    if (recipes.has(recipe.id)) {
      throw new Error(`Duplicate impact feedback recipe id: ${recipe.id}`);
    }

    assertImpactFeedbackRecipe(recipe);
    recipes.set(
      recipe.id,
      Object.freeze({
        ...recipe,
        ...(recipe.ring === undefined ? {} : { ring: Object.freeze({ ...recipe.ring }) }),
        ...(recipe.sparks === undefined ? {} : { sparks: Object.freeze({ ...recipe.sparks }) }),
        ...(recipe.flash === undefined ? {} : { flash: Object.freeze({ ...recipe.flash }) }),
      }),
    );
  }

  const ruleIds = new Set<string>();

  for (const rule of input.rules) {
    assertIdentifier('rule', rule.id);
    assertFinite('rule.priority', rule.priority ?? 0);
    assertSelector(rule.source);
    assertSelector(rule.target);

    if (ruleIds.has(rule.id)) {
      throw new Error(`Duplicate impact feedback rule id: ${rule.id}`);
    }

    if (!recipes.has(rule.recipeId)) {
      throw new Error(
        `Impact feedback rule ${rule.id} references unknown recipe: ${rule.recipeId}`,
      );
    }

    ruleIds.add(rule.id);
  }

  const rules = input.rules
    .map((rule, index) => ({ index, rule }))
    .sort((left, right) =>
      (right.rule.priority ?? 0) - (left.rule.priority ?? 0) || left.index - right.index)
    .map(({ rule }) => Object.freeze({
      ...rule,
      ...(rule.source === undefined ? {} : { source: cloneSelector(rule.source) }),
      ...(rule.target === undefined ? {} : { target: cloneSelector(rule.target) }),
    }));

  return Object.freeze({ recipes, rules: Object.freeze(rules) });
}

export function resolveImpactFeedbackRecipe(
  catalog: ImpactFeedbackCatalog,
  contact: ImpactContact,
): ImpactFeedbackRecipe | undefined {
  for (const rule of catalog.rules) {
    if (
      participantMatches(contact.source, rule.source)
      && participantMatches(contact.target, rule.target)
    ) {
      return catalog.recipes.get(rule.recipeId);
    }
  }

  return undefined;
}

export function hasImpactFeedback(value: unknown): value is ImpactFeedbackCarrier {
  if (typeof value !== 'object' || value === null || !('impact' in value)) {
    return false;
  }

  try {
    assertImpactContact(value.impact as ImpactContact);
    return true;
  } catch {
    return false;
  }
}

function participantMatches(
  participant: ImpactParticipant,
  selector: ImpactParticipantSelector | undefined,
): boolean {
  if (selector === undefined) {
    return true;
  }

  if (selector.kinds !== undefined && !selector.kinds.includes(participant.kind)) {
    return false;
  }

  if (selector.tags === undefined) {
    return true;
  }

  const tags = participant.tags ?? [];
  return selector.tags.every((tag) => tags.includes(tag));
}

export function assertImpactFeedbackRecipe(recipe: ImpactFeedbackRecipe): void {
  assertPositive('durationMs', recipe.durationMs);

  if (recipe.ring !== undefined) {
    assertColor('ring.color', recipe.ring.color);
    assertNonNegative('ring.startRadius', recipe.ring.startRadius);
    assertNonNegative('ring.endRadius', recipe.ring.endRadius);
    assertNonNegative('ring.lineWidth', recipe.ring.lineWidth ?? 2);
    assertUnitInterval('ring.startAlpha', recipe.ring.startAlpha ?? 1);
    assertUnitInterval('ring.endAlpha', recipe.ring.endAlpha ?? 0);
  }

  if (recipe.sparks !== undefined) {
    if (recipe.sparks.shape !== undefined
      && !sparkShapes.includes(recipe.sparks.shape)) {
      throw new Error('Impact recipe sparks.shape must be line, chevron, bracket or cross.');
    }
    assertColor('sparks.color', recipe.sparks.color);

    if (!Number.isInteger(recipe.sparks.count) || recipe.sparks.count < 0 || recipe.sparks.count > 64) {
      throw new Error('Impact recipe sparks.count must be a non-negative integer.');
    }

    assertNonNegative('sparks.startDistance', recipe.sparks.startDistance ?? 0);
    assertNonNegative('sparks.endDistance', recipe.sparks.endDistance);
    assertPositive('sparks.length', recipe.sparks.length);
    assertPositive('sparks.width', recipe.sparks.width);
    assertFinite('sparks.spreadRadians', recipe.sparks.spreadRadians);
  }

  if (recipe.flash !== undefined) {
    assertColor('flash.color', recipe.flash.color);
    assertPositive('flash.durationMs', recipe.flash.durationMs);
  }

  if (recipe.ring === undefined && recipe.sparks === undefined && recipe.flash === undefined) {
    throw new Error(`Impact feedback recipe ${recipe.id} must define at least one effect.`);
  }
}

function assertIdentifier(kind: string, value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new Error(`Impact feedback ${kind} id must not be empty.`);
  }
}

function assertColor(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
    throw new Error(`Impact recipe ${name} must be an integer between 0x000000 and 0xffffff.`);
  }
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Impact ${name} must be finite.`);
  }
}

function assertNonNegative(name: string, value: number): void {
  assertFinite(name, value);

  if (value < 0) {
    throw new Error(`Impact recipe ${name} must be greater than or equal to zero.`);
  }
}

function assertPositive(name: string, value: number): void {
  assertFinite(name, value);

  if (value <= 0) {
    throw new Error(`Impact recipe ${name} must be greater than zero.`);
  }
}

function assertUnitInterval(name: string, value: number): void {
  assertFinite(name, value);

  if (value < 0 || value > 1) {
    throw new Error(`Impact recipe ${name} must be between zero and one.`);
  }
}

export function assertImpactContact(contact: ImpactContact): void {
  if (typeof contact !== 'object' || contact === null) {
    throw new Error('Impact contact must be an object.');
  }
  assertNonNegative('atMs', contact.atMs);
  assertNonNegative('intensity', contact.intensity);
  assertFinite('x', contact.x);
  assertFinite('y', contact.y);
  assertFinite('normalX', contact.normalX);
  assertFinite('normalY', contact.normalY);
  assertParticipant(contact.source);
  assertParticipant(contact.target);
}
function assertParticipant(participant: ImpactParticipant): void {
  if (typeof participant !== 'object' || participant === null) {
    throw new Error('Impact participant must be an object.');
  }
  assertIdentifier('participant kind', participant.kind);
  if (participant.id !== undefined && typeof participant.id !== 'string' && typeof participant.id !== 'number') {
    throw new Error('Impact participant id must be a string or number.');
  }
  if (typeof participant.id === 'number') {
    assertFinite('participant id', participant.id);
  }
  assertLabels(participant.tags);
}
function assertLabels(labels: readonly string[] | undefined): void {
  if (labels === undefined) {
    return;
  }
  if (!Array.isArray(labels) || labels.length > 64) {
    throw new Error('Impact selectors and tags are limited to 64 labels.');
  }
  for (const label of labels) {
    assertIdentifier('label', label);
  }
}
function assertSelector(selector: ImpactParticipantSelector | undefined): void {
  if (selector === undefined) {
    return;
  }
  if (typeof selector !== 'object' || selector === null) {
    throw new Error('Impact selector must be an object.');
  }
  assertLabels(selector.kinds);
  assertLabels(selector.tags);
}
function cloneSelector(selector: ImpactParticipantSelector): ImpactParticipantSelector {
  return Object.freeze({
    ...(selector.kinds === undefined ? {} : { kinds: Object.freeze([...selector.kinds]) }),
    ...(selector.tags === undefined ? {} : { tags: Object.freeze([...selector.tags]) }),
  });
}
