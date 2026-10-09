import type Phaser from 'phaser';

import {
  assertImpactContact,
  assertImpactFeedbackRecipe,
  type ImpactContact,
  type ImpactFeedbackRecipe,
} from '../impact/index.js';

export interface PhaserImpactFeedbackPoolOptions {
  readonly capacity?: number;
  readonly depth?: number;
  readonly maxSparksPerEffect?: number;
  readonly rasterRings?: {
    readonly textureKey: string;
    /** A static frame or a registered strip sampled using the existing effect clock. */
    readonly recipeFrames: Readonly<Record<string, string | readonly string[]>>;
  };
}

export interface PhaserImpactFeedbackPoolDiagnostics {
  readonly activeEffects: number;
  readonly availableEffects: number;
  readonly capacity: number;
  readonly emittedEffects: number;
  readonly peakActiveEffects: number;
  readonly recycledEffects: number;
}

interface ImpactEffectSlot {
  readonly index: number;
  active: boolean;
  activeIndex: number;
  endsAtMs: number;
  intensity: number;
  readonly ring: Phaser.GameObjects.Arc;
  readonly rasterRing: Phaser.GameObjects.Image | undefined;
  rasterRingVisible: boolean;
  rasterFrames: readonly string[] | undefined;
  rasterFrameIndex: number;
  ringAlphaDelta: number;
  ringRadiusDelta: number;
  ringStartAlpha: number;
  ringStartRadius: number;
  ringVisible: boolean;
  sparkAlpha: number;
  sparkColor: number;
  sparkCount: number;
  sparkDistance: number;
  sparkDistanceDelta: number;
  readonly sparkDirectionX: number[];
  readonly sparkDirectionY: number[];
  sparkLength: number;
  sparkRenderedLength: number;
  sparkStartDistance: number;
  sparkWidth: number;
  sparkShape: NonNullable<NonNullable<ImpactFeedbackRecipe['sparks']>['shape']>;
  startsAtMs: number;
  x: number;
  y: number;
}

export const MAX_IMPACT_POOL_CAPACITY = 1_024;
export const MAX_IMPACT_POOL_SPARKS = 64;
const DEFAULT_CAPACITY = 48;
const DEFAULT_MAX_SPARKS = 6;
const DEFAULT_DEPTH = 40;

export class PhaserImpactFeedbackPool {
  private activeSparkEffects = 0;
  private readonly activeSlots: ImpactEffectSlot[] = [];
  private destroyed = false;
  private emittedEffects = 0;
  private flashEndsAtMs = Number.NEGATIVE_INFINITY;
  private nextSlotIndex = 0;
  private peakActiveEffects = 0;
  private recycledEffects = 0;
  private readonly slots: readonly ImpactEffectSlot[];
  private readonly availableSlots: ImpactEffectSlot[];
  private readonly sparkBatch: Phaser.GameObjects.Graphics;
  private sparkBatchVisible = false;
  private readonly rasterRings: PhaserImpactFeedbackPoolOptions['rasterRings'];

