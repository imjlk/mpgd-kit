/**
 * A human-facing release identity shared by every target artifact for one game release.
 *
 * `gameVersion` remains the game's SemVer value. `releaseRevision` is deliberately
 * separate so a game can keep one semantic release while targets are promoted or
 * rebuilt independently. For example, the common label for game `0.3.30` and
 * revision `42` is `0.3.30-v42`.
 */
export interface MpgdReleaseIdentity {
  readonly gameVersion: string;
  readonly releaseRevision?: number;
  readonly label: string;
}

export interface CreateMpgdReleaseIdentityInput {
  readonly gameVersion: string;
  readonly releaseRevision?: number;
  /**
   * Optional value from a build environment. It must equal the derived label so
   * a stale or hand-edited label cannot be embedded into an artifact.
   */
  readonly expectedLabel?: string;
}

const semVerCore = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const preReleaseNumericIdentifier = '(?:0|[1-9]\\d*)';
const preReleaseAlphanumericIdentifier = '(?:\\d*[A-Za-z-][0-9A-Za-z-]*)';
const preReleaseIdentifier = `(?:${preReleaseNumericIdentifier}|${preReleaseAlphanumericIdentifier})`;
const finalSemVerPattern = new RegExp(`^${semVerCore}$`, 'u');
const semVerPattern = new RegExp(
  `^${semVerCore}(?:-${preReleaseIdentifier}(?:\\.${preReleaseIdentifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  'u',
);

export function createMpgdReleaseIdentity(
  input: CreateMpgdReleaseIdentityInput,
): MpgdReleaseIdentity {
  const gameVersion = normalizeMpgdSemVer(input.gameVersion);
  const releaseRevision = input.releaseRevision;
  const label = formatNormalizedMpgdReleaseLabel(gameVersion, releaseRevision);
  const expectedLabel = input.expectedLabel?.trim();

  if (expectedLabel !== undefined && expectedLabel !== label) {
    const detail = `${label}; received ${expectedLabel}.`;
    throw new TypeError(`Release identity label must equal ${detail}`);
  }

  return releaseRevision === undefined
    ? { gameVersion, label }
    : { gameVersion, releaseRevision, label };
}

export function formatMpgdReleaseLabel(
  gameVersion: string,
  releaseRevision: number | undefined,
): string {
  return formatNormalizedMpgdReleaseLabel(normalizeMpgdSemVer(gameVersion), releaseRevision);
}

function formatNormalizedMpgdReleaseLabel(
  gameVersion: string,
  releaseRevision: number | undefined,
): string {
  if (releaseRevision === undefined) {
    return gameVersion;
  }

  if (!isMpgdFinalSemVer(gameVersion)) {
    throw new TypeError(
      'Release identity gameVersion must be a final SemVer when releaseRevision is set.',
    );
  }

  if (!Number.isSafeInteger(releaseRevision) || releaseRevision < 1) {
    throw new TypeError('Release identity releaseRevision must be a positive safe integer.');
  }

  return `${gameVersion}-v${releaseRevision}`;
}

/** Whether a normalized game version is eligible for an immutable production release. */
export function isMpgdFinalSemVer(value: string): boolean {
  return finalSemVerPattern.test(value);
}

/**
 * Canonical release-manifest identifier derived from a common release label.
 * Both components must be non-empty canonical tokens without the `+` delimiter.
 */
export function formatMpgdReleaseId(label: string, buildId: string): string {
  assertReleaseIdComponent(label, 'label');
  assertReleaseIdComponent(buildId, 'buildId');

  return `mpgd-${label}+${buildId}`;
}

/** Parse an optional release revision without making empty values meaningful. */
export function parseMpgdReleaseRevision(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const normalized = value.trim();

  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new TypeError('Release revision must be a positive safe integer.');
  }

  const releaseRevision = Number.parseInt(normalized, 10);

  if (!Number.isSafeInteger(releaseRevision)) {
    throw new TypeError('Release revision must be a positive safe integer.');
  }

  return releaseRevision;
}

function normalizeMpgdSemVer(value: string): string {
  const normalized = value.trim();

  if (!semVerPattern.test(normalized)) {
    throw new TypeError('Release identity gameVersion must be a SemVer value.');
  }

  return normalized;
}

function assertReleaseIdComponent(value: string, label: string): void {
  if (value.length === 0 || /\s/u.test(value)) {
    throw new TypeError(`Release identifier ${label} must be a non-empty canonical token.`);
  }

  if (value.includes('+')) {
    throw new TypeError(`Release identifier ${label} must not contain "+".`);
  }
}
