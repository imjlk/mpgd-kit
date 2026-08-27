import type { PlatformCapabilities } from '@mpgd/platform';

import { baseLocale, locales, type Locale } from './paraglideAdapter.js';

export { baseLocale, locales, m, type Locale } from './paraglideAdapter.js';

export type MpgdLocale = Locale;

export interface ResolveTargetMpgdLocaleInput {
  readonly capabilities: Pick<PlatformCapabilities, 'localizedContent'>;
  readonly savedLocale?: unknown;
  readonly preferredLocales?: readonly string[];
  readonly fallbackLocale: MpgdLocale;
}

export interface MpgdLocaleEnvironment {
  readonly language?: string;
  readonly languages?: readonly string[];
}

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
  preferredLocales = readMpgdPreferredLocales(),
): MpgdLocale {
  return resolveTargetMpgdLocale({
    capabilities,
    preferredLocales,
    fallbackLocale: baseLocale,
  });
}

/** Resolves locale policy without assigning defaults to specific platform names. */
export function resolveTargetMpgdLocale(input: ResolveTargetMpgdLocaleInput): MpgdLocale {
  const fallbackLocale = input.fallbackLocale;

  if (!input.capabilities.localizedContent) {
    return fallbackLocale;
  }

  if (typeof input.savedLocale === 'string') {
    const savedLocale = normalizeMpgdLocale(input.savedLocale);

    if (savedLocale !== null) {
      return savedLocale;
    }
  }

  for (const preferredLocale of input.preferredLocales ?? readMpgdPreferredLocales()) {
    const locale = normalizeMpgdLocale(preferredLocale);

    if (locale !== null) {
      return locale;
    }
  }

  return fallbackLocale;
}

/** Read an ordered, de-duplicated browser or WebView language preference list. */
export function readMpgdPreferredLocales(
  environment: MpgdLocaleEnvironment | undefined = globalThis.navigator,
): readonly string[] {
  const preferredLocales = [
    ...(environment?.languages ?? []),
    ...(environment?.language === undefined ? [] : [environment.language]),
  ].filter((locale, index, locales) => locale.length > 0 && locales.indexOf(locale) === index);

  return Object.freeze(preferredLocales);
}