  constructor(
    private readonly scene: Phaser.Scene,
    options: PhaserImpactFeedbackPoolOptions = {},
  ) {
    const capacity = requirePositiveInteger('capacity', options.capacity ?? DEFAULT_CAPACITY);
    const maxSparks = requireNonNegativeInteger(
      'maxSparksPerEffect',
      options.maxSparksPerEffect ?? DEFAULT_MAX_SPARKS,
    );
    const depth = options.depth ?? DEFAULT_DEPTH;
    if (!Number.isFinite(depth)) {
      throw new Error('Impact depth must be finite.');
    }
    this.rasterRings = copyRasterRings(options.rasterRings);
    if (this.rasterRings !== undefined) {
      if (Object.keys(this.rasterRings.recipeFrames).length > 256) {
        throw new Error('Impact art mappings are limited to 256 recipes.');
      }
      const texture = scene.textures.get(this.rasterRings.textureKey);
      for (const entry of Object.values(this.rasterRings.recipeFrames)) {
        const frames = typeof entry === 'string' ? [entry] : entry;
        if (frames.length === 0 || frames.length > 64) {
          throw new Error('Impact art sequence must not be empty.');
        }
        for (const frame of frames) {
          if (!texture.has(frame)) {
            throw new Error(`Impact art frame is unavailable: ${frame}`);
          }
        }
      }
    }

    this.slots = Array.from({ length: capacity }, (_, index) => {
      const ring = scene.add
        .circle(0, 0, 1, 0xffffff, 0)
        .setStrokeStyle(2, 0xffffff, 1)
        .setDepth(depth)
        .setActive(false)
        .setVisible(false);
      return {
        index,
        active: false,
        activeIndex: -1,
        endsAtMs: 0,
        intensity: 1,
        ring,
        rasterRing: options.rasterRings === undefined ? undefined : scene.add
          .image(0, 0, options.rasterRings.textureKey)
          .setDepth(depth).setActive(false).setVisible(false),
        rasterRingVisible: false,
        rasterFrames: undefined,
        rasterFrameIndex: 0,
        ringAlphaDelta: 0,
        ringRadiusDelta: 0,
        ringStartAlpha: 0,
        ringStartRadius: 0,
        ringVisible: false,
        sparkAlpha: 0,
        sparkColor: 0xffffff,
        sparkCount: 0,
        sparkDistance: 0,
        sparkDistanceDelta: 0,
        sparkDirectionX: Array.from({ length: maxSparks }, () => 0),
        sparkDirectionY: Array.from({ length: maxSparks }, () => -1),
        sparkLength: 0,
        sparkRenderedLength: 0,
        sparkStartDistance: 0,
        sparkWidth: 0,
        sparkShape: 'line',
        startsAtMs: 0,
        x: 0,
        y: 0,
      };
    });
    this.availableSlots = [...this.slots].reverse();
    this.sparkBatch = scene.add
      .graphics()
      .setDepth(depth)
      .setActive(false)
      .setVisible(false);
    scene.events.once('shutdown', this.destroy);
    scene.events.once('destroy', this.destroy);
  }

  emit(contact: ImpactContact, recipe: ImpactFeedbackRecipe): void {
    if (this.destroyed) {
      return;
    }

    assertImpactContact(contact);
    assertImpactFeedbackRecipe(recipe);
    if (!Number.isFinite(contact.atMs + recipe.durationMs)
      || (recipe.flash !== undefined && !Number.isFinite(contact.atMs + recipe.flash.durationMs))) {
      throw new Error('Impact end time must be finite.');
    }
    const slot = this.availableSlots.pop() ?? this.slots[this.nextSlotIndex] as ImpactEffectSlot;

    this.nextSlotIndex = (slot.index + 1) % this.slots.length;

    if (slot.active) {
      this.recycledEffects += 1;
    } else {
      slot.active = true;
      slot.activeIndex = this.activeSlots.length;
      this.activeSlots.push(slot);
      this.peakActiveEffects = Math.max(this.peakActiveEffects, this.activeSlots.length);
    }

    slot.endsAtMs = contact.atMs + recipe.durationMs;
    slot.intensity = Math.max(0.35, Math.min(2.5, contact.intensity));
    slot.startsAtMs = contact.atMs;
    slot.x = contact.x;
    slot.y = contact.y;
    this.emittedEffects += 1;
    this.activateRecipe(slot, contact, recipe);

    if (
      recipe.flash !== undefined
      && contact.atMs >= this.flashEndsAtMs
    ) {
      const { color, durationMs } = recipe.flash;
      this.flashEndsAtMs = contact.atMs + durationMs;
      this.scene.cameras.main.flash(
        durationMs,
        (color >> 16) & 0xff,
        (color >> 8) & 0xff,
        color & 0xff,
        false,
      );
    }
  }

  update(nowMs: number): void {
    if (this.destroyed || !Number.isFinite(nowMs)) {
      return;
    }

    for (let index = this.activeSlots.length - 1; index >= 0; index -= 1) {
      const slot = this.activeSlots[index] as ImpactEffectSlot;
      const durationMs = slot.endsAtMs - slot.startsAtMs;

      if (nowMs >= slot.endsAtMs || durationMs <= 0) {
        this.release(slot);
        continue;
      }

      const progress = Math.max(0, Math.min(1, (nowMs - slot.startsAtMs) / durationMs));
      this.updateRecipe(slot, easeOutCubic(progress), progress);
    }

    this.renderSparkBatch();
  }

