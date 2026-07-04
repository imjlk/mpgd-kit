import { createUnsupportedCapabilities } from '@mpgd/platform';

import { m, resolveMpgdLocale } from '../src/index';

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

assertEqual(ko, 'ko', 'Korean locale should resolve when localized content is available');
assertEqual(en, 'en', 'Locale should fall back when localized content is target-disabled');
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
