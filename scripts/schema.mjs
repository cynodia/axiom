import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, version } from './packages.mjs';

/**
 * Writes the machine-readable contracts.
 *
 * A `.d.ts` file describes the Server IR to a TypeScript compiler and to nobody else. An
 * implementation in another language needs the same information as data, which is what
 * these are: JSON Schema for the Server IR and for the wire protocol, generated so the
 * vocabulary in them cannot drift from the vocabulary the runtime actually implements.
 */
const core = await import(path.join(repoRoot, 'packages/core/dist/index.js'));
const { BUILTIN_FUNCTIONS, EXPRESSION_KINDS, OPERATION_KINDS, SERVER_IR_CONTRACT } = core;

const BINARY_OPERATORS = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'and', 'or', 'add', 'subtract', 'multiply', 'divide',
];
const UNARY_OPERATORS = ['not', 'negate'];
const PRIMITIVE_KINDS = ['string', 'number', 'boolean', 'date', 'datetime', 'binary'];

/** An id is an opaque string. Nothing in the contract may parse one. */
const id = { type: 'string', minLength: 1 };
const ref = (name) => ({ $ref: `#/$defs/${name}` });

const object = (properties, required = [], extra = {}) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
  ...extra,
});

/** A discriminated union member: `kind` plus its own fields. */
const variant = (kind, properties, required = []) =>
  object({ kind: { const: kind }, ...properties }, ['kind', ...required]);

const expression = ref('Expression');
const location = ref('Location');

