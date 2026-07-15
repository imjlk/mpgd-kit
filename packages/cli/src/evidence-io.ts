import { closeSync, openSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface EvidenceReportFilesInput {
  readonly jsonFile: string;
  readonly markdownFile: string;
  readonly report: unknown;
  readonly markdown: string;
}

export function writeEvidenceReportFiles(input: EvidenceReportFilesInput): void {
  writeFileSync(input.jsonFile, `${JSON.stringify(input.report, null, 2)}\n`);
  writeFileSync(input.markdownFile, input.markdown);
}

export function readBoundedUtf8File(file: string, maximumBytes: number): string | null {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  const fileDescriptor = openSync(file, 'r');
  let offset = 0;

  try {
    while (offset < buffer.length) {
      const bytesRead = readSync(fileDescriptor, buffer, offset, buffer.length - offset, null);

      if (bytesRead === 0) {
        break;
      }

      offset += bytesRead;
    }
  } finally {
    closeSync(fileDescriptor);
  }

  return offset > maximumBytes ? null : buffer.subarray(0, offset).toString('utf8');
}

export function relativeOrAbsolute(root: string, file: string): string {
  const relative = path.relative(root, file);

  return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative || '.';
}

export function escapeMarkdownTable(value: string): string {
  return escapeMarkdownInline(value).replaceAll('|', '\\|');
}

export function escapeMarkdownInline(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_\[\]])/gu, '\\$1')
    .replaceAll('\n', ' ');
}

export function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(1)}s`;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
