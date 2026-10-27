import path from 'node:path';

import {
  googlePlayPresenceImageSlots,
  googlePlayPresenceLimits,
  resolveStorePresenceImageSet,
  type GooglePlayPresence,
  type GooglePlayPresenceListing,
  type StorePresence,
} from '@mpgd/catalog';

import { isDefinitiveHttpError } from './play-internal-submission.js';
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
  normalizeLineBreaks,
  readLocalStoreImage,
  sameUrlForm,
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

  const notes: string[] = [];
  const planned = languages.map((language) =>
    planLanguage({
      notes,
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

  const defaultLanguage = typeof details.defaultLanguage === 'string'
    ? details.defaultLanguage
    : undefined;
  if (defaultLanguage !== undefined && !named.has(defaultLanguage.toLowerCase())) {
    notes.push(
      `Play's default language ${defaultLanguage} is not in the file; its listing stays as Play has it.`,
    );
  }
  const plannedDetails = planDetails(details, play, notes);
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
        .map(([key, images]) => [
          key,
          images.map((image) => ({ id: image.id, sha256: image.sha256, sha1: image.sha1 })),
        ]),
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
  /** Plan-level notes. */
  readonly notes: string[];
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
  const fullDescription = normalizeLineBreaks(entry.fullDescription);
  const text = [
    describeTextChange('title', remote?.title, entry.title),
    describeTextChange('shortDescription', remote?.shortDescription, entry.shortDescription),
    describeTextChange('fullDescription', remote?.fullDescription, fullDescription),
    entry.video === undefined ? undefined : describeTextChange('video', remote?.video, entry.video),
  ].filter((change) => change !== undefined);
  if (entry.video !== undefined && typeof remote?.video === 'string' && remote.video !== entry.video
    && sameUrlForm(remote.video, entry.video)) {
    input.notes.push(
      `${language} video differs from Play's only in URL form (${remote.video}); Play may normalize it.`,
    );
  }
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
        fullDescription,
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
  const remoteDigests = remote.map((image) => remoteImageDigest(image, local, imageType));
  const desired = local.map(
    (image): PlannedPlayImage => ({ path: image.path, sha256: image.sha256 }),
  );
  const desiredDigests = desired.map((image) => image.sha256);
  const notes: string[] = [];
  const same = remoteDigests.length === desiredDigests.length
    && remoteDigests.every((digest, index) => digest === desiredDigests[index]);
  const unchanged = (): PlannedPlayImageSlot => ({
    imageType,
    action: 'unchanged',
    complete,
    upload: [],
    keep: remoteDigests,
    remove: [],
    notes,
  });
  const replace = (): PlannedPlayImageSlot => ({
    imageType,
    action: 'replace',
    complete,
    upload: desired,
    keep: [],
    remove: remote
      .map((image, index) => ({ id: String(image.id), sha256: remoteDigests[index] ?? '' }))
      .filter((image) => !desiredDigests.includes(image.sha256)),
    notes,
  });
  if (same) {
    return unchanged();
  }
  if (!isMultiImage(imageType)) {
    // The file names the one icon or feature graphic: it replaces Play's.
    return remote.length === 0
      ? { imageType, action: 'add', complete, upload: desired, keep: [], remove: [], notes }
      : replace();
  }
  const isPrefix = remoteDigests.length < desiredDigests.length
    && remoteDigests.every((digest, index) => digest === desiredDigests[index]);
  if (complete && !isPrefix) {
    if (remoteDigests.some((digest) => desiredDigests.includes(digest))) {
      notes.push("Play's images are deleted and the set uploaded again in the file's order.");
    }
    return replace();
  }
  const missing = desired.filter((image) => !remoteDigests.includes(image.sha256));
  if (missing.length === 0) {
    notes.push(
      "Play holds the file's images in another order or with others; mark the set complete to match it.",
    );
    return unchanged();
  }
  if (remote.length + missing.length > googlePlayPresenceLimits.screenshots) {
    throw new Error(
      `Google Play ${imageType}: Play holds ${remote.length} and the file adds ${missing.length}; a set takes at `
      + `most ${googlePlayPresenceLimits.screenshots}. Mark the set complete to replace Play's images.`,
    );
  }
  if (!complete && remote.length > 0) {
    notes.push(
      `Play keeps ${remote.length - (desired.length - missing.length)} image(s) the file does not list.`,
    );
  }
  return {
    imageType,
    action: 'add',
    complete,
    upload: missing,
    keep: remoteDigests,
    remove: [],
    notes,
  };
}

/**
 * The digest a Play image is compared by: its SHA-256, else (Play reported
 * only SHA-1) the SHA-256 of the file image with that SHA-1. An image with
 * neither cannot be compared, so the plan stops instead of re-uploading it
 * on every run.
 */
function remoteImageDigest(image: PlayImage, local: readonly LocalStoreImage[], imageType: PlayImageType): string {
  if (typeof image.sha256 === 'string' && image.sha256 !== '') {
    return image.sha256.toLowerCase();
  }
  if (typeof image.sha1 === 'string' && image.sha1 !== '') {
    const sha1 = image.sha1.toLowerCase();
    return local.find((candidate) => candidate.sha1 === sha1)?.sha256 ?? `sha1:${sha1}`;
  }
  throw new Error(
    `Google Play ${imageType}: Play reports image ${String(image.id)} without a SHA-256 or SHA-1, so the sync `
    + 'cannot compare it; replace the images of this slot in Play Console.',
  );
}

function planDetails(
  details: PlayAppDetails,
  play: GooglePlayPresence,
  notes: string[],
): PlayPresencePlan['details'] {
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
      if (field === 'contactWebsite' && typeof from === 'string' && sameUrlForm(from, value)) {
        notes.push(
          `The contact website differs from Play's only in URL form (${from}); Play may normalize it.`,
        );
      }
      changes.push({
        field,
        ...(typeof from === 'string' && from !== '' ? { from } : {}),
        to: value,
      });
      write[field] = value;
    }
  }
  if (changes.length === 0) {
    return undefined;
  }
  // edits.details.update replaces the whole object, and Play requires a contact email.
  if (write.contactEmail === undefined) {
    throw new Error(
      'Google Play has no contact email for the app and the file gives none; Play needs one to update the '
      + 'contact details. Add googlePlay.contact.email.',
    );
  }
  return { changes, write };
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
  // A commit that failed without a definitive answer may have landed.
  let commitUncertain = false;
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
          const localFile = localImage(local, language.language, slot.imageType, image.sha256);
          const stored = await port.uploadImage({
            ...target,
            file,
            mimeType: imageMimeType(localFile.info),
            timeoutMs: uploadTimeoutMs,
          });
          uploaded += 1;
          assertStoredDigest(stored, localFile);
        }
      }
      languages.push({ language: language.language, listing: language.action, images: uploaded });
    }
    stage = 'commit';
    try {
      await port.commitEdit({
        packageName,
        editId,
        changesNotSentForReview: input.changesNotSentForReview === true,
        ...optionalSignal,
      });
    } catch (error) {
      // A definitive 4xx (for example ERROR_IF_IN_REVIEW while a release is
      // in review) did not commit; anything else may have.
      commitUncertain = !isDefinitiveHttpError(error);
      throw error;
    }
    return { packageName, status: 'committed', languages };
  } catch (error) {
    // Never delete an edit that may have been committed (as deploy promote).
    if (!commitUncertain) {
      await discardEdit(port, packageName, editId);
    }
    // Nothing was written before the first write stage: the error stands as it is.
    if (error instanceof StorePlanStaleError || stage === 'read') {
      throw error;
    }
    throw new PlayPresenceApplyError(stage, commitUncertain ? 'unknown' : 'discarded', error);
  }
}

