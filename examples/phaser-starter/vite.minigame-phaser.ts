import type { Plugin } from 'vite';

const phaserEsmModuleSuffix = '/phaser/dist/phaser.esm.js';
const dynamicGlobalFallback = "return this || new Function('return this')();";
const staticGlobalFallback = 'return globalThis;';

export function createPhaserMiniGameStaticGlobalPlugin(): Plugin {
  return {
    name: 'mpgd-phaser-minigame-static-global',
    enforce: 'pre',
    transform(source, id) {
      const modulePath = (id.split('?')[0] ?? id).replaceAll('\\', '/');

      if (!modulePath.endsWith(phaserEsmModuleSuffix)) {
        return null;
      }

      return {
        code: rewritePhaserMiniGameGlobalFallback(source),
        map: null,
      };
    },
  };
}

export function rewritePhaserMiniGameGlobalFallback(source: string): string {
  const matchCount = source.split(dynamicGlobalFallback).length - 1;

  if (matchCount !== 1) {
    throw new Error(
      `Expected exactly one Phaser 4.2.0 dynamic global fallback, found ${String(matchCount)}.`,
    );
  }

  return source.replace(dynamicGlobalFallback, staticGlobalFallback);
}
