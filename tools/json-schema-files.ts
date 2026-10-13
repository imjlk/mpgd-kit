import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shared rendering for the committed protocol JSON Schemas (commerce v2,
 * notifications v2). The output depends only on the typia collection and the
 * inputs, so an alignment validator can compare it byte for byte with the
 * committed files.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

/** What `typia.json.schemas<[...]>()` returns, narrowed to the parts the files use. */
export interface JsonSchemaCollection {
  readonly schemas: readonly JsonValue[];
  readonly components: { readonly schemas?: Readonly<Record<string, JsonValue>> };
}

export interface JsonSchemaFile {
  readonly fileName: string;
  readonly content: string;
}

export interface RenderJsonSchemaFilesInput {
  /** Lower-case protocol family for messages, for example `commerce`. */
  readonly label: string;
  /** Schema titles, in the order of the typia collection. */
  readonly names: readonly string[];
  readonly collection: JsonSchemaCollection;
  /** Repository-relative directory, used in each schema's `$id`. */
  readonly directory: string;
  readonly indexFile: string;
  readonly protocol: string;
  readonly protocolVersion: string;
  /** The command that rewrites the files. */
  readonly regenerate: string;
}

/** One file per named schema, each carrying only the components it references, plus an index. */
export function renderJsonSchemaFiles(input: RenderJsonSchemaFilesInput): readonly JsonSchemaFile[] {
  const components = input.collection.components.schemas ?? {};
  if (input.collection.schemas.length !== input.names.length) {
    throw new Error(`typia produced an unexpected number of ${input.label} schemas.`);
  }

  const files = input.names.map((name, index) => {
    const schema = input.collection.schemas[index];
    if (schema === undefined) {
      throw new Error(`Missing ${input.label} schema for ${name}.`);
    }
    const fileName = `${toKebabCase(name)}.schema.json`;
    const referenced = collectReferencedComponents(schema, components, input.label);
    const document = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `https://github.com/imjlk/mpgd-kit/${input.directory}/${fileName}`,
      title: name,
      'x-mpgd-protocol': input.protocol,
      'x-mpgd-protocol-version': input.protocolVersion,
      ...(typeof schema === 'object' && schema !== null && !Array.isArray(schema) ? schema : {}),
      ...(Object.keys(referenced).length === 0 ? {} : { components: { schemas: referenced } }),
    };
    return { fileName, content: `${JSON.stringify(document, null, 2)}\n` };
  });

  const index = {
    protocol: input.protocol,
    protocolVersion: input.protocolVersion,
    regenerate: input.regenerate,
    schemas: files.map((file, position) => ({
      title: input.names[position],
      file: file.fileName,
    })),
  };
  return [{ fileName: input.indexFile, content: `${JSON.stringify(index, null, 2)}\n` }, ...files];
}

/** Writes `files` into `directory` and removes stale `.json` files there. */
export function writeJsonSchemaFiles(
  directory: string,
  files: readonly JsonSchemaFile[],
): readonly string[] {
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
  label: string,
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
          throw new Error(
            `${label.charAt(0).toUpperCase()}${label.slice(1)} schema references unknown component ${nested}.`,
          );
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
