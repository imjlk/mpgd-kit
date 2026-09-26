/** Minimal store command port. The Google SDK lives under adapters/, not in the CLI. */
export interface PlayBundle {
  readonly versionCode?: number | null;
  readonly sha256?: string | null;
}

export interface PlayTrackRelease {
  readonly name?: string | null | undefined;
  readonly status?: string | null | undefined;
  readonly versionCodes?: readonly string[] | null | undefined;
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
  getTrack(packageName: string, editId: string, signal?: AbortSignal): Promise<PlayTrack>;
  updateTrack(packageName: string, editId: string, track: PlayTrack, signal?: AbortSignal): Promise<void>;
  validateEdit(packageName: string, editId: string, signal?: AbortSignal): Promise<void>;
  commitEdit(packageName: string, editId: string, signal?: AbortSignal): Promise<void>;
}
