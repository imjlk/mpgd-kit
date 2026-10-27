import path from 'node:path';

import {
  googlePlayPresenceImageSlots,
  googlePlayPresenceLimits,
  resolveStorePresenceImageSet,
  type GooglePlayPresence,
  type GooglePlayPresenceListing,
  type StorePresence,
} from '@mpgd/catalog';

import type {
  PlayAppDetails,
  PlayImage,
  PlayImageType,
  PlayListing,
  PlayStoreListingPort,
} from './play-listing-port.js';
import {
  assertLocalStoreImageUnchanged,
  describeTextChange,
  formatTextChange,
  imageMimeType,
  planStoreImageSet,
  readLocalStoreImage,
  storePresencePlanCommand,
  type LocalStoreImage,
  type StorePresenceTextChange,
} from './store-presence.js';
import {
  canonicalLanguageTag,
  mapWithConcurrency,
  stableSha256,
  StorePlanStaleError,
} from './store-sync.js';

/**
 * Google Play store presence sync: compare the store presence file with the
 * main store listing (`edits.details`, `edits.listings`, `edits.images`)
 * and plan the writes. Everything goes through one edit: plan opens one to
 * read and discards it; apply opens one, re-plans inside it, writes, and
 * commits once at the end, or discards the edit when anything fails, so
 * Play never holds half an apply.
 *
 * Languages Play lists that the file does not name are kept. Images Play
 * holds that the file does not name are kept unless the file marks the set
 * `complete`; removing one then needs `--confirm-image-removal`.
 */

export type PlayPresenceAction = 'create' | 'update' | 'unchanged';

export interface PlannedPlayImage {
  /** Path relative to the store presence file. */
  readonly path: string;
  readonly sha256: string;
}

export interface PlannedPlayImageSlot {
  readonly imageType: PlayImageType;
  /** `add` uploads after Play's images; `replace` deletes the slot first. */
  readonly action: 'unchanged' | 'add' | 'replace';
  readonly complete: boolean;
  /** Uploads, in order. */
  readonly upload: readonly PlannedPlayImage[];
  /** SHA-256 of Play's images that stay as they are. */
  readonly keep: readonly string[];
  /** Play's images the write removes and does not upload again. */
  readonly remove: readonly { readonly id: string; readonly sha256: string }[];
  readonly notes: readonly string[];
}

export interface PlannedPlayLanguage {
  /** The language as Play spells it (BCP-47 casing for a new one). */
  readonly language: string;
  readonly action: PlayPresenceAction;
  readonly text: readonly StorePresenceTextChange[];
  /** `edits.listings.update` body when the text changes. */
  readonly listing?: PlayListing & { readonly language: string };
  readonly images: readonly PlannedPlayImageSlot[];
}

export interface PlayPresencePlan {
  readonly schemaVersion: 1;
  readonly store: 'google-play';
  readonly packageName: string;
  readonly details?: {
    readonly changes: readonly { readonly field: string; readonly from?: string; readonly to: string }[];
    /** `edits.details.update` body: Play's details with the file's contact fields. */
    readonly write: PlayAppDetails;
  };
  readonly languages: readonly PlannedPlayLanguage[];
  /** Languages on Play that the file does not name. Never deleted. */
  readonly remoteOnlyLanguages: readonly string[];
  /** Play images a complete set removes; apply needs --confirm-image-removal. */
  readonly imageRemovals: number;
  readonly changed: boolean;
  readonly notes: readonly string[];
  /** What the sync cannot do; the reviewer does it in Play Console. */
  readonly manual: readonly string[];
  /** Digest of everything read from Play. */
  readonly remoteSha256: string;
  /** Digest of the planned writes. */
  readonly desiredSha256: string;
}

export interface PlayPresencePlanInput {
  readonly packageName: string;
  readonly presence: StorePresence;
  /** Directory of the store presence file; graphics resolve against it. */
  readonly directory: string;
  readonly signal?: AbortSignal;
}

const readConcurrency = 4;
const uploadTimeoutMs = 5 * 60_000;

/** Read Play through a throwaway edit and plan; never writes. */
export async function planPlayPresence(
  input: PlayPresencePlanInput,
  port: PlayStoreListingPort,
): Promise<PlayPresencePlan> {
  const play = requirePlay(input.presence);
  // Graphics are read and checked before Play is asked anything.
  const local = readLocalGraphics(input.directory, play);
  const editId = await port.insertEdit(input.packageName, input.signal);
  try {
    return await planInEdit(input, play, local, port, editId);
  } finally {
    await discardEdit(port, input.packageName, editId);
  }
}