  diagnostics(): PhaserImpactFeedbackPoolDiagnostics {
    return {
      activeEffects: this.activeSlots.length,
      availableEffects: this.slots.length - this.activeSlots.length,
      capacity: this.slots.length,
      emittedEffects: this.emittedEffects,
      peakActiveEffects: this.peakActiveEffects,
      recycledEffects: this.recycledEffects,
    };
  }

  /** Release every live effect without destroying the prewarmed pool. */
  clear(): void {
    if (this.destroyed) {
      return;
    }

    while (this.activeSlots.length > 0) {
      const slot = this.activeSlots[this.activeSlots.length - 1] as ImpactEffectSlot;
      this.release(slot);
    }

    this.activeSparkEffects = 0;
    if (this.sparkBatchVisible) {
      this.hideSparkBatch();
    }
    this.flashEndsAtMs = Number.NEGATIVE_INFINITY;
  }

  readonly destroy = (): void => {
    if (this.destroyed) {
      return;
    }

    this.clear();
    this.destroyed = true;
    this.scene.events.off('shutdown', this.destroy);
    this.scene.events.off('destroy', this.destroy);

    for (const slot of this.slots) {
      slot.ring.destroy();
      slot.rasterRing?.destroy();

      slot.active = false;
      slot.activeIndex = -1;
    }

    this.sparkBatch.destroy();
    this.activeSparkEffects = 0;
    this.activeSlots.length = 0;
    this.availableSlots.length = 0;
  };

  private activateRecipe(
    slot: ImpactEffectSlot,
    contact: ImpactContact,
    recipe: ImpactFeedbackRecipe,
  ): void {
    const { intensity } = slot;
    const hadSparks = slot.sparkCount > 0;
    const ring = recipe.ring;
    const rasterEntry = this.rasterRings?.recipeFrames[recipe.id];
    slot.rasterFrames = typeof rasterEntry === 'string' ? undefined : rasterEntry;
    slot.rasterFrameIndex = 0;
    const rasterFrame = typeof rasterEntry === 'string' ? rasterEntry : rasterEntry?.[0];
    slot.rasterRingVisible = ring !== undefined && rasterFrame !== undefined;
    slot.rasterRing?.setActive(slot.rasterRingVisible).setVisible(slot.rasterRingVisible);
    if (slot.rasterRingVisible && rasterFrame !== undefined) {
      slot.rasterRing?.setFrame(rasterFrame).setPosition(slot.x, slot.y);
    }

    if (ring === undefined) {
      slot.ringVisible = false;
      slot.ring.setActive(false).setVisible(false);
    } else {
      slot.ringStartAlpha = ring.startAlpha ?? 1;
      slot.ringAlphaDelta = (ring.endAlpha ?? 0) - slot.ringStartAlpha;
      slot.ringStartRadius = ring.startRadius * intensity;
      slot.ringRadiusDelta = (ring.endRadius - ring.startRadius) * intensity;
      slot.ringVisible = true;
      slot.ring
        .setPosition(slot.x, slot.y)
        .setRadius(slot.ringStartRadius)
        .setFillStyle(ring.color, 0.12)
        .setStrokeStyle(ring.lineWidth ?? 2, ring.color, 1)
        .setAlpha(slot.ringStartAlpha)
        .setActive(!slot.rasterRingVisible)
        .setVisible(!slot.rasterRingVisible);
      slot.rasterRing?.setDisplaySize(slot.ringStartRadius * 2, slot.ringStartRadius * 2)
        .setAlpha(slot.ringStartAlpha);
    }

    const recipeSparks = recipe.sparks;
    const sparkCount = Math.min(recipeSparks?.count ?? 0, slot.sparkDirectionX.length);
    slot.sparkCount = sparkCount;

    if (hadSparks !== (sparkCount > 0)) {
      this.activeSparkEffects += sparkCount > 0 ? 1 : -1;
    }

    if (recipeSparks !== undefined) {
      slot.sparkShape = recipeSparks.shape ?? 'line';
      slot.sparkAlpha = 1;
      slot.sparkColor = recipeSparks.color;
      slot.sparkDistance = (recipeSparks.startDistance ?? 0) * intensity;
      slot.sparkStartDistance = (recipeSparks.startDistance ?? 0) * intensity;
      slot.sparkDistanceDelta =
        (recipeSparks.endDistance - (recipeSparks.startDistance ?? 0)) * intensity;
      slot.sparkLength = recipeSparks.length * intensity;
      slot.sparkRenderedLength = slot.sparkLength;
      slot.sparkWidth = recipeSparks.width;
    }

    const normalAngle = sparkCount > 0 ? Math.atan2(contact.normalY, contact.normalX) : 0;

    for (let index = 0; recipeSparks !== undefined && index < sparkCount; index += 1) {
      const angleRatio = sparkCount <= 1 ? 0.5 : index / (sparkCount - 1);
      const angle = normalAngle + (angleRatio - 0.5) * recipeSparks.spreadRadians;
      slot.sparkDirectionX[index] = Math.cos(angle);
      slot.sparkDirectionY[index] = Math.sin(angle);
    }
  }

