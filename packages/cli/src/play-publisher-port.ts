/** Minimal store command port. The Google SDK lives under adapters/, not in the CLI. */
export interface PlayBundle {
  readonly versionCode?: number | null;
  readonly sha256?: string | null;
}

/** Android Publisher v3 `LocalizedText`: a BCP-47 language tag and its text. */
export interface PlayLocalizedText {
  readonly language?: string | null | undefined;
  readonly text?: string | null | undefined;
}

/**
 * Android Publisher v3 `Release`. Releases read from Play keep every field Play
 * returned (for example `countryTargeting`), so a track update that sends them
 * back leaves them unchanged.
 */
export interface PlayTrackRelease {
  readonly name?: string | null | undefined;
  readonly status?: string | null | undefined;
  readonly versionCodes?: readonly string[] | null | undefined;
  readonly userFraction?: number | null | undefined;
  readonly releaseNotes?: readonly PlayLocalizedText[] | null | undefined;
}

export interface PlayTrack {
  readonly track?: string | null | undefined;
  readonly releases?: readonly PlayTrackRelease[] | null | undefined;
}

export interface PlayPublisher {
  insertEdit(packageName: string, editIdSignal?: AbortSignal): Promise<string>;
  listBundles(packageName: string, editId: string, signal?: AbortSignal): Promise<PlayBundle[]>;
  uploadBundle(input: {
    readonly packageName: string;
    readonly editId: string;
    readonly aabFile: string;
    readonly timeoutMs: number;
    readonly requestRootUrl?: string;
    readonly signal?: AbortSignal;
  }): Promise<PlayBundle>;
  /** `edits.deobfuscationfiles.upload` with type `proguard` (an R8/ProGuard mapping). */
  uploadDeobfuscationFile(input: {
    readonly packageName: string;
    readonly editId: string;
    readonly versionCode: number;
    readonly mappingFile: string;
    readonly timeoutMs: number;
    readonly requestRootUrl?: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  getTrack(
    packageName: string,
    editId: string,
    track: string,
    signal?: AbortSignal,
  ): Promise<PlayTrack>;
  /** Updates the track named by `track.track`. */
  updateTrack(packageName: string, editId: string, track: PlayTrack, signal?: AbortSignal): Promise<void>;
  validateEdit(packageName: string, editId: string, signal?: AbortSignal): Promise<void>;
  commitEdit(packageName: string, editId: string, signal?: AbortSignal): Promise<void>;
  /** Discards an uncommitted edit (`edits.delete`), used after a read-only dry run. */
  deleteEdit(packageName: string, editId: string, signal?: AbortSignal): Promise<void>;
}
