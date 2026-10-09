import { describe, expect, it } from 'vitest';

import {
  createImpactContact,
  defineImpactFeedbackCatalog,
  hasImpactFeedback,
  resolveImpactFeedbackRecipe,
} from './index.js';

const recipes = [
  {
    durationMs: 180,
    id: 'fallback',
    ring: { color: 0xffffff, endRadius: 18, startRadius: 4 },
  },
  {
    durationMs: 240,
    id: 'projectile-target',
    sparks: {
      color: 0xffc857,
      count: 4,
      endDistance: 30,
      length: 12,
      spreadRadians: Math.PI,
      width: 3,
    },
  },
] as const;

describe('impact feedback contracts', () => {
  it('normalizes contact normals and falls back for zero-length vectors', () => {
    const normalized = createImpactContact({
      atMs: 120,
      normalX: 3,
      normalY: 4,
      source: { kind: 'projectile' },
      target: { kind: 'enemy' },
      x: 10,
      y: 20,
    });
    const fallback = createImpactContact({
      atMs: 140,
      normalX: 0,
      normalY: 0,
      source: { kind: 'enemy' },
      target: { kind: 'worker' },
      x: 30,
      y: 40,
    });

    expect(normalized.normalX).toBeCloseTo(0.6);
    expect(normalized.normalY).toBeCloseTo(0.8);
    expect(fallback.normalX).toBe(0);
    expect(fallback.normalY).toBe(-1);
  });

  it('resolves the highest-priority matching participant rule', () => {
    const catalog = defineImpactFeedbackCatalog({
      recipes,
      rules: [
        { id: 'fallback', recipeId: 'fallback' },
        {
          id: 'projectile-target',
          priority: 10,
          recipeId: 'projectile-target',
          source: { kinds: ['projectile'], tags: ['owned'] },
          target: { kinds: ['enemy'] },
        },
      ],
    });
    const contact = createImpactContact({
      atMs: 500,
      source: { kind: 'projectile', tags: ['damage', 'owned'] },
      target: { kind: 'enemy', tags: ['solid'] },
      x: 100,
      y: 200,
    });

    expect(resolveImpactFeedbackRecipe(catalog, contact)?.id).toBe('projectile-target');
  });

  it('rejects duplicate ids, missing recipes, and invalid recipes', () => {
    expect(() =>
      defineImpactFeedbackCatalog({
        recipes: [recipes[0], recipes[0]],
        rules: [],
      }),
    ).toThrow('Duplicate impact feedback recipe id: fallback');
    expect(() =>
      defineImpactFeedbackCatalog({
        recipes,
        rules: [{ id: 'missing', recipeId: 'unknown' }],
      }),
    ).toThrow('references unknown recipe: unknown');
    expect(() =>
      defineImpactFeedbackCatalog({
        recipes: [{ durationMs: 0, id: 'invalid', ring: recipes[0].ring }],
        rules: [],
      }),
    ).toThrow('durationMs must be greater than zero');
  });

  it('identifies arbitrary event shapes that carry impact feedback', () => {
    const impact = createImpactContact({
      atMs: 0,
      source: { kind: 'projectile' },
      target: { kind: 'prop' },
      x: 0,
      y: 0,
    });

    expect(hasImpactFeedback({ impact, type: 'projectile-collision' })).toBe(true);
    expect(hasImpactFeedback({ type: 'projectile-collision' })).toBe(false);
  });
});

describe('impact input ownership and bounds', () => {
  it('normalizes huge finite vectors without overflow', () => {
    const contact = createImpactContact({ atMs: 0, x: 0, y: 0, normalX: 1e308,
      normalY: 1e308, source: { kind: 'actor' }, target: { kind: 'wall' } });
    expect(Math.hypot(contact.normalX, contact.normalY)).toBeCloseTo(1);
  });
  it('snapshots recipe and selector inputs', () => {
    const ring = { color: 0xffffff, startRadius: 1, endRadius: 2 };
    const kinds = ['actor'];
    const catalog = defineImpactFeedbackCatalog({ recipes: [{ id: 'hit', durationMs: 10, ring }],
      rules: [{ id: 'rule', recipeId: 'hit', source: { kinds } }] });
    ring.endRadius = 99;
    kinds[0] = 'other';
    const contact = createImpactContact({ atMs: 0, x: 0, y: 0,
      source: { kind: 'actor' }, target: { kind: 'wall' } });
    expect(resolveImpactFeedbackRecipe(catalog, contact)?.ring?.endRadius).toBe(2);
  });
  it('rejects invalid carriers and oversized recipe catalogs', () => {
    expect(hasImpactFeedback({ impact: { x: 1 } })).toBe(false);
    expect(() => defineImpactFeedbackCatalog({ recipes: Array.from({ length: 257 },
      (_, i) => ({ ...recipes[0], id: String(i) })), rules: [] })).toThrow('bounds');
  });
});
