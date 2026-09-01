import type { Plugin } from 'vite';

const phaserEsmModuleSuffix = '/phaser/dist/phaser.esm.js';
const dynamicGlobalFallback = "return this || new Function('return this')();";
const staticGlobalFallback = 'return globalThis;';
const dynamicSceneEvaluation = /var eval2 = eval;\r?\n\s*this\.loader\.sceneManager\.add\(this\.key, eval2\(code\)\);/gu;
const disabledSceneEvaluation =
  "throw new Error('Phaser SceneFile loader is disabled in mini-game artifacts.');";

/** Removes the two known dynamic-code paths from the pinned Phaser 4.2.0 ESM bundle. */
export function createPhaserMiniGameDynamicCodePlugin(): Plugin {
  return {
    name: 'mpgd-phaser-minigame-static-global',
    enforce: 'pre',
    transform(source, id) {
      const modulePath = (id.split('?')[0] ?? id).replaceAll('\\', '/');

      if (!modulePath.endsWith(phaserEsmModuleSuffix)) {
        return null;
      }

      return {
        code: rewritePhaserMiniGameDynamicCode(source),
        map: null,
      };
    },
  };
}

export function rewritePhaserMiniGameDynamicCode(source: string): string {
  const globalFallbackCount = source.split(dynamicGlobalFallback).length - 1;

  if (globalFallbackCount !== 1) {
    throw new Error(
      `Expected exactly one Phaser 4.2.0 dynamic global fallback, found ${String(globalFallbackCount)}.`,
    );
  }
  const sceneEvaluationCount = source.match(dynamicSceneEvaluation)?.length ?? 0;

  if (sceneEvaluationCount !== 1) {
    throw new Error(
      `Expected exactly one Phaser 4.2.0 dynamic SceneFile evaluation, found ${String(sceneEvaluationCount)}.`,
    );
  }

  return source
    .replace(dynamicGlobalFallback, staticGlobalFallback)
    .replace(dynamicSceneEvaluation, disabledSceneEvaluation);
}
