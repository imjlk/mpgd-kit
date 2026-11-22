import type { Plugin } from 'vite';

/**
 * The Phaser release whose ESM bundle the patterns and counts below were checked against.
 * It must equal this starter's exact `phaser` pin; the mini-game output test enforces that and
 * rewrites the installed bundle.
 */
export const pinnedPhaserVersion = '4.2.1';

const phaserEsmModuleSuffix = '/phaser/dist/phaser.esm.js';
const dynamicGlobalFallback = "return this || new Function('return this')();";
const staticGlobalFallback = 'return globalThis;';
const dynamicSceneEvaluation = /var eval2 = eval;\r?\n\s*this\.loader\.sceneManager\.add\(this\.key, eval2\(code\)\);/gu;
const disabledSceneEvaluation =
  "throw new Error('Phaser SceneFile loader is disabled in mini-game artifacts.');";
const dynamicScriptInjection = /(file|this)\.data = document\.createElement\('script'\);[\s\S]*?document\.head\.appendChild\(\1\.data\);/gu;
const disabledScriptInjection =
  "throw new Error('Phaser executable script loaders are disabled in mini-game artifacts.');";

/** Removes known dynamic-code paths from the pinned Phaser ESM bundle (`pinnedPhaserVersion`). */
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
      `Expected exactly one Phaser ${pinnedPhaserVersion} dynamic global fallback, found ${String(globalFallbackCount)}.`,
    );
  }
  const sceneEvaluationCount = source.match(dynamicSceneEvaluation)?.length ?? 0;

  if (sceneEvaluationCount !== 1) {
    throw new Error(
      `Expected exactly one Phaser ${pinnedPhaserVersion} dynamic SceneFile evaluation, found ${String(sceneEvaluationCount)}.`,
    );
  }
  const scriptInjectionCount = source.match(dynamicScriptInjection)?.length ?? 0;

  if (scriptInjectionCount !== 4) {
    throw new Error(
      `Expected exactly four Phaser ${pinnedPhaserVersion} script injection paths, found ${String(scriptInjectionCount)}.`,
    );
  }

  return source
    .replace(dynamicGlobalFallback, staticGlobalFallback)
    .replace(dynamicSceneEvaluation, disabledSceneEvaluation)
    .replace(dynamicScriptInjection, disabledScriptInjection);
}
