import type { CommerceCapabilities } from '@mpgd/platform/commerce';

/**
 * Pure drift checks behind `pnpm validate:commerce-alignment`. Each check takes
 * its inputs as values, so a test can feed it a drifted fixture; the validator
 * (`tools/validate-commerce-alignment.ts`) reads the repository and calls them.
 * Every message names the drifted item so the failure can be fixed from the
 * output alone.
 */

/** The six commerce bridge methods, as `BridgeMethod` names them. */
export const commerceV2MethodPattern = /commerce\.v2\.[A-Za-z]+/gu;

/** The v1 commerce bridge methods C4 removed. They must not come back. */
export const removedV1CommerceMethods = Object.freeze([
  'commerce.getProducts',
  'commerce.purchase',
  'commerce.restore',
  'commerce.getEntitlements',
] as const);

export interface SourceText {
  readonly path: string;
  readonly text: string;
}

export interface BridgeMethodListInput {
  /** `commerceBridgeMethods` from `@mpgd/platform/commerce`. */
  readonly platformMethods: readonly string[];
  /** `bridgeCommerceV2Methods` from `@mpgd/bridge`. */
  readonly bridgeMethods: readonly string[];
  /** Source of the `BridgeMethod` union (`packages/bridge/src/index.ts`). */
  readonly bridgeIndexSource: SourceText;
  /** The bridge section of the RFC, which names the six methods. */
  readonly rfcBridgeSection: SourceText;
  /** `title` values of the published schema index. */
  readonly schemaTitles: readonly string[];
  /** Non-test sources of every transport and host (TypeScript, Java, Swift, mjs). */
  readonly sources: readonly SourceText[];
}

/**
 * Drift between the platform method list, the bridge method list and union,
 * the RFC, the published bridge schemas, and every transport that serves the
 * methods. A file that names two or more `commerce.v2.*` methods must name all
 * of them: a partially updated switch or table is the drift this catches.
 */
export function checkBridgeMethodLists(input: BridgeMethodListInput): string[] {
  const failures: string[] = [];
  const platform = [...input.platformMethods];
  const sameList = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((method, index) => method === right[index]);

  if (!sameList(platform, input.bridgeMethods)) {
    failures.push(
      `@mpgd/bridge bridgeCommerceV2Methods (${input.bridgeMethods.join(', ')}) must equal `
        + `@mpgd/platform/commerce commerceBridgeMethods (${platform.join(', ')}).`,
    );
  }
  for (const method of platform) {
    if (!input.bridgeIndexSource.text.includes(`'${method}'`)) {
      failures.push(`${input.bridgeIndexSource.path}: BridgeMethod does not name ${method}.`);
    }
    if (!input.rfcBridgeSection.text.includes(method)) {
      failures.push(`${input.rfcBridgeSection.path}: the bridge section does not name ${method}.`);
    }
    const schemaBase = `CommerceBridge${upperFirst(method.slice('commerce.v2.'.length))}`;
    for (const suffix of ['Payload', 'Result']) {
      if (!input.schemaTitles.includes(`${schemaBase}${suffix}`)) {
        failures.push(`The schema index has no ${schemaBase}${suffix} for ${method}.`);
      }
    }
  }
  const named = new Set(input.bridgeIndexSource.text.match(commerceV2MethodPattern) ?? []);
  for (const method of named) {
    if (!platform.includes(method)) {
      failures.push(
        `${input.bridgeIndexSource.path}: BridgeMethod names ${method}, which `
          + '@mpgd/platform/commerce does not define.',
      );
    }
  }
  const removedPattern = removedMethodPattern();
  for (const method of removedV1CommerceMethods) {
    if (new RegExp(`'${escapeRegExp(method)}'`, 'u').test(input.bridgeIndexSource.text)) {
      failures.push(`${input.bridgeIndexSource.path}: BridgeMethod still names removed ${method}.`);
    }
  }

  for (const source of input.sources) {
    const names = new Set(source.text.match(commerceV2MethodPattern) ?? []);
    if (names.size >= 2) {
      const missing = platform.filter((method) => !names.has(method));
      if (missing.length > 0) {
        failures.push(
          `${source.path}: serves ${names.size} commerce.v2 methods but not ${missing.join(', ')}.`,
        );
      }
    }
    for (const name of names) {
      if (!platform.includes(name)) {
        failures.push(
          `${source.path}: names ${name}, which @mpgd/platform/commerce does not define.`,
        );
      }
    }
    for (const match of source.text.matchAll(removedPattern)) {
      failures.push(
        `${source.path}: names removed v1 commerce method ${match[0].replaceAll(/['"]/gu, '')}.`,
      );
    }
  }
  return failures;
}

