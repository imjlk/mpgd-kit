import type { PlatformCapabilities } from '@mpgd/platform';

import { baseLocale, locales, type Locale } from './paraglideAdapter.js';

export { baseLocale, locales, m, type Locale } from './paraglideAdapter.js';

export type MpgdLocale = Locale;

export function isMpgdLocale(input: string): input is MpgdLocale {
  return (locales as readonly string[]).includes(input);
}

export function normalizeMpgdLocale(input: string): MpgdLocale | null {
  const normalized = input.toLowerCase();

  if (isMpgdLocale(normalized)) {
    return normalized;
  }

  const [base] = normalized.split('-');

  if (base !== undefined && isMpgdLocale(base)) {
    return base;
  }

  return null;
}

export function resolveMpgdLocale(
  capabilities: Pick<PlatformCapabilities, 'localizedContent'>,
  preferredLocales = readPreferredLocales(),
): MpgdLocale {
  if (!capabilities.localizedContent) {
    return baseLocale;
  }

  for (const preferredLocale of preferredLocales) {
    const locale = normalizeMpgdLocale(preferredLocale);

    if (locale !== null) {
      return locale;
    }
  }

  return baseLocale;
}

function readPreferredLocales(): readonly string[] {
  const navigatorLanguages = globalThis.navigator?.languages;

  if (navigatorLanguages !== undefined && navigatorLanguages.length > 0) {
    return navigatorLanguages;
  }

  const navigatorLanguage = globalThis.navigator?.language;
  return navigatorLanguage === undefined ? [baseLocale] : [navigatorLanguage];
}
