export const microsoftStorePackageGenerationSchemaVersion = 1 as const;
export const microsoftStorePackageGeneratorEndpoint =
  'https://pwabuilder-windows-docker.azurewebsites.net/msix/generatezip' as const;
export const microsoftStorePackageGeneratorSourceRevision =
  'ded7914e84d1509c901d2899a3f654f5d44ef08f' as const;

export interface MicrosoftStorePackageGenerationEvidence {
  readonly schemaVersion: typeof microsoftStorePackageGenerationSchemaVersion;
  readonly target: 'microsoft-store';
  readonly pwaUrl: string;
  readonly modernVersion: string;
  readonly classicVersion: string;
  readonly submissionEvidenceFile: string;
  readonly submissionEvidenceSha256: string;
  readonly productIdentity: MicrosoftStoreProductIdentity;
  readonly manifest: {
    readonly file: string;
    readonly url: string;
    readonly sha256: string;
    readonly pinnedInGeneratorRequest: true;
    readonly icons: {
      readonly count: number;
      readonly verification: 'before-and-after-generator';
      readonly entries: readonly {
        readonly file: string;
        readonly url: string;
        readonly sha256: string;
        readonly width: number;
        readonly height: number;
      }[];
    };
  };
  readonly generator: {
    readonly endpoint: typeof microsoftStorePackageGeneratorEndpoint;
    readonly sourceRevision: typeof microsoftStorePackageGeneratorSourceRevision;
    readonly contract: 'unversioned-best-effort';
    readonly requestSha256: string;
  };
  readonly archive: {
    readonly file: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly contentType: 'application/zip';
  };
  readonly packageInspectionRequired: true;
}

export interface RunMicrosoftStorePackageGenerationInput {
  readonly gameRoot: string;
  readonly submissionEvidenceFile: string;
  readonly pwaUrl: string;
  readonly manifestUrl: string;
  readonly modernVersion: string;
  readonly classicVersion: string;
  readonly outputFile: string;
  readonly jsonFile: string;
  readonly markdownFile: string;
}

export interface MicrosoftStorePackageGenerationRuntime {
  readonly fetch: typeof fetch;
}

export interface CreateMicrosoftStorePackageGenerationRuntimeInput {
  readonly fetch?: typeof fetch;
}

export interface MicrosoftStoreProductIdentity {
  readonly packageId: string;
  readonly publisherId: string;
  readonly publisherDisplayName: string;
  readonly reservedName: string;
}

export interface MicrosoftStoreFileSnapshot {
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface MicrosoftStoreSubmissionEvidenceInput {
  readonly identity: MicrosoftStoreProductIdentity;
  readonly manifestFile: string;
  readonly manifestSha256: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly manifestIcons: readonly MicrosoftStoreManifestIconInput[];
  readonly resourceLanguage: string;
}

export interface MicrosoftStoreManifestIconInput {
  readonly file: string;
  readonly url: string;
  readonly snapshot: MicrosoftStoreFileSnapshot;
  readonly width: number;
  readonly height: number;
}

export interface PreparedMicrosoftStorePackageGenerationInput {
  readonly gameRoot: string;
  readonly submissionEvidenceFile: string;
  readonly submissionBefore: MicrosoftStoreFileSnapshot;
  readonly submission: MicrosoftStoreSubmissionEvidenceInput;
  readonly manifestBefore: MicrosoftStoreFileSnapshot;
  readonly pwaUrl: string;
  readonly manifestUrl: string;
  readonly modernVersion: string;
  readonly classicVersion: string;
  readonly outputFile: string;
  readonly jsonFile: string;
  readonly markdownFile: string;
}

export interface MicrosoftStorePackageGeneratorRequest {
  readonly name: string;
  readonly packageId: string;
  readonly applicationId: 'App';
  readonly url: string;
  readonly version: string;
  readonly allowSigning: true;
  readonly publisher: {
    readonly displayName: string;
    readonly commonName: string;
  };
  readonly generateModernPackage: true;
  readonly classicPackage: {
    readonly generate: true;
    readonly version: string;
    readonly url: string;
  };
  readonly edgeChannel: 'stable';
  readonly manifestUrl: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly resourceLanguage: string;
  readonly targetDeviceFamilies: readonly ['Desktop'];
  readonly usePwaBuilderWithCustomManifest: true;
}