export interface RfcCapabilityRow {
  readonly store: string;
  readonly consumable: boolean;
  readonly durable: boolean;
  /** `conditional` rows (the wallet) sell subscriptions only under host billing authority. */
  readonly subscription: boolean | 'conditional';
  /** Whether the store reports unfinished purchases (the "available source" column is not `none`). */
  readonly availablePurchases: boolean;
  readonly pending: boolean;
  readonly finish: string;
  readonly evidence: string;
  readonly accountBinding: string;
}

/**
 * Reads the RFC "Capabilities" profile table. A row that does not parse is a
 * failure rather than a skipped store, so the table cannot silently drift out
 * of the shape this check reads.
 */
export function parseRfcCapabilityProfiles(markdown: string): {
  readonly rows: readonly RfcCapabilityRow[];
  readonly failures: readonly string[];
} {
  const failures: string[] = [];
  const rows: RfcCapabilityRow[] = [];
  const lines = markdown.split('\n');
  const header = lines.findIndex((line) => /^\|\s*Store id\s*\|/u.test(line));
  if (header < 0) {
    return { rows, failures: ['The RFC has no "Store id" capability profile table.'] };
  }
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) {
      break;
    }
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 9) {
      failures.push(`RFC capability row has ${cells.length} cells, expected 9: ${line}`);
      continue;
    }
    const [storeCell, consumable, durable, subscription, source, pending, finish, evidence, binding] =
      cells as [string, string, string, string, string, string, string, string, string];
    const store = storeCell.startsWith('`') ? stripTicks(storeCell) : 'wallet';
    const yesNo = (cell: string, label: string): boolean | undefined => {
      if (cell === 'yes') {
        return true;
      }
      if (cell === 'no') {
        return false;
      }
      failures.push(`RFC capability row ${store}: ${label} must be "yes" or "no", got "${cell}".`);
      return undefined;
    };
    const subscriptionValue = store === 'wallet'
      ? 'conditional'
      : yesNo(subscription, 'subscription');
    const consumableValue = yesNo(consumable, 'consumable');
    const durableValue = yesNo(durable, 'durable');
    const pendingValue = yesNo(pending, 'pending');
    const sourceValue = source.length === 0 ? undefined : source.toLowerCase() !== 'none';
    const finishValue = firstTick(finish);
    const evidenceValue = firstTick(evidence);
    const bindingValue = firstTick(binding);
    if (
      consumableValue === undefined || durableValue === undefined
      || subscriptionValue === undefined || pendingValue === undefined
      || sourceValue === undefined
      || finishValue === undefined || evidenceValue === undefined || bindingValue === undefined
    ) {
      failures.push(`RFC capability row ${store} could not be read: ${line}`);
      continue;
    }
    rows.push({
      store,
      consumable: consumableValue,
      durable: durableValue,
      subscription: subscriptionValue,
      availablePurchases: sourceValue,
      pending: pendingValue,
      finish: finishValue,
      evidence: evidenceValue,
      accountBinding: bindingValue,
    });
  }
  return { rows, failures };
}

/** Drift between one provider's declared block and its RFC profile row. */
export function compareCapabilityBlockToRfcRow(
  label: string,
  row: RfcCapabilityRow,
  block: CommerceCapabilities,
): string[] {
  const failures: string[] = [];
  const expect = (field: string, declared: unknown, rfc: unknown): void => {
    if (declared !== rfc) {
      failures.push(
        `${label}: capability ${field} is ${String(declared)} but the RFC profile row for `
          + `${row.store} says ${String(rfc)}.`,
      );
    }
  };
  expect('purchase.consumable', block.purchase.consumable, row.consumable);
  expect('purchase.durable', block.purchase.durable, row.durable);
  if (row.subscription !== 'conditional') {
    expect('purchase.subscription', block.purchase.subscription, row.subscription);
  }
  expect(
    'lifecycle.availablePurchases',
    block.lifecycle.availablePurchases,
    row.availablePurchases,
  );
  expect('lifecycle.pending', block.lifecycle.pending, row.pending);
  expect('lifecycle.finish', block.lifecycle.finish, row.finish);
  expect('authority.evidence', block.authority.evidence, row.evidence);
  expect('authority.accountBinding', block.authority.accountBinding, row.accountBinding);
  return failures;
}

function removedMethodPattern(): RegExp {
  return new RegExp(`['"](?:${removedV1CommerceMethods.map(escapeRegExp).join('|')})['"]`, 'gu');
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function upperFirst(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function stripTicks(cell: string): string {
  return cell.replaceAll('`', '');
}

function firstTick(cell: string): string | undefined {
  return /`([^`]+)`/u.exec(cell)?.[1];
}
