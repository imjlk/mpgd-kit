import { createUnsupportedCapabilities } from '@mpgd/platform';

import { m, resolveMpgdLocale, resolveTargetMpgdLocale } from '../src/index';

const localizedCapabilities = {
  ...createUnsupportedCapabilities(),
  localizedContent: true,
};
const blockedCapabilities = {
  ...createUnsupportedCapabilities(),
  localizedContent: false,
};

const ko = resolveMpgdLocale(localizedCapabilities, ['ko-KR', 'en-US']);
const en = resolveMpgdLocale(blockedCapabilities, ['ko-KR']);
const saved = resolveTargetMpgdLocale({
  capabilities: localizedCapabilities,
  savedLocale: 'ko-KR',
  preferredLocales: ['en-US'],
  fallbackLocale: 'en',
});
const preferred = resolveTargetMpgdLocale({
  capabilities: localizedCapabilities,
  savedLocale: 'unsupported',
  preferredLocales: ['ko-KR'],
  fallbackLocale: 'en',
});
const configuredFallback = resolveTargetMpgdLocale({
  capabilities: localizedCapabilities,
  preferredLocales: ['unsupported'],
  fallbackLocale: 'ko-KR',
});
const disabledFallback = resolveTargetMpgdLocale({
  capabilities: blockedCapabilities,
  savedLocale: 'ko',
  preferredLocales: ['ko-KR'],
  fallbackLocale: 'en-US',
});

assertEqual(ko, 'ko', 'Korean locale should resolve when localized content is available');
assertEqual(en, 'en', 'Locale should fall back when localized content is target-disabled');
assertEqual(saved, 'ko', 'Stored locale should take priority over device preferences');
assertEqual(preferred, 'ko', 'Invalid stored locale should fall through to device preferences');
assertEqual(configuredFallback, 'ko', 'Target fallback should apply after unsupported preferences');
assertEqual(disabledFallback, 'en', 'Target-disabled localization should use target fallback');
assertEqual(
  m.score({ score: 120 }, { locale: ko }),
  '점수 120',
  'score should translate to Korean',
);
assertEqual(
  m.score({ score: 120 }, { locale: en }),
  'Score 120',
  'score should translate to English',
);

console.log('i18n smoke passed: en, ko');

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