/**
 * Images are matched by digest: one Play stores under another digest (for
 * example re-encoded) would be uploaded again by every later apply, and one
 * without a digest could never be matched.
 */
function assertStoredDigest(stored: PlayImage, image: LocalStoreImage): void {
  if (typeof stored.sha256 === 'string' && stored.sha256 !== '') {
    if (stored.sha256.toLowerCase() !== image.sha256) {
      throw new Error(
        `Play stored ${image.path} with SHA-256 ${stored.sha256}, not the file's ${image.sha256}; `
        + 'the sync matches images by digest and cannot keep this slot in step',
      );
    }
    return;
  }
  if (typeof stored.sha1 === 'string' && stored.sha1 !== '') {
    if (stored.sha1.toLowerCase() !== image.sha1) {
      throw new Error(
        `Play stored ${image.path} with SHA-1 ${stored.sha1}, not the file's ${image.sha1}; `
        + 'the sync matches images by digest and cannot keep this slot in step',
      );
    }
    return;
  }
  throw new Error(
    `Play answered the upload of ${image.path} without a SHA-256 or SHA-1; the sync cannot confirm it`,
  );
}

function localImage(
  local: LocalGraphics,
  language: string,
  imageType: PlayImageType,
  sha256: string,
): LocalStoreImage {
  for (const [fileLanguage, slots] of local) {
    if (fileLanguage.toLowerCase() !== language.toLowerCase()) {
      continue;
    }
    const image = slots.get(imageType)?.images.find((candidate) => candidate.sha256 === sha256);
    if (image !== undefined) {
      return image;
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