const serverIR = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://cynodia.github.io/axiom/schema/server-ir.v1.schema.json',
  title: 'Axiom Server IR v1',
  description:
    'The normative structure of an `axiom.server.v1` document. Structure only: what a ' +
    'conforming runtime must *do* with it is the semantic contract, and the conformance ' +
    'fixtures are the executable statement of that.',
  contract: SERVER_IR_CONTRACT,
  release: version,
  type: 'object',
  required: [
    'contract', 'id', 'name', 'version', 'entities', 'fields', 'states', 'actions',
    'constraints', 'transitionConstraints', 'observableStateIds',
  ],
  additionalProperties: false,
  properties: {
    contract: { const: SERVER_IR_CONTRACT },
    id: { type: 'string' },
    name: { type: 'string' },
    version: { type: 'string' },
    entities: { type: 'array', items: ref('EntityDef') },
    fields: { type: 'object', additionalProperties: ref('FieldIndexEntry') },
    states: { type: 'array', items: ref('StateDef') },
    actions: { type: 'object', additionalProperties: ref('ActionDef') },
    constraints: { type: 'array', items: ref('ConstraintDef') },
    transitionConstraints: { type: 'array', items: ref('TransitionConstraintDef') },
    principalEntityId: id,
    observableStateIds: { type: 'array', items: id },
  },
  $defs: {
    NodeId: id,
    FieldId: id,

    LiteralValue: {
      description: 'Portable data. No undefined, NaN, Infinity, date object or class instance.',
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'null' },
        { type: 'array', items: ref('LiteralValue') },
        { type: 'object', additionalProperties: ref('LiteralValue') },
      ],
    },

    TypeRef: {
      oneOf: [
        variant('primitive', { primitive: { enum: PRIMITIVE_KINDS } }, ['primitive']),
        variant('entity', { entityId: id }, ['entityId']),
        variant('collection', { itemType: ref('TypeRef') }, ['itemType']),
        variant('optional', { valueType: ref('TypeRef') }, ['valueType']),
        variant('enum', { values: { type: 'array', items: { type: 'string' } } }, ['values']),
      ],
    },

    Expression: {
      description: `Every expression kind: ${EXPRESSION_KINDS.join(', ')}.`,
      oneOf: [
        variant('literal', { value: ref('LiteralValue') }, ['value']),
        variant('ref', { targetId: id }, ['targetId']),
        variant('field', { source: expression, fieldId: id }, ['source', 'fieldId']),
        variant('object', { entityId: id, entries: { type: 'array', items: ref('ObjectEntry') } }, ['entries']),
        variant('binary', { operator: { enum: BINARY_OPERATORS }, left: expression, right: expression }, ['operator', 'left', 'right']),
        variant('unary', { operator: { enum: UNARY_OPERATORS }, operand: expression }, ['operator', 'operand']),
        variant('call', { function: { enum: [...BUILTIN_FUNCTIONS] }, arguments: { type: 'array', items: expression } }, ['function', 'arguments']),
        variant('filter', { source: expression, scopeId: id, predicate: expression }, ['source', 'scopeId', 'predicate']),
        variant('find', { source: expression, scopeId: id, predicate: expression }, ['source', 'scopeId', 'predicate']),
        variant('map', { source: expression, scopeId: id, projection: expression }, ['source', 'scopeId', 'projection']),
        variant('sort', { source: expression, scopeId: id, by: expression, direction: { enum: ['asc', 'desc'] } }, ['source', 'scopeId', 'by']),
        variant('every', { source: expression, scopeId: id, predicate: expression }, ['source', 'scopeId', 'predicate']),
        variant('some', { source: expression, scopeId: id, predicate: expression }, ['source', 'scopeId', 'predicate']),
        variant('flatten', { source: expression }, ['source']),
        variant('conditional', { condition: expression, whenTrue: expression, whenFalse: expression }, ['condition', 'whenTrue', 'whenFalse']),
      ],
    },
    ObjectEntry: object({ fieldId: id, value: expression }, ['fieldId', 'value']),

    Location: {
      oneOf: [
        variant('state', { stateId: id }, ['stateId']),
        variant('field', { target: location, fieldId: id }, ['target', 'fieldId']),
        variant('collection-item', { collection: location, selector: ref('CollectionSelector') }, ['collection', 'selector']),
      ],
    },
    CollectionItemLocation: variant(
      'collection-item',
      { collection: location, selector: ref('CollectionSelector') },
      ['collection', 'selector'],
    ),
    CollectionSelector: {
      oneOf: [
        variant('identity', { fieldId: id, value: expression }, ['fieldId', 'value']),
        variant('index', { index: expression }, ['index']),
      ],
    },

    FieldDef: object(
      {
        id,
        name: { type: 'string' },
        valueType: ref('TypeRef'),
        required: { type: 'boolean' },
        defaultValue: ref('LiteralValue'),
        metadata: { type: 'object' },
      },
      ['id', 'valueType'],
    ),
    FieldIndexEntry: object({ entityId: id, field: ref('FieldDef') }, ['entityId', 'field']),

    EntityDef: object(
      {
        id,
        kind: { const: 'entity' },
        name: { type: 'string' },
        metadata: { type: 'object' },
        fields: { type: 'array', items: ref('FieldDef') },
        identityFieldId: id,
      },
      ['id', 'kind', 'fields'],
    ),

    StateDef: object(
      {
        id,
        kind: { const: 'state' },
        name: { type: 'string' },
        metadata: { type: 'object' },
        valueType: ref('TypeRef'),
        initialValue: ref('LiteralValue'),
        derivation: expression,
        draft: { type: 'boolean' },
        ephemeral: { type: 'boolean' },
        authority: { enum: ['client', 'server'] },
        serverOnly: { type: 'boolean' },
        persistence: {
          oneOf: [
            variant('memory', {}),
            variant('local-storage', { key: { type: 'string' } }),
            variant('remote', { sourceId: id }, ['sourceId']),
          ],
        },
      },
      ['id', 'kind', 'valueType'],
    ),

    FailureMode: object({ code: { type: 'string' }, message: { type: 'string' } }, ['code']),
    ActionGuard: object({ condition: expression, failureMode: ref('FailureMode') }, ['condition']),
    ActionParameter: object(
      { id, name: { type: 'string' }, valueType: ref('TypeRef'), required: { type: 'boolean' } },
      ['id'],
    ),

    Operation: {
      description: `Every operation kind: ${OPERATION_KINDS.join(', ')}.`,
      oneOf: [
        ref('MutationOperation'),
        variant('for-each', { collection: expression, scopeId: id, operations: { type: 'array', items: ref('MutationOperation') } }, ['collection', 'scopeId', 'operations']),
        variant('invoke', { actionId: id, arguments: { type: 'object', additionalProperties: expression } }, ['actionId']),
        variant('navigate', { routeId: id, path: { type: 'string' }, parameters: { type: 'object', additionalProperties: expression } }),
        variant('native', {
          implementationId: { type: 'string' },
          inputs: { type: 'object', additionalProperties: expression },
          resultTarget: location,
          declaredEffects: { type: 'array', items: { type: 'object' } },
        }, ['implementationId']),
      ],
    },
    MutationOperation: {
      oneOf: [
        variant('set', { target: location, value: expression }, ['target', 'value']),
        variant('insert', { target: location, value: expression, position: { enum: ['start', 'end'] } }, ['target', 'value']),
        variant('remove', { target: ref('CollectionItemLocation') }, ['target']),
      ],
    },

    ActionDef: object(
      {
        id,
        kind: { const: 'action' },
        name: { type: 'string' },
        metadata: { type: 'object' },
        parameters: { type: 'array', items: ref('ActionParameter') },
        guards: { type: 'array', items: ref('ActionGuard') },
        preconditions: { type: 'array', items: expression },
        operations: { type: 'array', items: ref('Operation') },
        postconditions: { type: 'array', items: expression },
        failureModes: { type: 'array', items: ref('FailureMode') },
        destructive: { type: 'boolean' },
        requiresConfirmation: { type: 'boolean' },
        confirmationMessage: { type: 'string' },
        authorization: expression,
        confirmation: { type: 'object' },
      },
      ['id', 'kind', 'operations'],
    ),

    ConstraintDef: object(
      {
        id,
        kind: { const: 'constraint' },
        name: { type: 'string' },
        metadata: { type: 'object' },
        expression,
        entityId: id,
        severity: { enum: ['error', 'warning'] },
        message: { type: 'string' },
      },
      ['id', 'kind', 'expression'],
    ),

    TransitionConstraintDef: object(
      {
        id,
        kind: { const: 'transition-constraint' },
        name: { type: 'string' },
        metadata: { type: 'object' },
        entityId: id,
        previousScopeId: id,
        proposedScopeId: id,
        expression,
        severity: { enum: ['error', 'warning'] },
        message: { type: 'string' },
      },
      ['id', 'kind', 'entityId', 'previousScopeId', 'proposedScopeId', 'expression'],
    ),
  },
};