function requirePlay(presence: StorePresence): GooglePlayPresence {
  if (presence.googlePlay === undefined) {
    throw new Error('The store presence file has no googlePlay section.');
  }
  return presence.googlePlay;
}

type LocalGraphics = ReadonlyMap<string, ReadonlyMap<PlayImageType, {
  readonly images: readonly LocalStoreImage[];
  readonly complete: boolean;
}>>;

function readLocalGraphics(directory: string, play: GooglePlayPresence): LocalGraphics {
  const result = new Map<string, Map<PlayImageType, { images: LocalStoreImage[]; complete: boolean }>>();
  for (const [language, listing] of Object.entries(play.listings)) {
    const slots = new Map<PlayImageType, { images: LocalStoreImage[]; complete: boolean }>();
    for (const slot of googlePlayPresenceImageSlots) {
      const value = listing.graphics?.[slot];
      if (value === undefined) {
        continue;
      }
      const { files, complete } = typeof value === 'string'
        ? { files: [value], complete: true }
        : resolveStorePresenceImageSet(value);
      const label = `googlePlay.listings.${language}.graphics.${slot}`;
      const images = files.map((file) =>
        readLocalStoreImage(directory, file, { store: 'google-play', slot }, label),
      );
      const digests = new Set(images.map((image) => image.sha256));
      if (digests.size !== images.length) {
        throw new Error(`${label} lists the same image twice under different names.`);
      }
      slots.set(slot, { images, complete });
    }
    result.set(language, slots);
  }
  return result;
}

async function planInEdit(
  input: PlayPresencePlanInput,
  play: GooglePlayPresence,
  local: LocalGraphics,
  port: PlayStoreListingPort,
  editId: string,
): Promise<PlayPresencePlan> {
  const { packageName, signal } = input;
  const [details, remoteListings] = await Promise.all([
    port.getDetails(packageName, editId, signal),
    port.listListings(packageName, editId, signal),
  ]);
  const remoteByLanguage = new Map<string, PlayListing>();
  for (const listing of remoteListings) {
    if (typeof listing.language === 'string') {
      remoteByLanguage.set(listing.language.toLowerCase(), listing);
    }
  }
  const languages = Object.keys(play.listings);
  // Play's images of every slot the file manages, for languages Play lists.
  const reads = languages.flatMap((language) => {
    const remote = remoteByLanguage.get(language.toLowerCase());
    if (remote === undefined) {
      return [];
    }
    return [...(local.get(language)?.keys() ?? [])].map((imageType) => ({
      language,
      remoteLanguage: String(remote.language),
      imageType,
    }));
  });
  const imageLists = await mapWithConcurrency(reads, readConcurrency, (read) =>
    port.listImages({
      packageName,
      editId,
      language: read.remoteLanguage,
      imageType: read.imageType,
      ...(signal === undefined ? {} : { signal }),
    }),
  );
  const remoteImages = new Map<string, PlayImage[]>();
  reads.forEach((read, index) => {
    remoteImages.set(`${read.language}\n${read.imageType}`, imageLists[index] ?? []);
  });

  const planned = languages.map((language) =>
    planLanguage({
      language,
      entry: play.listings[language] as GooglePlayPresenceListing,
      remote: remoteByLanguage.get(language.toLowerCase()),
      local: local.get(language) ?? new Map(),
      remoteImages: (imageType) => remoteImages.get(`${language}\n${imageType}`) ?? [],
    }),
  );
  const named = new Set(languages.map((language) => language.toLowerCase()));
  const remoteOnlyLanguages = remoteListings
    .map((listing) => String(listing.language))
    .filter((language) => !named.has(language.toLowerCase()))
    .sort();

  const notes: string[] = [];
  const defaultLanguage = typeof details.defaultLanguage === 'string'
    ? details.defaultLanguage
    : undefined;
  if (defaultLanguage !== undefined && !named.has(defaultLanguage.toLowerCase())) {
    notes.push(
      `Play's default language ${defaultLanguage} is not in the file; its listing stays as Play has it.`,
    );
  }
  const plannedDetails = planDetails(details, play);
  const manual = manualSteps(input.presence);
  const imageRemovals = planned.reduce(
    (sum, language) => sum + language.images.reduce(
      (count, slot) => count + (slot.complete && isMultiImage(slot.imageType) ? slot.remove.length : 0),
      0,
    ),
    0,
  );
  const changed = plannedDetails !== undefined || planned.some((language) =>
    language.action !== 'unchanged' || language.images.some((slot) => slot.action !== 'unchanged'),
  );
  // Images by ID and digest only: their preview URLs may differ per request.
  const remoteSha256 = stableSha256({
    details,
    listings: [...remoteListings].sort((left, right) =>
      String(left.language).localeCompare(String(right.language)),
    ),
    images: Object.fromEntries(
      [...remoteImages.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, images]) => [key, images.map((image) => ({ id: image.id, sha256: image.sha256 }))]),
    ),
  });
  const desiredSha256 = stableSha256({ details: plannedDetails?.write, languages: planned });
  return {
    schemaVersion: 1,
    store: 'google-play',
    packageName,
    ...(plannedDetails === undefined ? {} : { details: plannedDetails }),
    languages: planned,
    remoteOnlyLanguages,
    imageRemovals,
    changed,
    notes,
    manual,
    remoteSha256,
    desiredSha256,
  };
}

