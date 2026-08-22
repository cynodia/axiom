import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BUILTIN_FUNCTIONS, EXPRESSION_KINDS, OPERATION_KINDS, SERVER_IR_CONTRACT } from '@cynodia/axiom-core';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryPersistence,
} from '@cynodia/axiom-server';
import type { PersistedState, ServerIR, ServerRequest } from '@cynodia/axiom-server';

/**
 * The machine-readable contracts.
 *
 * A `.d.ts` describes the Server IR to a TypeScript compiler and to nobody else. These
 * schemas are the same information as data, for an implementer working in another language
 * — so they are only worth shipping if they are true, which is what this checks: every
 * fixture that the reference runtime executes must validate against them.
 */

// ------------------------------------------------------- a JSON Schema subset

type Schema = Record<string, unknown>;

/**
 * Enough of JSON Schema 2020-12 to check these two documents: types, enums, consts, objects,
 * arrays, local `$ref` and `oneOf`/`anyOf`. Deliberately not a general validator — a
 * dependency-free check of our own schemas is the point.
 */
function validate(schema: Schema, value: unknown, root: Schema, at = '$'): string[] {
  if (typeof schema.$ref === 'string') {
    const target = (schema.$ref as string).replace('#/$defs/', '');
    const defs = root.$defs as Record<string, Schema>;
    assert.ok(defs[target], `${schema.$ref} is defined`);
    return validate(defs[target], value, root, at);
  }
  if ('const' in schema) {
    return value === schema.const ? [] : [`${at}: expected ${JSON.stringify(schema.const)}`];
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(value) ? [] : [`${at}: ${JSON.stringify(value)} is not one of the permitted values`];
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const branches = (schema.oneOf ?? schema.anyOf) as Schema[];
    const failures = branches.map((branch) => validate(branch, value, root, at));
    return failures.some((problems) => problems.length === 0)
      ? []
      : [`${at}: matched no permitted shape (${failures.flat().slice(0, 3).join('; ')})`];
  }

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual =
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number'
      ? Number.isInteger(value) ? 'integer' : 'number'
      : typeof value;
  if (types.length > 0 && !types.includes(actual) && !(types.includes('number') && actual === 'integer')) {
    return [`${at}: expected ${types.join('|')}, found ${actual}`];
  }

  const problems: string[] = [];
  if (actual === 'array' && schema.items) {
    (value as unknown[]).forEach((item, index) => {
      problems.push(...validate(schema.items as Schema, item, root, `${at}[${index}]`));
    });
  }
  if (actual === 'object') {
    const record = value as Record<string, unknown>;
    for (const required of (schema.required as string[]) ?? []) {
      if (!(required in record)) {
        problems.push(`${at}: missing required property "${required}"`);
      }
    }
    const properties = (schema.properties as Record<string, Schema>) ?? {};
    for (const [key, entry] of Object.entries(record)) {
      if (entry === undefined) {
        problems.push(`${at}.${key}: undefined is not portable JSON`);
        continue;
      }
      if (properties[key]) {
        problems.push(...validate(properties[key], entry, root, `${at}.${key}`));
      } else if (schema.additionalProperties === false) {
        problems.push(`${at}: unexpected property "${key}"`);
      } else if (typeof schema.additionalProperties === 'object') {
        problems.push(...validate(schema.additionalProperties as Schema, entry, root, `${at}.${key}`));
      }
    }
  }
  return problems;
}

const here = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const schemaDir = path.join(here, '../schema');
const conformanceDir = path.join(here, '../conformance');

const irSchema = JSON.parse(await readFile(path.join(schemaDir, 'server-ir.v1.schema.json'), 'utf8')) as Schema;
const protocolSchema = JSON.parse(await readFile(path.join(schemaDir, 'protocol.v1.schema.json'), 'utf8')) as Schema;
const fixtureFiles = (await readdir(conformanceDir))
  .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
  .sort();

// ------------------------------------------------------------------- the IR

test('the Server IR schema describes the IR the compiler actually emits', async () => {
  for (const file of fixtureFiles) {
    const fixture = JSON.parse(await readFile(path.join(conformanceDir, file), 'utf8')) as {
      serverIR: ServerIR;
    };
    const problems = validate(irSchema, fixture.serverIR, irSchema, file);
    assert.deepEqual(problems, [], `${file} conforms to the Server IR schema`);
  }
});

test('the schema names exactly the vocabulary the runtime implements', () => {
  const defs = irSchema.$defs as Record<string, Schema>;
  const kinds = (defs.Expression.oneOf as Schema[]).map(
    (branch) => ((branch.properties as Record<string, Schema>).kind as Schema).const,
  );
  assert.deepEqual([...kinds].sort(), [...EXPRESSION_KINDS].sort(), 'every expression kind, and no others');

  const call = (defs.Expression.oneOf as Schema[]).find(
    (branch) => ((branch.properties as Record<string, Schema>).kind as Schema).const === 'call',
  );
  const functions = ((call?.properties as Record<string, Schema>).function as Schema).enum as string[];
  assert.deepEqual([...functions].sort(), [...BUILTIN_FUNCTIONS].sort());

  const operations = (defs.Operation.oneOf as Schema[]).flatMap((branch) =>
    branch.$ref
      ? (defs.MutationOperation.oneOf as Schema[]).map(
          (mutation) => ((mutation.properties as Record<string, Schema>).kind as Schema).const,
        )
      : [((branch.properties as Record<string, Schema>).kind as Schema).const],
  );
  assert.deepEqual([...operations].sort(), [...OPERATION_KINDS].sort());
  assert.equal(irSchema.contract, SERVER_IR_CONTRACT);
});

// ------------------------------------------------------------- the protocol

test('the protocol schema describes the messages the authority actually exchanges', async () => {
  const fixture = JSON.parse(
    await readFile(path.join(conformanceDir, 'mutation-commits.json'), 'utf8'),
  ) as {
    serverIR: ServerIR;
    initialState: PersistedState[];
    invocations: { actionId: string; arguments: Record<string, unknown> }[];
  };
  const server = createAxiomServer({
    ir: fixture.serverIR,
    persistence: createMemoryPersistence(fixture.initialState),
    host: createDeterministicServerHost({}),
  });
  await server.start();

  const exchanges: unknown[] = [];
  const requests: ServerRequest[] = [
    { kind: 'snapshot', protocol: PROTOCOL_VERSION },
    { kind: 'snapshot', protocol: PROTOCOL_VERSION, sinceRevision: 0 },
    {
      kind: 'invoke',
      protocol: PROTOCOL_VERSION,
      actionId: fixture.invocations[0].actionId as never,
      arguments: fixture.invocations[0].arguments,
      requestId: 'r-1',
    },
    // A refusal is a protocol message too, and its shape is part of the contract.
    { kind: 'invoke', protocol: PROTOCOL_VERSION, actionId: 'action_absent' as never },
  ];
  for (const request of requests) {
    exchanges.push(request, await server.handle(request));
  }

  for (const [index, message] of exchanges.entries()) {
    assert.deepEqual(
      validate(protocolSchema, message, protocolSchema, `message ${index}`),
      [],
      `message ${index} (${JSON.stringify(message).slice(0, 120)}) conforms`,
    );
  }
});

test('the schemas are shipped and addressable', async () => {
  const manifest = JSON.parse(await readFile(path.join(here, '../package.json'), 'utf8')) as {
    files: string[];
    exports: Record<string, unknown>;
  };
  assert.ok(manifest.files.includes('schema/*.json'), 'the schemas are packed');
  assert.equal(manifest.exports['./schema/*'], './schema/*', 'and reachable from outside');
});