  private updateRecipe(slot: ImpactEffectSlot, progress: number, frameProgress: number): void {
    if (slot.ringVisible) {
      const radius = slot.ringStartRadius + slot.ringRadiusDelta * progress;
      const alpha = slot.ringStartAlpha + slot.ringAlphaDelta * progress;
      if (slot.rasterRingVisible) {
        if (slot.rasterFrames !== undefined) {
          const count = slot.rasterFrames.length;
          const index = Math.min(count - 1, Math.floor(frameProgress * count));
          const frame = slot.rasterFrames[index];
          if (index !== slot.rasterFrameIndex && frame !== undefined) {
            slot.rasterRing?.setFrame(frame);
            slot.rasterFrameIndex = index;
          }
        }
        slot.rasterRing?.setDisplaySize(radius * 2, radius * 2).setAlpha(alpha);
      } else {
        slot.ring.setRadius(radius).setAlpha(alpha);
      }
    }

    const distance = slot.sparkStartDistance + slot.sparkDistanceDelta * progress;
    const linearAlpha = 1 - (slot.sparkShape === 'line' ? progress : frameProgress);
    slot.sparkAlpha = linearAlpha * linearAlpha;
    slot.sparkDistance = distance;
    slot.sparkRenderedLength = slot.sparkShape === 'bracket' || slot.sparkShape === 'cross'
      ? slot.sparkLength
      : slot.sparkLength * (1 - progress * 0.45);
  }