const PROTOCOL_VERSION = 'axiom.protocol.v1';

const diagnostic = object(
  {
    code: { type: 'string' },
    message: { type: 'string' },
    severity: { enum: ['error', 'warning', 'info'] },
    nodeId: id,
    actionId: id,
    constraintId: id,
    stateId: id,
    transactionId: { type: 'string' },
    details: { type: 'object' },
  },
  ['code', 'message', 'severity'],
);

const protocol = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://cynodia.github.io/axiom/schema/protocol.v1.schema.json',
  title: 'Axiom semantic protocol v1',
  description:
    'What a client may send an authority and what it may receive back. A client requests ' +
    'semantic operations — "invoke action X with arguments Y" — never a mutation program. ' +
    'Nothing here mentions a transport.',
  contract: PROTOCOL_VERSION,
  release: version,
  oneOf: [ref('ServerRequest'), ref('ServerResponse')],
  $defs: {
    NodeId: id,
    RuntimeDiagnostic: diagnostic,
    Credential: { type: ['string', 'null'] },

    ServerRequest: { oneOf: [ref('SnapshotRequest'), ref('InvokeRequest')] },
    SnapshotRequest: object(
      {
        kind: { const: 'snapshot' },
        protocol: { const: PROTOCOL_VERSION },
        credential: ref('Credential'),
        sinceRevision: { type: 'integer', minimum: 0 },
      },
      ['kind', 'protocol'],
    ),
    InvokeRequest: object(
      {
        kind: { const: 'invoke' },
        protocol: { const: PROTOCOL_VERSION },
        actionId: id,
        arguments: { type: 'object' },
        credential: ref('Credential'),
        requestId: { type: 'string' },
      },
      ['kind', 'protocol', 'actionId'],
    ),

    ServerResponse: { oneOf: [ref('SnapshotResponse'), ref('InvokeResponse'), ref('ErrorResponse')] },
    StateSnapshot: object(
      {
        revision: { type: 'integer', minimum: 0 },
        states: { type: 'object' },
        partial: { type: 'boolean' },
      },
      ['revision', 'states'],
    ),
    SnapshotResponse: object(
      {
        kind: { const: 'snapshot' },
        protocol: { const: PROTOCOL_VERSION },
        snapshot: ref('StateSnapshot'),
      },
      ['kind', 'protocol', 'snapshot'],
    ),
    InvokeResponse: object(
      {
        kind: { const: 'result' },
        protocol: { const: PROTOCOL_VERSION },
        ok: { type: 'boolean' },
        diagnostics: { type: 'array', items: diagnostic },
        changes: {
          type: 'object',
          description:
            'Every observable state whose value differs from what it was when the ' +
            'transaction opened. Empty for a refused or a no-op invocation.',
        },
        revision: { type: 'integer', minimum: 0 },
        requestId: { type: 'string' },
        replayed: { type: 'boolean' },
      },
      ['kind', 'protocol', 'ok', 'diagnostics', 'changes', 'revision'],
    ),
    ErrorResponse: object(
      {
        kind: { const: 'error' },
        protocol: { const: PROTOCOL_VERSION },
        diagnostics: { type: 'array', items: diagnostic },
      },
      ['kind', 'protocol', 'diagnostics'],
    ),
  },
};

const directory = path.join(repoRoot, 'packages/server/schema');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'server-ir.v1.schema.json'), `${JSON.stringify(serverIR, null, 2)}\n`);
await writeFile(path.join(directory, 'protocol.v1.schema.json'), `${JSON.stringify(protocol, null, 2)}\n`);
console.log('Wrote server-ir.v1.schema.json and protocol.v1.schema.json');
