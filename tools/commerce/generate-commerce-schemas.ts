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
import {
  renderJsonSchemaFiles,
  writeJsonSchemaFiles,
  type JsonSchemaCollection,
  type JsonSchemaFile,
} from '../json-schema-files';

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

export type CommerceSchemaFile = JsonSchemaFile;

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
  ]>() as unknown as JsonSchemaCollection;
  return renderJsonSchemaFiles({
    label: 'commerce',
    names: commerceSchemaNames,
    collection,
    directory: commerceSchemaDirectory,
    indexFile: commerceSchemaIndexFile,
    protocol: commerceProtocol,
    protocolVersion: commerceProtocolVersion,
    regenerate: commerceSchemaRegenerateCommand,
  });
}

export function writeCommerceSchemaFiles(directory = commerceSchemaDirectory): readonly string[] {
  return writeJsonSchemaFiles(directory, renderCommerceSchemaFiles());
}

if (isCliEntrypoint(import.meta.url)) {
  const written = writeCommerceSchemaFiles();
  console.info(
    `Commerce v2 schemas (${commerceProtocolVersion}): wrote ${written.length} files to `
      + `${commerceSchemaDirectory}`,
  );
}