  private renderSparkBatch(): void {
    if (this.activeSparkEffects === 0) {
      if (this.sparkBatchVisible) {
        this.hideSparkBatch();
      }

      return;
    }

    this.sparkBatch.clear();

    for (const slot of this.activeSlots) {
      if (slot.sparkCount === 0 || slot.sparkAlpha <= 0 || slot.sparkRenderedLength <= 0) {
        continue;
      }

      const halfLength = slot.sparkRenderedLength / 2;
      this.sparkBatch.lineStyle(slot.sparkWidth, slot.sparkColor, slot.sparkAlpha);
      this.sparkBatch.beginPath();

      for (let index = 0; index < slot.sparkCount; index += 1) {
        const directionX = slot.sparkDirectionX[index] ?? 0;
        const directionY = slot.sparkDirectionY[index] ?? 0;
        const centerX = slot.x + directionX * slot.sparkDistance;
        const centerY = slot.y + directionY * slot.sparkDistance;
        if (slot.sparkShape !== 'line') {
          // Reuse the same Graphics batch and precomputed directions: no per-hit objects.
          const motion = slot.sparkDistanceDelta < 0 ? -1 : 1;
          const dx = directionX * halfLength;
          const dy = directionY * halfLength;
          const px = -dy;
          const py = dx;
          if (slot.sparkShape === 'chevron') {
            this.sparkBatch.moveTo(centerX - dx * motion + px, centerY - dy * motion + py);
            this.sparkBatch.lineTo(centerX + dx * motion, centerY + dy * motion);
            this.sparkBatch.lineTo(centerX - dx * motion - px, centerY - dy * motion - py);
          } else if (slot.sparkShape === 'bracket') {
            this.sparkBatch.moveTo(centerX + dx - px, centerY + dy - py);
            this.sparkBatch.lineTo(centerX + dx + px, centerY + dy + py);
            this.sparkBatch.lineTo(centerX - dx + px, centerY - dy + py);
          } else {
            this.sparkBatch.moveTo(centerX - dx, centerY - dy);
            this.sparkBatch.lineTo(centerX + dx, centerY + dy);
            this.sparkBatch.moveTo(centerX - px, centerY - py);
            this.sparkBatch.lineTo(centerX + px, centerY + py);
          }
          continue;
        }
        this.sparkBatch.moveTo(
          centerX - directionX * halfLength,
          centerY - directionY * halfLength,
        );
        this.sparkBatch.lineTo(
          centerX + directionX * halfLength,
          centerY + directionY * halfLength,
        );
      }

      this.sparkBatch.strokePath();
    }

    if (!this.sparkBatchVisible) {
      this.sparkBatch.setActive(true).setVisible(true);
      this.sparkBatchVisible = true;
    }
  }

  private hideSparkBatch(): void {
    this.sparkBatch.clear().setActive(false).setVisible(false);
    this.sparkBatchVisible = false;
  }

  private release(slot: ImpactEffectSlot): void {
    slot.active = false;
    slot.ring.setActive(false).setVisible(false);
    slot.rasterRing?.setActive(false).setVisible(false);
    slot.rasterRingVisible = false;
    slot.rasterFrames = undefined;
    slot.rasterFrameIndex = 0;

    if (slot.sparkCount > 0) {
      this.activeSparkEffects -= 1;
      slot.sparkCount = 0;
    }

    const activeIndex = slot.activeIndex;
    const lastSlot = this.activeSlots.pop();

    if (lastSlot !== undefined && lastSlot !== slot) {
      this.activeSlots[activeIndex] = lastSlot;
      lastSlot.activeIndex = activeIndex;
    }

    slot.activeIndex = -1;
    this.availableSlots.push(slot);
  }
}

function easeOutCubic(value: number): number {
  return 1 - (1 - value) ** 3;
}

function requireNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_IMPACT_POOL_SPARKS) {
    throw new Error(`Phaser impact feedback ${name} must be a non-negative integer.`);
  }

  return value;
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_IMPACT_POOL_CAPACITY) {
    throw new Error(`Phaser impact feedback ${name} must be a positive integer.`);
  }

  return value;
}

function copyRasterRings(
  input: PhaserImpactFeedbackPoolOptions['rasterRings'],
): PhaserImpactFeedbackPoolOptions['rasterRings'] {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input.textureKey !== 'string' || input.textureKey.length === 0
    || input.textureKey.length > 256) {
    throw new Error('Impact texture key is invalid.');
  }
  const keys = Object.keys(input.recipeFrames);
  if (keys.length > 256) {
    throw new Error('Impact art mappings are limited to 256 recipes.');
  }
  const frames: Record<string, string | readonly string[]> = Object.create(null);
  for (const key of keys) {
    const entry = input.recipeFrames[key];
    if (key.length === 0 || key.length > 256 || entry === undefined
      || (typeof entry !== 'string' && (!Array.isArray(entry) || entry.length === 0
        || entry.length > 64))) {
      throw new Error('Impact art sequence is invalid.');
    }
    const names = typeof entry === 'string' ? [entry] : entry;
    for (const name of names) {
      if (typeof name !== 'string' || name.length === 0 || name.length > 256) {
        throw new Error('Impact art frame name is invalid.');
      }
    }
    frames[key] = typeof entry === 'string' ? entry : Object.freeze([...entry]);
  }
  return Object.freeze({ textureKey: input.textureKey, recipeFrames: Object.freeze(frames) });
}
