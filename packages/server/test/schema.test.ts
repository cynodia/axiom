import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  BUILTIN_FUNCTIONS,
  EXPRESSION_KINDS,
  OPERATION_KINDS,
  SERVER_IR_CONTRACTS,
  SERVER_IR_V2_EXPRESSION_KINDS,
  SERVER_IR_V5_OPERATION_KINDS,
} from '@cynodia/axiom-core';
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

/** One schema per contract, keyed by the contract a document declares. */
const irSchemas = new Map<string, Schema>(
  await Promise.all(
    SERVER_IR_CONTRACTS.map(
      async (contract) =>
        [
          contract,
          JSON.parse(
            await readFile(
              path.join(schemaDir, `server-ir.${contract.slice(contract.lastIndexOf('.') + 1)}.schema.json`),
              'utf8',
            ),
          ) as Schema,
        ] as const,
    ),
  ),
);
const irSchema = irSchemas.get('axiom.server.v1') as Schema;
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
    // Against the schema for the contract the document itself declares.
    const schema = irSchemas.get(String(fixture.serverIR.contract)) as Schema;
    assert.ok(schema, `${file} declares a contract this repository publishes a schema for`);
    const problems = validate(schema, fixture.serverIR, schema, file);
    assert.deepEqual(problems, [], `${file} conforms to the Server IR schema`);
  }
});

test('the schema names exactly the vocabulary the runtime implements', () => {
  const defs = irSchema.$defs as Record<string, Schema>;
  const kindsOf = (schema: Schema): unknown[] =>
    ((schema.$defs as Record<string, Schema>).Expression.oneOf as Schema[]).map(
      (branch) => ((branch.properties as Record<string, Schema>).kind as Schema).const,
    );
  const operationKindsOf = (schema: Schema): unknown[] => {
    const schemaDefs = schema.$defs as Record<string, Schema>;
    return (schemaDefs.Operation.oneOf as Schema[]).flatMap((branch) =>
      branch.$ref
        ? (schemaDefs.MutationOperation.oneOf as Schema[]).map(
            (mutation) => ((mutation.properties as Record<string, Schema>).kind as Schema).const,
          )
        : [((branch.properties as Record<string, Schema>).kind as Schema).const],
    );
  };
  // 0.8's integration operation kinds are v3-only, exactly as 0.7's expression kinds are
  // v2-only — declared once here rather than re-deriving from the schema itself.
  const V3_OPERATION_KINDS = ['integration-query', 'integration-effect'];

  // The newest contract carries the whole vocabulary...
  const latestContract = SERVER_IR_CONTRACTS[SERVER_IR_CONTRACTS.length - 1] as string;
  const latest = irSchemas.get(latestContract) as Schema;
  assert.deepEqual(
    [...kindsOf(latest)].sort(),
    [...EXPRESSION_KINDS].sort(),
    'every expression kind, and no others',
  );
  assert.deepEqual(
    [...operationKindsOf(latest)].sort(),
    [...OPERATION_KINDS].sort(),
    'every operation kind, and no others',
  );
  // ...and the frozen one carries exactly what it carried when it was frozen.
  assert.deepEqual(
    [...kindsOf(irSchema)].sort(),
    [...EXPRESSION_KINDS].filter((kind) => !SERVER_IR_V2_EXPRESSION_KINDS.includes(kind)).sort(),
    'axiom.server.v1 gained no expression vocabulary',
  );
  assert.deepEqual(
    [...operationKindsOf(irSchema)].sort(),
    [...OPERATION_KINDS]
      .filter((kind) => !V3_OPERATION_KINDS.includes(kind))
      .filter((kind) => !SERVER_IR_V5_OPERATION_KINDS.includes(kind))
      .sort(),
    'axiom.server.v1 gained no operation vocabulary',
  );

  const call = (defs.Expression.oneOf as Schema[]).find(
    (branch) => ((branch.properties as Record<string, Schema>).kind as Schema).const === 'call',
  );
  const functions = ((call?.properties as Record<string, Schema>).function as Schema).enum as string[];
  assert.deepEqual([...functions].sort(), [...BUILTIN_FUNCTIONS].sort());

  for (const [contract, schema] of irSchemas) {
    assert.equal(schema.contract, contract, 'each schema names the contract it describes');
  }
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
