import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import typia from 'typia';

import {
  commerceProtocol,
  commerceProtocolVersion,
  type ActiveSubscription,
  type CommerceBridgeFetchProductsPayload,
  type CommerceBridgeFetchProductsResult,
  type CommerceBridgeFinishTransactionPayload,
  type CommerceBridgeFinishTransactionResult,
  type CommerceBridgeGetAvailablePurchasesPayload,
  type CommerceBridgeGetAvailablePurchasesResult,
  type CommerceBridgeGetCapabilitiesPayload,
  type CommerceBridgeGetCapabilitiesResult,
  type CommerceBridgeRequestPurchasePayload,
  type CommerceBridgeRequestPurchaseResult,
  type CommerceBridgeRestorePurchasesPayload,
  type CommerceBridgeRestorePurchasesResult,
  type CommerceCapabilities,
  type CommerceEvent,
  type CommerceEventEnvelope,
  type CommerceServiceCapabilities,
  type CreditLot,
  type StoreProduct,
  type StorePurchase,
} from '@mpgd/platform/commerce';
import type { CommerceConformanceVector } from '@mpgd/platform/commerce-vectors';

import { isCliEntrypoint } from '../io';

export const commerceSchemaDirectory = 'docs/specs/commerce/schemas';
export const commerceSchemaIndexFile = 'index.json';
export const commerceSchemaRegenerateCommand = 'pnpm generate:commerce-schemas';

/** Named types published as JSON Schema, in file order. */
const commerceSchemaNames = [
  'StoreProduct',
  'StorePurchase',
  'CommerceCapabilities',
  'CommerceServiceCapabilities',
  'CommerceEvent',
  'CommerceEventEnvelope',
  'ActiveSubscription',
  'CreditLot',
  'CommerceBridgeGetCapabilitiesPayload',
  'CommerceBridgeGetCapabilitiesResult',
  'CommerceBridgeFetchProductsPayload',
  'CommerceBridgeFetchProductsResult',
  'CommerceBridgeRequestPurchasePayload',
  'CommerceBridgeRequestPurchaseResult',
  'CommerceBridgeGetAvailablePurchasesPayload',
  'CommerceBridgeGetAvailablePurchasesResult',
  'CommerceBridgeFinishTransactionPayload',
  'CommerceBridgeFinishTransactionResult',
  'CommerceBridgeRestorePurchasesPayload',
  'CommerceBridgeRestorePurchasesResult',
  'CommerceConformanceVector',
] as const;

export interface CommerceSchemaFile {
  readonly fileName: string;
  readonly content: string;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue };

interface SchemaCollection {
  readonly schemas: readonly JsonValue[];
  readonly components: { readonly schemas?: Readonly<Record<string, JsonValue>> };
}

/**
 * Renders every schema file in memory. The output depends only on the
 * platform types and the typia version, so the alignment validator can compare
 * it byte for byte with the committed files.
 */
export function renderCommerceSchemaFiles(): readonly CommerceSchemaFile[] {
  const collection = typia.json.schemas<[
    StoreProduct,
    StorePurchase,
    CommerceCapabilities,
    CommerceServiceCapabilities,
    CommerceEvent,
    CommerceEventEnvelope,
    ActiveSubscription,
    CreditLot,
    CommerceBridgeGetCapabilitiesPayload,
    CommerceBridgeGetCapabilitiesResult,
    CommerceBridgeFetchProductsPayload,
    CommerceBridgeFetchProductsResult,
    CommerceBridgeRequestPurchasePayload,
    CommerceBridgeRequestPurchaseResult,
    CommerceBridgeGetAvailablePurchasesPayload,
    CommerceBridgeGetAvailablePurchasesResult,
    CommerceBridgeFinishTransactionPayload,
    CommerceBridgeFinishTransactionResult,
    CommerceBridgeRestorePurchasesPayload,
    CommerceBridgeRestorePurchasesResult,
    CommerceConformanceVector,
  ]>() as unknown as SchemaCollection;
  const components = collection.components.schemas ?? {};
  if (collection.schemas.length !== commerceSchemaNames.length) {
    throw new Error('typia produced an unexpected number of commerce schemas.');
  }

  const files = commerceSchemaNames.map((name, index) => {
    const schema = collection.schemas[index];
    if (schema === undefined) {
      throw new Error(`Missing commerce schema for ${name}.`);
    }
    const fileName = `${toKebabCase(name)}.schema.json`;
    const referenced = collectReferencedComponents(schema, components);
    const document = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `https://github.com/imjlk/mpgd-kit/${commerceSchemaDirectory}/${fileName}`,
      title: name,
      'x-mpgd-protocol': commerceProtocol,
      'x-mpgd-protocol-version': commerceProtocolVersion,
      ...(typeof schema === 'object' && schema !== null && !Array.isArray(schema) ? schema : {}),
      ...(Object.keys(referenced).length === 0 ? {} : { components: { schemas: referenced } }),
    };
    return { fileName, content: `${JSON.stringify(document, null, 2)}\n` };
  });

  const index = {
    protocol: commerceProtocol,
    protocolVersion: commerceProtocolVersion,
    regenerate: commerceSchemaRegenerateCommand,
    schemas: files.map((file, position) => ({
      title: commerceSchemaNames[position],
      file: file.fileName,
    })),
  };
  return [
    { fileName: commerceSchemaIndexFile, content: `${JSON.stringify(index, null, 2)}\n` },
    ...files,
  ];
}

export function writeCommerceSchemaFiles(directory = commerceSchemaDirectory): readonly string[] {
  const files = renderCommerceSchemaFiles();
  mkdirSync(directory, { recursive: true });
  const expected = new Set(files.map((file) => file.fileName));
  for (const stale of readdirSync(directory)) {
    if (stale.endsWith('.json') && !expected.has(stale) && existsSync(join(directory, stale))) {
      rmSync(join(directory, stale));
    }
  }
  for (const file of files) {
    writeFileSync(join(directory, file.fileName), file.content);
  }
  return files.map((file) => file.fileName);
}

function collectReferencedComponents(
  root: JsonValue,
  components: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const referenced: Record<string, JsonValue> = {};
  const pending: JsonValue[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === undefined || typeof value !== 'object' || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key === '$ref' && typeof nested === 'string') {
        const name = nested.replace(/^#\/components\/schemas\//u, '');
        const component = components[name];
        if (component === undefined) {
          throw new Error(`Commerce schema references unknown component ${nested}.`);
        }
        if (!(name in referenced)) {
          referenced[name] = component;
          pending.push(component);
        }
        continue;
      }
      pending.push(nested);
    }
  }
  return Object.fromEntries(
    Object.keys(referenced).sort().map((name) => [name, referenced[name] as JsonValue]),
  );
}

function toKebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase();
}

if (isCliEntrypoint(import.meta.url)) {
  const written = writeCommerceSchemaFiles();
  console.info(
    `Commerce v2 schemas (${commerceProtocolVersion}): wrote ${written.length} files to `
      + `${commerceSchemaDirectory}`,
  );
}
