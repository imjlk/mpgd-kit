/** Private sample contracts, not a proposed public package API. */
export interface PackImage {
  readonly id: string;
  readonly path: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

export interface AssetPack {
  readonly id: string;
  readonly revision: string;
  readonly dependsOn: readonly string[];
  readonly images: readonly PackImage[];
}

export interface DeliveryPack extends AssetPack {
  readonly packaged: boolean;
}

export interface PlannedImage extends PackImage {
  readonly identity: string;
  readonly packId: string;
}

export function planImages(catalog: readonly AssetPack[], rootId: string): readonly PlannedImage[] {
  const packs = new Map(catalog.map((pack) => [pack.id, pack]));
  if (packs.size !== catalog.length) throw new Error('Duplicate pack identifier');
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const images: PlannedImage[] = [];
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Cyclic pack dependency: ${id}`);
    if (visited.has(id)) return;
    const pack = packs.get(id);
    if (!pack) throw new Error(`Unknown pack: ${id}`);
    visiting.add(id);
    for (const dependency of pack.dependsOn) visit(dependency);
    const keys = new Set<string>();
    for (const image of pack.images) {
      if (keys.has(image.id)) throw new Error(`Duplicate image: ${id}/${image.id}`);
      keys.add(image.id);
      images.push({ ...image, packId: id, identity: `${id}/${pack.revision}/${image.id}/${image.sha256}` });
    }
    visiting.delete(id);
    visited.add(id);
  };
  visit(rootId);
  return images;
}
