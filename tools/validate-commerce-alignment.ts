import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { commerceProtocolVersion } from '@mpgd/platform/commerce';
import {
  assertCommerceConformanceVector,
  commerceConformanceVectorNameOf,
} from '@mpgd/platform/commerce-vectors';

import {
  commerceSchemaDirectory,
  commerceSchemaRegenerateCommand,
  renderCommerceSchemaFiles,
} from './commerce/generate-commerce-schemas';
import { isCliEntrypoint, readJsonFile } from './io';

export const commerceVectorDirectory = 'docs/specs/commerce/vectors';

export interface CommerceAlignmentReport {
  readonly protocolVersion: string;
  readonly vectors: readonly string[];
  readonly schemaFiles: readonly string[];
}

/**
 * Checks that the protocol constant, every conformance vector, and the
 * committed JSON Schemas agree. It reads source only; no package build runs.
 */
export function validateCommerceAlignment(input: {
  readonly vectorDirectory?: string;
  readonly schemaDirectory?: string;
} = {}): CommerceAlignmentReport {
  const vectorDirectory = input.vectorDirectory ?? commerceVectorDirectory;
  const schemaDirectory = input.schemaDirectory ?? commerceSchemaDirectory;
  const failures: string[] = [];

  const vectorFiles = readdirSync(vectorDirectory).filter((file) => file.endsWith('.json')).sort();
  if (vectorFiles.length === 0) {
    failures.push(`No conformance vectors found in ${vectorDirectory}.`);
  }
  const vectors: string[] = [];
  for (const file of vectorFiles) {
    const path = join(vectorDirectory, file);
    try {
      const vector = assertCommerceConformanceVector(readJsonFile(path));
      const expectedName = commerceConformanceVectorNameOf(file);
      if (vector.vector !== expectedName) {
        failures.push(
          `${path}: vector name ${vector.vector} must equal the file name ${expectedName}.`,
        );
      }
      if (vector.protocol !== commerceProtocolVersion) {
        failures.push(
          `${path}: protocol ${vector.protocol} must equal commerceProtocolVersion `
            + `${commerceProtocolVersion}.`,
        );
      }
      vectors.push(vector.vector);
    } catch (error) {
      failures.push(`${path}: ${errorMessage(error)}`);
    }
  }

  const rendered = renderCommerceSchemaFiles();
  const changed: string[] = [];
  for (const file of rendered) {
    const path = join(schemaDirectory, file.fileName);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== file.content) {
      changed.push(file.fileName);
      continue;
    }
    const document = readJsonFile(path) as Readonly<Record<string, unknown>>;
    const version = file.fileName === 'index.json'
      ? document.protocolVersion
      : document['x-mpgd-protocol-version'];
    if (version !== commerceProtocolVersion) {
      failures.push(
        `${path}: schema protocol version ${String(version)} must equal ${commerceProtocolVersion}.`,
      );
    }
  }
  const expectedFiles = new Set(rendered.map((file) => file.fileName));
  const stale = existsSync(schemaDirectory)
    ? readdirSync(schemaDirectory).filter(
        (file) => file.endsWith('.json') && !expectedFiles.has(file),
      )
    : [];
  if (changed.length > 0 || stale.length > 0) {
    failures.push(
      `Commerce schemas in ${schemaDirectory} are out of date `
        + `(changed: ${changed.join(', ') || 'none'}; stale: ${stale.join(', ') || 'none'}). `
        + `Run ${commerceSchemaRegenerateCommand} and commit the result.`,
    );
  }

  if (failures.length > 0) {
    throw new Error(`Commerce v2 alignment failed:\n- ${failures.join('\n- ')}`);
  }
  return {
    protocolVersion: commerceProtocolVersion,
    vectors,
    schemaFiles: rendered.map((file) => file.fileName),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (isCliEntrypoint(import.meta.url)) {
  const report = validateCommerceAlignment();
  console.info(
    `Commerce v2 alignment ${report.protocolVersion}: ${report.vectors.length} vectors, `
      + `${report.schemaFiles.length} schema files`,
  );
}