function planLanguage(input: {
  readonly language: string;
  readonly entry: GooglePlayPresenceListing;
  readonly remote: PlayListing | undefined;
  readonly local: ReadonlyMap<PlayImageType, { readonly images: readonly LocalStoreImage[]; readonly complete: boolean }>;
  readonly remoteImages: (imageType: PlayImageType) => readonly PlayImage[];
}): PlannedPlayLanguage {
  const { entry, remote } = input;
  const language = typeof remote?.language === 'string'
    ? remote.language
    : canonicalLanguageTag(input.language);
  const video = entry.video ?? (typeof remote?.video === 'string' && remote.video !== '' ? remote.video : undefined);
  const text = [
    describeTextChange('title', remote?.title, entry.title),
    describeTextChange('shortDescription', remote?.shortDescription, entry.shortDescription),
    describeTextChange('fullDescription', remote?.fullDescription, entry.fullDescription),
    entry.video === undefined ? undefined : describeTextChange('video', remote?.video, entry.video),
  ].filter((change) => change !== undefined);
  const images = googlePlayPresenceImageSlots.flatMap((imageType) => {
    const slot = input.local.get(imageType);
    return slot === undefined
      ? []
      : [planImageSlot(imageType, slot.images, slot.complete, input.remoteImages(imageType))];
  });
  const action: PlayPresenceAction = remote === undefined
    ? 'create'
    : text.length > 0
      ? 'update'
      : 'unchanged';
  return {
    language,
    action,
    text,
    ...(action === 'unchanged' ? {} : {
      listing: {
        language,
        title: entry.title,
        shortDescription: entry.shortDescription,
        fullDescription: entry.fullDescription,
        ...(video === undefined ? {} : { video }),
      },
    }),
    images,
  };
}

function isMultiImage(imageType: PlayImageType): boolean {
  return imageType !== 'icon' && imageType !== 'featureGraphic';
}

function planImageSlot(
  imageType: PlayImageType,
  local: readonly LocalStoreImage[],
  complete: boolean,
  remote: readonly PlayImage[],
): PlannedPlayImageSlot {
  const plan = planStoreImageSet({
    local: local.map((image) => ({ path: image.path, digest: image.sha256 })),
    remote: remote.map((image) => ({
      id: String(image.id),
      digest: String(image.sha256 ?? '').toLowerCase(),
    })),
    complete,
    single: !isMultiImage(imageType),
    maxImages: googlePlayPresenceLimits.screenshots,
    label: `Google Play ${imageType}`,
    storeName: 'Play',
  });
  return {
    imageType,
    action: plan.action,
    complete,
    upload: plan.upload.map((image) => ({ path: image.path, sha256: image.digest })),
    keep: plan.keep,
    remove: plan.remove.map((image) => ({ id: image.id, sha256: image.digest })),
    notes: plan.notes,
  };
}

function planDetails(details: PlayAppDetails, play: GooglePlayPresence): PlayPresencePlan['details'] {
  const contact = play.contact;
  if (contact === undefined) {
    return undefined;
  }
  const changes: { field: string; from?: string; to: string }[] = [];
  const write: Record<string, string> = {};
  for (const [field, value] of Object.entries(details)) {
    if (typeof value === 'string' && value !== '') {
      write[field] = value;
    }
  }
  const fields = [
    ['contactEmail', contact.email],
    ['contactWebsite', contact.website],
    ['contactPhone', contact.phone],
  ] as const;
  for (const [field, value] of fields) {
    if (value === undefined) {
      continue;
    }
    const from = details[field];
    if (from !== value) {
      changes.push({
        field,
        ...(typeof from === 'string' && from !== '' ? { from } : {}),
        to: value,
      });
      write[field] = value;
    }
  }
  return changes.length === 0 ? undefined : { changes, write };
}

