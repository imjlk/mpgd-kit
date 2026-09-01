import type { Plugin } from 'vite';

const phaserEsmModuleSuffix = '/phaser/dist/phaser.esm.js';
const dynamicGlobalFallback = "return this || new Function('return this')();";
const staticGlobalFallback = 'return globalThis;';
const dynamicSceneEvaluation = /var eval2 = eval;\r?\n\s*this\.loader\.sceneManager\.add\(this\.key, eval2\(code\)\);/gu;
const disabledSceneEvaluation =
  "throw new Error('Phaser SceneFile loader is disabled in mini-game artifacts.');";
const dynamicScriptInjection = /(file|this)\.data = document\.createElement\('script'\);[\s\S]*?document\.head\.appendChild\(\1\.data\);/gu;
const disabledScriptInjection =
  "throw new Error('Phaser executable script loaders are disabled in mini-game artifacts.');";

/** Removes known dynamic-code paths from the pinned Phaser 4.2.0 ESM bundle. */
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
  const scriptInjectionCount = source.match(dynamicScriptInjection)?.length ?? 0;

  if (scriptInjectionCount !== 4) {
    throw new Error(
      `Expected exactly four Phaser 4.2.0 script injection paths, found ${String(scriptInjectionCount)}.`,
    );
  }

  return source
    .replace(dynamicGlobalFallback, staticGlobalFallback)
    .replace(dynamicSceneEvaluation, disabledSceneEvaluation)
    .replace(dynamicScriptInjection, disabledScriptInjection);
}
