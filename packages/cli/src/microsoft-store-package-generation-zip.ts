import { closeSync, openSync, readSync } from 'node:fs';

export function assertMicrosoftStorePackageZip(file: string, sizeBytes: number): void {
  if (sizeBytes < 22) {
    throw new Error('PWABuilder package archive is truncated.');
  }

  const descriptor = openSync(file, 'r');

  try {
    const header = Buffer.allocUnsafe(4);
    readExactly(descriptor, header, 0);

    if (header.readUInt32LE(0) !== 0x04034b50) {
      throw new Error('PWABuilder package archive must start with a ZIP local file header.');
    }

    const tailLength = Math.min(sizeBytes, 65_557);
    const tail = Buffer.allocUnsafe(tailLength);
    readExactly(descriptor, tail, sizeBytes - tailLength);
    const endOffset = findEndOfCentralDirectory(tail);

    if (endOffset < 0) {
      throw new Error('PWABuilder package archive is missing its ZIP end record.');
    }

    const commentLength = tail.readUInt16LE(endOffset + 20);

    if (endOffset + 22 + commentLength !== tail.length) {
      throw new Error('PWABuilder package archive has a truncated or trailing ZIP end record.');
    }

    const diskNumber = tail.readUInt16LE(endOffset + 4);
    const centralDirectoryDisk = tail.readUInt16LE(endOffset + 6);
    const entriesOnDisk = tail.readUInt16LE(endOffset + 8);
    const totalEntries = tail.readUInt16LE(endOffset + 10);
    const centralDirectorySize = tail.readUInt32LE(endOffset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(endOffset + 16);
    const absoluteEndOffset = sizeBytes - tailLength + endOffset;

    if (
      diskNumber !== 0
      || centralDirectoryDisk !== 0
      || entriesOnDisk === 0
      || entriesOnDisk !== totalEntries
      || centralDirectoryOffset + centralDirectorySize !== absoluteEndOffset
    ) {
      throw new Error('PWABuilder package archive has an unsupported ZIP directory layout.');
    }

    assertSafeZipEntries(descriptor, centralDirectoryOffset, absoluteEndOffset, totalEntries);
  } finally {
    closeSync(descriptor);
  }
}

function assertSafeZipEntries(
  descriptor: number,
  centralDirectoryOffset: number,
  centralDirectoryEnd: number,
  totalEntries: number,
): void {
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    const header = Buffer.allocUnsafe(46);

    if (cursor + header.length > centralDirectoryEnd) {
      throw new Error('PWABuilder package archive has a truncated ZIP central directory.');
    }

    readExactly(descriptor, header, cursor);

    if (header.readUInt32LE(0) !== 0x02014b50) {
      throw new Error('PWABuilder package archive has an invalid ZIP central directory.');
    }

    const fileNameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    const entryLength = header.length + fileNameLength + extraLength + commentLength;

    if (cursor + entryLength > centralDirectoryEnd) {
      throw new Error('PWABuilder package archive has a truncated ZIP central directory entry.');
    }

    const fileNameBytes = Buffer.allocUnsafe(fileNameLength);
    readExactly(descriptor, fileNameBytes, cursor + header.length);
    assertSafeZipEntryName(fileNameBytes.toString('utf8'));

    const unixMode = (header.readUInt32LE(38) >>> 16) & 0o170000;

    if (unixMode === 0o120000) {
      throw new Error('PWABuilder package archive must not contain symbolic links.');
    }

    const localHeaderOffset = header.readUInt32LE(42);

    if (localHeaderOffset >= centralDirectoryOffset) {
      throw new Error('PWABuilder package archive has an invalid ZIP local header offset.');
    }

    const localHeader = Buffer.allocUnsafe(4);
    readExactly(descriptor, localHeader, localHeaderOffset);

    if (localHeader.readUInt32LE(0) !== 0x04034b50) {
      throw new Error('PWABuilder package archive has an invalid ZIP local file header.');
    }

    cursor += entryLength;
  }

  if (cursor !== centralDirectoryEnd) {
    throw new Error('PWABuilder package archive has an inconsistent ZIP central directory.');
  }
}

function assertSafeZipEntryName(input: string): void {
  const normalized = input.replaceAll('\\', '/');
  const components = normalized.split('/');

  if (
    input.length === 0
    || input.includes('\0')
    || normalized.startsWith('/')
    || /^[A-Za-z]:/u.test(normalized)
    || components.some((component) => component.includes(':'))
    || components.some((component, index) => (
      component === '.'
      || component === '..'
      || (component.length === 0 && index !== components.length - 1)
    ))
  ) {
    throw new Error(`PWABuilder package archive contains an unsafe ZIP entry path: ${input}`);
  }
}

function findEndOfCentralDirectory(input: Buffer): number {
  for (let offset = input.length - 22; offset >= 0; offset -= 1) {
    if (input.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  return -1;
}

function readExactly(descriptor: number, output: Buffer, position: number): void {
  let offset = 0;

  while (offset < output.length) {
    const bytesRead = readSync(
      descriptor,
      output,
      offset,
      output.length - offset,
      position + offset,
    );

    if (bytesRead === 0) {
      throw new Error('PWABuilder package archive is truncated.');
    }

    offset += bytesRead;
  }
}