function manualSteps(presence: StorePresence): string[] {
  const steps: string[] = [];
  if (presence.privacyPolicyUrl !== undefined) {
    steps.push(
      `Privacy policy (Play Console > Policy and programs > App content): ${presence.privacyPolicyUrl}; `
      + 'the Android Publisher API has no field for it.',
    );
  }
  steps.push(
    'Data safety, content rating, target audience, ads and the app category stay in Play Console '
    + '(App content and Store settings).',
  );
  return steps;
}

export interface PlayPresenceApplyResult {
  readonly packageName: string;
  readonly status: 'committed' | 'unchanged';
  readonly languages: readonly { readonly language: string; readonly listing: PlayPresenceAction; readonly images: number }[];
}

export class PlayPresenceApplyError extends Error {
  constructor(
    readonly stage: string,
    /** `discarded`: Play discarded the edit; `unknown`: the commit may or may not have landed. */
    readonly outcome: 'discarded' | 'unknown',
    cause: unknown,
  ) {
    super(
      `Google Play ${stage} failed (${cause instanceof Error ? cause.message : String(cause)}). ${
        outcome === 'discarded'
          ? 'The edit was discarded; nothing was published.'
          : 'The commit result is unknown.'} Run "${storePresencePlanCommand}" again: it reads Play and lists `
      + 'what is left.',
      { cause },
    );
    this.name = 'PlayPresenceApplyError';
  }
}

/**
 * Apply a reviewed plan in one edit: re-plan inside the edit, refuse when
 * Play or the files moved past the reviewed plan, write, then commit once.
 * A plan whose changes already landed is a no-op, so a re-run is safe.
 */
export async function applyPlayPresence(input: {
  readonly saved: PlayPresencePlan;
  readonly plan: PlayPresencePlanInput;
  readonly port: PlayStoreListingPort;
  readonly approved: boolean;
  readonly confirmImageRemoval?: boolean;
  readonly changesNotSentForReview?: boolean;
}): Promise<PlayPresenceApplyResult> {
  const { saved, port } = input;
  const { packageName, signal } = input.plan;
  if (!input.approved) {
    throw new Error('Writing the Google Play store listing requires --approve.');
  }
  if (saved.packageName !== packageName) {
    throw new StorePlanStaleError(
      `The deployment profile now names ${packageName}, not ${saved.packageName}.`,
      storePresencePlanCommand,
    );
  }
  const play = requirePlay(input.plan.presence);
  const local = readLocalGraphics(input.plan.directory, play);
  const editId = await port.insertEdit(packageName, signal);
  let stage = 'read';
  let committing = false;
  try {
    const current = await planInEdit(input.plan, play, local, port, editId);
    if (!current.changed) {
      await discardEdit(port, packageName, editId);
      return { packageName, status: 'unchanged', languages: [] };
    }
    if (current.remoteSha256 !== saved.remoteSha256 || current.desiredSha256 !== saved.desiredSha256) {
      throw new StorePlanStaleError(
        'The Google Play store listing or the store presence file changed since the plan.',
        storePresencePlanCommand,
      );
    }
    if (current.imageRemovals > 0 && input.confirmImageRemoval !== true) {
      throw new Error(
        `The plan removes ${current.imageRemovals} image(s) from Google Play; confirm with --confirm-image-removal.`,
      );
    }
    const optionalSignal = signal === undefined ? {} : { signal };
    if (current.details !== undefined) {
      stage = 'details update';
      await port.updateDetails({
        packageName,
        editId,
        details: current.details.write,
        ...optionalSignal,
      });
    }
    const languages: PlayPresenceApplyResult['languages'][number][] = [];
    for (const language of current.languages) {
      if (language.listing !== undefined) {
        stage = `listing ${language.language}`;
        await port.updateListing({
          packageName,
          editId,
          listing: language.listing,
          ...optionalSignal,
        });
      }
      let uploaded = 0;
      for (const slot of language.images) {
        if (slot.action === 'unchanged') {
          continue;
        }
        const target = {
          packageName,
          editId,
          language: language.language,
          imageType: slot.imageType,
          ...optionalSignal,
        };
        if (slot.action === 'replace') {
          stage = `${language.language} ${slot.imageType} delete`;
          await port.deleteAllImages(target);
        }
        for (const image of slot.upload) {
          stage = `${language.language} ${slot.imageType} upload of ${image.path}`;
          const file = path.resolve(input.plan.directory, image.path);
          assertLocalStoreImageUnchanged(file, image.sha256);
          const info = localImage(local, language.language, slot.imageType, image.sha256);
          const stored = await port.uploadImage({
            ...target,
            file,
            mimeType: imageMimeType(info),
            timeoutMs: uploadTimeoutMs,
          });
          uploaded += 1;
          // Images are matched by SHA-256: one Play stores with another digest
          // (re-encoded) would be uploaded again by every later apply.
          if (typeof stored.sha256 === 'string' && stored.sha256.toLowerCase() !== image.sha256) {
            throw new Error(
              `Play stored ${image.path} with SHA-256 ${stored.sha256}, not the file's ${image.sha256}; `
              + 'the sync matches images by SHA-256 and cannot keep this slot in step',
            );
          }
        }
      }
      languages.push({ language: language.language, listing: language.action, images: uploaded });
    }
    stage = 'commit';
    committing = true;
    await port.commitEdit({
      packageName,
      editId,
      changesNotSentForReview: input.changesNotSentForReview === true,
      ...optionalSignal,
    });
    return { packageName, status: 'committed', languages };
  } catch (error) {
    await discardEdit(port, packageName, editId);
    // Nothing was written before the first write stage: the error stands as it is.
    if (error instanceof StorePlanStaleError || stage === 'read') {
      throw error;
    }
    throw new PlayPresenceApplyError(stage, committing ? 'unknown' : 'discarded', error);
  }
}

