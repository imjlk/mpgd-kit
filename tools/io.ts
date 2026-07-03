import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
}

export function isCliEntrypoint(metaUrl: string): boolean {
  const scriptPath = process.argv[1];
  return scriptPath !== undefined && metaUrl === pathToFileURL(scriptPath).href;
}
