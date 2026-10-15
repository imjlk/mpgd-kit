import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { javascriptInventory } from './javascript-inventory.js';

export interface JavaScriptEntry {
  readonly file: string;
  readonly disposition: 'runtime-exception' | 'migration-backlog';
  readonly reason: string;
}

/** Exact paths keep existing migration debt from silently allowing new JavaScript. */
export function validateJavaScriptInventory(files: readonly string[], entries: readonly JavaScriptEntry[]): string[] {
  const errors: string[] = [];
  const existing = new Set(files);
  const registered = new Set<string>();
  for (const entry of entries) {
    if (registered.has(entry.file)) {
      errors.push(`Duplicate JavaScript entry: ${entry.file}`);
    }
    registered.add(entry.file);
    if (!existing.has(entry.file)) {
      errors.push(`Stale JavaScript entry: ${entry.file}`);
    }
    if (!/\.(?:[cm]?js|jsx)$/.test(entry.file) || /[*?\[\]\\]/.test(entry.file) || entry.file.startsWith('/') || entry.file.split('/').includes('..')) {
      errors.push(`JavaScript inventory requires an exact repository-relative path: ${entry.file}`);
    }
    if (!entry.reason.trim()) {
      errors.push(`Missing JavaScript rationale: ${entry.file}`);
    }
    if (!['runtime-exception', 'migration-backlog'].includes(entry.disposition)) {
      errors.push(`Invalid JavaScript disposition: ${entry.file}`);
    }
  }
  for (const file of existing) {
    if (!registered.has(file)) {
      errors.push(
      `Unregistered authored JavaScript: ${file}. Use TypeScript or document the runtime constraint.`,
    );
    }
  }
  return errors;
}

export function checkJavaScriptInventory(root: string): void {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.js', '*.mjs', '*.cjs', '*.jsx'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter((file) => file && existsSync(resolve(root, file)));
  const errors = validateJavaScriptInventory(files, javascriptInventory);
  assert.deepEqual(errors, [], errors.join('\n'));
  console.info(
    `JavaScript inventory checked: ${javascriptInventory.filter((entry) => entry.disposition === 'runtime-exception').length} constrained entries; ${javascriptInventory.filter((entry) => entry.disposition === 'migration-backlog').length} legacy entries awaiting migration.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkJavaScriptInventory(resolve(fileURLToPath(new URL('../../', import.meta.url))));
}