function localImage(
  local: LocalGraphics,
  language: string,
  imageType: PlayImageType,
  sha256: string,
): LocalStoreImage['info'] {
  for (const [fileLanguage, slots] of local) {
    if (fileLanguage.toLowerCase() !== language.toLowerCase()) {
      continue;
    }
    const image = slots.get(imageType)?.images.find((candidate) => candidate.sha256 === sha256);
    if (image !== undefined) {
      return image.info;
    }
  }
  throw new StorePlanStaleError(
    `${language} ${imageType} image ${sha256} is no longer in the file.`,
    storePresencePlanCommand,
  );
}

/** Discard an edit; a failure here must not hide the error that led to it. */
async function discardEdit(port: PlayStoreListingPort, packageName: string, editId: string): Promise<void> {
  try {
    await port.deleteEdit(packageName, editId);
  } catch {
    // An invalidated or committed edit cannot be deleted; Play drops it anyway.
  }
}

/** The plan for the terminal: per language, the text and image changes. */
export function formatPlayPresencePlan(plan: PlayPresencePlan): string {
  const lines = [
    `Google Play ${plan.packageName} store listing${plan.changed ? '' : ': no changes'}`,
  ];
  for (const change of plan.details?.changes ?? []) {
    lines.push(
      `  details   ${change.field}: ${JSON.stringify(change.from ?? null)} -> ${JSON.stringify(change.to)}`,
    );
  }
  for (const language of plan.languages) {
    const changedSlots = language.images.filter((slot) => slot.action !== 'unchanged');
    lines.push(`  ${language.action.padEnd(9)} ${language.language}${
      changedSlots.length === 0 ? '' : ` (images: ${changedSlots.map((slot) => slot.imageType).join(', ')})`}`);
    for (const change of language.text) {
      lines.push(`            ${formatTextChange(change)}`);
    }
    for (const slot of language.images) {
      if (slot.action === 'unchanged' && slot.notes.length === 0) {
        continue;
      }
      lines.push(
        `            ${slot.imageType}: ${slot.action}${slot.complete && isMultiImage(slot.imageType) ? ' (complete set)' : ''}`,
      );
      for (const image of slot.upload) {
        lines.push(`              + ${image.path} ${image.sha256.slice(0, 12)}`);
      }
      for (const image of slot.remove) {
        lines.push(`              - ${image.id} ${image.sha256.slice(0, 12) || '(no digest)'}`);
      }
      for (const note of slot.notes) {
        lines.push(`              note: ${note}`);
      }
    }
  }
  for (const language of plan.remoteOnlyLanguages) {
    lines.push(`  remote    ${language}: only on Play; not in the file (never deleted)`);
  }
  if (plan.imageRemovals > 0) {
    lines.push(
      `  IMAGE REMOVAL: ${plan.imageRemovals} image(s); apply needs --confirm-image-removal`,
    );
  }
  for (const note of plan.notes) {
    lines.push(`  note      ${note}`);
  }
  for (const step of plan.manual) {
    lines.push(`  manual    ${step}`);
  }
  return lines.join('\n');
}
