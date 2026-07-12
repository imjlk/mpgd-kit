import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import sharp, { type Metadata } from 'sharp';

export interface ValidatedBrandImage {
  readonly path: string;
  readonly bytes: Buffer;
  readonly format: 'png' | 'svg';
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly warnings: readonly string[];
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maximumDimension = 8192;
const maximumPixels = maximumDimension * maximumDimension;

export async function validateBrandImage(
  path: string,
  options: { readonly strict: boolean; readonly minimumSize?: number },
): Promise<ValidatedBrandImage> {
  const bytes = readFileSync(path);
  const format = sniffFormat(bytes);
  if (format === 'png' && hasPngChunk(bytes, 'acTL')) {
    throw new Error(`Animated or multi-page brand images are not supported: ${path}`);
  }
  const warnings = format === 'svg' ? validateSvg(bytes, options.strict) : [];
  let metadata: Metadata;

  try {
    metadata = await sharp(bytes, { animated: true, limitInputPixels: maximumPixels }).metadata();
  } catch (error) {
    throw new Error(`Invalid brand image ${path}: ${formatError(error)}`);
  }

  const width = metadata.width;
  const height = metadata.height;

  if (width === undefined || height === undefined || width < 1 || height < 1) {
    throw new Error(`Brand image has no usable dimensions: ${path}`);
  }

  if (width !== height) {
    throw new Error(`Brand image must be square, got ${width}x${height}: ${path}`);
  }

  if (width > maximumDimension || height > maximumDimension) {
    throw new Error(`Brand image exceeds ${maximumDimension}x${maximumDimension}: ${path}`);
  }

  if ((metadata.pages ?? 1) > 1) {
    throw new Error(`Animated or multi-page brand images are not supported: ${path}`);
  }

  if (format === 'png' && options.minimumSize !== undefined && width < options.minimumSize) {
    throw new Error(
      `PNG brand image must be at least ${options.minimumSize}x${options.minimumSize}; got ${width}x${height}: ${path}`,
    );
  }

  return {
    path,
    bytes,
    format,
    width,
    height,
    sha256: sha256(bytes),
    warnings,
  };
}

export async function renderProfileOutput(input: {
  readonly image: ValidatedBrandImage;
  readonly width: number;
  readonly height: number;
  readonly safeZone: number;
  readonly opaque: boolean;
  readonly backgroundColor: string;
  readonly monochrome: boolean;
}): Promise<Buffer> {
  if (input.image.format === 'png' && input.image.width < Math.max(input.width, input.height)) {
    throw new Error(
      `Refusing to upscale ${input.image.width}x${input.image.height} PNG to ${input.width}x${input.height}: ${input.image.path}`,
    );
  }

  const contentWidth = Math.max(1, Math.floor(input.width * input.safeZone));
  const contentHeight = Math.max(1, Math.floor(input.height * input.safeZone));
  let content = sharp(input.image.bytes, { limitInputPixels: maximumPixels })
    .rotate()
    .resize(contentWidth, contentHeight, {
      fit: 'contain',
      withoutEnlargement: input.image.format === 'png',
      kernel: sharp.kernel.lanczos3,
    })
    .toColourspace('srgb');

  if (input.monochrome) {
    content = content.grayscale().threshold(128);
  }

  const contentBuffer = await content.png({
    compressionLevel: 9,
    adaptiveFiltering: false,
    palette: false,
    effort: 10,
  }).toBuffer();
  const left = Math.floor((input.width - contentWidth) / 2);
  const top = Math.floor((input.height - contentHeight) / 2);
  const background = input.opaque ? input.backgroundColor : { r: 0, g: 0, b: 0, alpha: 0 };

  let output = sharp({
    create: {
      width: input.width,
      height: input.height,
      channels: 4,
      background,
    },
  })
    .composite([{ input: contentBuffer, left, top }])
    .toColourspace('srgb');

  if (input.opaque) {
    output = output.removeAlpha();
  }

  return output
    .png({
      compressionLevel: 9,
      adaptiveFiltering: false,
      palette: false,
      effort: 10,
    })
    .toBuffer();
}

export async function pixelSha256(bytes: Buffer): Promise<string> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const dimensions = Buffer.from(`${info.width}x${info.height}:${info.channels}:`, 'utf8');
  return sha256(Buffer.concat([dimensions, data]));
}

export async function isPngOpaque(bytes: Buffer): Promise<boolean> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });

  for (let offset = info.channels - 1; offset < data.length; offset += info.channels) {
    if (data[offset] !== 255) {
      return false;
    }
  }

  return true;
}

export function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function sniffFormat(bytes: Buffer): 'png' | 'svg' {
  if (bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    return 'png';
  }

  const head = bytes.subarray(0, Math.min(bytes.length, 4096)).toString('utf8').trimStart();

  if (/^(?:<\?xml\b[^>]*>\s*)?<svg\b/iu.test(head)) {
    return 'svg';
  }

  throw new Error('Brand image content must be PNG or SVG.');
}

function hasPngChunk(bytes: Buffer, chunkName: string): boolean {
  let offset = pngSignature.length;

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;

    if (end > bytes.length) {
      return false;
    }

    if (bytes.subarray(offset + 4, offset + 8).toString('ascii') === chunkName) {
      return true;
    }

    offset = end;
  }

  return false;
}

function validateSvg(bytes: Buffer, strict: boolean): string[] {
  const source = bytes.toString('utf8');
  const prohibited = [
    { pattern: /<script\b/iu, label: 'script elements' },
    { pattern: /<!DOCTYPE\b|<!ENTITY\b/iu, label: 'DTD or entity declarations' },
    { pattern: /\bon\w+\s*=/iu, label: 'event handler attributes' },
    { pattern: /@import\b/iu, label: 'external stylesheet imports' },
    { pattern: /<foreignObject\b/iu, label: 'foreignObject elements' },
  ] as const;

  for (const rule of prohibited) {
    if (rule.pattern.test(source)) {
      throw new Error(`SVG brand image contains prohibited ${rule.label}.`);
    }
  }

  for (const match of source.matchAll(/\b(?:href|xlink:href)\s*=\s*["']\s*([^"']+)/giu)) {
    const reference = match[1]?.trim() ?? '';

    if (!reference.startsWith('#') && !/^data:image\/(?:png|jpeg|webp);base64,/iu.test(reference)) {
      throw new Error('SVG brand image contains prohibited external references.');
    }
  }

  for (const match of source.matchAll(/url\(\s*["']?\s*([^)'"\s]+)/giu)) {
    const reference = match[1]?.trim() ?? '';

    if (!reference.startsWith('#') && !/^data:/iu.test(reference)) {
      throw new Error('SVG brand image contains prohibited external URL references.');
    }
  }

  const viewBox = source.match(/\bviewBox\s*=\s*["']\s*([^"']+)\s*["']/iu)?.[1];

  if (viewBox === undefined) {
    throw new Error('SVG brand image must define a square viewBox.');
  }

  const values = viewBox.trim().split(/[\s,]+/u).map(Number);

  if (
    values.length !== 4
    || values.some((value) => !Number.isFinite(value))
    || values[2] === undefined
    || values[3] === undefined
    || values[2] <= 0
    || values[2] !== values[3]
  ) {
    throw new Error(`SVG brand image viewBox must be square, got "${viewBox}".`);
  }

  const warnings: string[] = [];

  if (/<text\b/iu.test(source)) {
    const message = 'SVG brand image contains <text>; convert text to paths for deterministic rendering.';

    if (strict) {
      throw new Error(message);
    }

    warnings.push(message);
  }

  return warnings;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
