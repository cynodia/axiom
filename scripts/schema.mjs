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
const {
  BUILTIN_FUNCTIONS,
  SERVER_IR_V7_BUILTIN_FUNCTIONS,
  EXPRESSION_KINDS,
  OPERATION_KINDS,
  SERVER_IR_CONTRACTS,
  SERVER_IR_V2_EXPRESSION_KINDS,
  SERVER_IR_V5_OPERATION_KINDS,
  SERVER_IR_V6_OPERATION_KINDS,
  MIGRATION_OPERATION_KINDS,
  MIGRATION_REVERSIBILITIES,
  SUBSCRIPTION_BACKPRESSURE_POLICIES,
  SUBSCRIPTION_FAILURE_POLICIES,
} = core;

const QUERY_SORT_DIRECTIONS = ['asc', 'desc'];
const QUERY_NULLS_ORDERS = ['first', 'last'];
const QUERY_PAGINATION_STRATEGIES = ['cursor', 'offset'];
const QUERY_AGGREGATE_FUNCTIONS = ['count', 'sum', 'min', 'max', 'average'];
const RELATIONSHIP_CARDINALITIES = ['to-one', 'to-many'];

/** Operation kinds `axiom.server.v1`/`v2` do not contain — integrations are 0.8/v3 vocabulary. */
const SERVER_IR_V3_OPERATION_KINDS = ['integration-query', 'integration-effect'];

const BINARY_OPERATORS = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'and', 'or', 'add', 'subtract', 'multiply', 'divide',
];
const UNARY_OPERATORS = ['not', 'negate'];
const PRIMITIVE_KINDS = ['string', 'number', 'boolean', 'date', 'datetime', 'binary'];

/** Whether `contract` carries at least `min`'s vocabulary, by `SERVER_IR_CONTRACTS` order. */
function atLeast(contract, min) {
  return SERVER_IR_CONTRACTS.indexOf(contract) >= SERVER_IR_CONTRACTS.indexOf(min);
}

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

/**
 * One schema per contract.
 *
 * `axiom.server.v1` is frozen, so its vocabulary is frozen with it: the two expression kinds
 * 0.7 adds are absent from the v1 schema and present in the v2 schema, and a document that
 * uses them declares v2. That is what keeps "frozen" a statement about documents and not
 * only about prose.
 */
const buildServerIR = (contract) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `https://cynodia.github.io/axiom/schema/server-ir.${short(contract)}.schema.json`,
  title: `Axiom Server IR ${short(contract)}`,
  description:
    `The normative structure of an \`${contract}\` document. Structure only: what a ` +
    'conforming runtime must *do* with it is the semantic contract, and the conformance ' +
    'fixtures are the executable statement of that.',
  contract,
  release: version,
  type: 'object',
  required: [
    'contract', 'id', 'name', 'version', 'entities', 'fields', 'states', 'actions',
    'constraints', 'transitionConstraints', 'observableStateIds',
  ],
  additionalProperties: false,
  properties: {
    contract: { const: contract },
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
    ...(contract === 'axiom.server.v1'
      ? {}
      : { expressionDefs: { type: 'object', additionalProperties: ref('ExpressionDef') } }),
    ...(atLeast(contract, 'axiom.server.v3')
      ? {
          integrations: { type: 'array', items: ref('IntegrationDef') },
          integrationOperations: { type: 'object', additionalProperties: ref('IntegrationOperationDef') },
          events: { type: 'array', items: ref('EventDef') },
          triggers: { type: 'array', items: ref('TriggerDef') },
        }
      : {}),
    ...(atLeast(contract, 'axiom.server.v5')
      ? {
          subscriptions: { type: 'array', items: ref('SubscriptionDef') },
          storages: { type: 'array', items: ref('StorageDef') },
        }
      : {}),
    ...(atLeast(contract, 'axiom.server.v6')
      ? {
          queries: { type: 'array', items: ref('QueryDef') },
          relationships: { type: 'array', items: ref('RelationshipDef') },
          readPolicies: { type: 'array', items: ref('ReadPolicyDef') },
        }
      : {}),
    ...(atLeast(contract, 'axiom.server.v7')
      ? {
          schemaVersion: { type: 'integer', minimum: 1 },
          schemaFingerprint: { type: 'string' },
          migrations: { type: 'array', items: ref('MigrationDef') },
        }
      : {}),
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
        ...(contract === 'axiom.server.v1'
          ? []
          : [variant('group', { keyType: ref('TypeRef'), itemType: ref('TypeRef') }, ['keyType', 'itemType'])]),
      ],
    },

    Expression: {
      description: `Every expression kind: ${expressionKindsFor(contract).join(', ')}.`,
      oneOf: [
        variant('literal', { value: ref('LiteralValue') }, ['value']),
        variant('ref', { targetId: id }, ['targetId']),
        variant('field', { source: expression, fieldId: id }, ['source', 'fieldId']),
        variant('object', { entityId: id, entries: { type: 'array', items: ref('ObjectEntry') } }, ['entries']),
        variant('binary', { operator: { enum: BINARY_OPERATORS }, left: expression, right: expression }, ['operator', 'left', 'right']),
        variant('unary', { operator: { enum: UNARY_OPERATORS }, operand: expression }, ['operator', 'operand']),
        variant('call', { function: { enum: builtinFunctionsFor(contract) }, arguments: { type: 'array', items: expression } }, ['function', 'arguments']),
        variant('filter', { source: expression, scopeId: id, predicate: expression }, ['source', 'scopeId', 'predicate']),
        variant('find', { source: expression, scopeId: id, predicate: expression }, ['source', 'scopeId', 'predicate']),
        variant('map', { source: expression, scopeId: id, projection: expression }, ['source', 'scopeId', 'projection']),
        variant('sort', { source: expression, scopeId: id, by: expression, direction: { enum: ['asc', 'desc'] } }, ['source', 'scopeId', 'by']),
        variant('every', { source: expression, scopeId: id, predicate: expression }, ['source', 'scopeId', 'predicate']),
        variant('some', { source: expression, scopeId: id, predicate: expression }, ['source', 'scopeId', 'predicate']),
        variant('flatten', { source: expression }, ['source']),
        variant('conditional', { condition: expression, whenTrue: expression, whenFalse: expression }, ['condition', 'whenTrue', 'whenFalse']),
        ...(contract === 'axiom.server.v1'
          ? []
          : [
              variant('group', { source: expression, scopeId: id, by: expression }, ['source', 'scopeId', 'by']),
              variant('expression-ref', { expressionId: id, arguments: { type: 'object', additionalProperties: expression } }, ['expressionId']),
            ]),
      ],
    },
    ObjectEntry: object({ fieldId: id, value: expression }, ['fieldId', 'value']),

    Location: {
      oneOf: [
        variant('state', { stateId: id }, ['stateId']),
        variant('field', { target: location, fieldId: id }, ['target', 'fieldId']),
        variant('collection-item', { collection: location, selector: ref('CollectionSelector') }, ['collection', 'selector']),
        ...(atLeast(contract, 'axiom.server.v6') ? [ref('ProviderRecordLocation')] : []),
      ],
    },
    CollectionItemLocation: variant(
      'collection-item',
      { collection: location, selector: ref('CollectionSelector') },
      ['collection', 'selector'],
    ),
    ...(atLeast(contract, 'axiom.server.v6')
      ? {
          ProviderRecordLocation: variant(
            'provider-record',
            { sourceEntityId: id, identityFieldId: id, identityValue: expression },
            ['sourceEntityId', 'identityFieldId', 'identityValue'],
          ),
        }
      : {}),
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
      description: `Every operation kind: ${operationKindsFor(contract).join(', ')}.`,
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
        ...(!atLeast(contract, 'axiom.server.v5')
          ? []
          : [
              variant('blob-metadata', { storageId: id, blobKey: expression, bindAs: id }, [
                'storageId', 'blobKey', 'bindAs',
              ]),
              variant('blob-commit', {
                storageId: id,
                blobKey: expression,
                succeededEventId: id,
                failedEventId: id,
              }, ['storageId', 'blobKey']),
              variant('blob-delete', {
                storageId: id,
                blobKey: expression,
                succeededEventId: id,
                failedEventId: id,
              }, ['storageId', 'blobKey']),
            ]),
        ...(atLeast(contract, 'axiom.server.v3')
          ? [
              variant('integration-query', {
                operationId: id,
                arguments: { type: 'object', additionalProperties: expression },
                bindAs: id,
                timeoutMs: { type: 'number' },
              }, ['operationId', 'bindAs']),
              variant('integration-effect', {
                operationId: id,
                arguments: { type: 'object', additionalProperties: expression },
                idempotencyKey: expression,
                succeededEventId: id,
                failedEventId: id,
              }, ['operationId']),
            ]
          : []),
        ...(atLeast(contract, 'axiom.server.v6')
          ? [
              variant('query', {
                queryId: id,
                arguments: { type: 'object', additionalProperties: expression },
                bindAs: id,
              }, ['queryId', 'bindAs']),
            ]
          : []),
      ],
    },
    MutationOperation: {
      oneOf: [
        variant('set', { target: location, value: expression }, ['target', 'value']),
        variant('insert', { target: location, value: expression, position: { enum: ['start', 'end'] } }, ['target', 'value']),
        variant('remove', {
          target: atLeast(contract, 'axiom.server.v6')
            ? { oneOf: [ref('CollectionItemLocation'), ref('ProviderRecordLocation')] }
            : ref('CollectionItemLocation'),
        }, ['target']),
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
        ...(contract === 'axiom.server.v1'
          ? {}
          : {
              invocation: object({
                allowedSources: { type: 'array', items: { enum: ['client', 'system'] } },
              }),
            }),
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

    ...(contract === 'axiom.server.v1'
      ? {}
      : {
          ExpressionParameter: object(
            { id, name: { type: 'string' }, valueType: ref('TypeRef') },
            ['id'],
          ),
          ExpressionDef: object(
            {
              id,
              kind: { const: 'expression' },
              name: { type: 'string' },
              description: { type: 'string' },
              metadata: { type: 'object' },
              parameters: { type: 'array', items: ref('ExpressionParameter') },
              expression,
              valueType: ref('TypeRef'),
            },
            ['id', 'kind', 'expression'],
          ),
        }),

    ...(!atLeast(contract, 'axiom.server.v3')
      ? {}
      : {
          IntegrationDef: object(
            { id, kind: { const: 'integration' }, name: { type: 'string' }, metadata: { type: 'object' } },
            ['id', 'kind'],
          ),
          IntegrationOperationParameter: object(
            { id, name: { type: 'string' }, valueType: ref('TypeRef'), required: { type: 'boolean' } },
            ['id', 'valueType'],
          ),
          RetryPolicy: object(
            {
              policy: { enum: ['none', 'fixed', 'exponential'] },
              maxAttempts: { type: 'number' },
              delayMs: { type: 'number' },
            },
            ['policy'],
          ),
          IntegrationOperationDef: object(
            {
              id,
              kind: { const: 'integration-operation' },
              name: { type: 'string' },
              metadata: { type: 'object' },
              integrationId: id,
              mode: { enum: ['query', 'effect'] },
              parameters: { type: 'array', items: ref('IntegrationOperationParameter') },
              resultType: ref('TypeRef'),
              clientSafe: { type: 'boolean' },
              idempotent: { type: 'boolean' },
              retry: ref('RetryPolicy'),
            },
            ['id', 'kind', 'integrationId', 'mode', 'resultType'],
          ),
          EventDef: object(
            { id, kind: { const: 'event' }, name: { type: 'string' }, metadata: { type: 'object' }, payloadType: ref('TypeRef') },
            ['id', 'kind', 'payloadType'],
          ),
          TriggerSpec: {
            oneOf: [
              variant('interval', { everyMs: { type: 'number' }, overlap: { enum: ['skip', 'queue'] } }, ['everyMs']),
              variant('delay', { afterMs: { type: 'number' } }, ['afterMs']),
              variant('lifecycle', {
                event: { enum: ['application-start', 'runtime-ready', 'route-enter', 'route-leave'] },
                routeId: id,
              }, ['event']),
              variant('event', { eventId: id }, ['eventId']),
            ],
          },
          TriggerDef: object(
            {
              id,
              kind: { const: 'trigger' },
              name: { type: 'string' },
              metadata: { type: 'object' },
              actionId: id,
              when: ref('TriggerSpec'),
              arguments: { type: 'object', additionalProperties: expression },
              enabledWhen: expression,
            },
            ['id', 'kind', 'actionId', 'when'],
          ),
        }),

    ...(!atLeast(contract, 'axiom.server.v5')
      ? {}
      : {
          SubscriptionDeliveryPolicy: object({
            maxQueued: { type: 'number', exclusiveMinimum: 0 },
            backpressure: { enum: [...SUBSCRIPTION_BACKPRESSURE_POLICIES] },
            deduplicateBy: id,
            deduplicationWindow: { type: 'number' },
            maxAttempts: { type: 'number' },
            onFailure: { enum: [...SUBSCRIPTION_FAILURE_POLICIES] },
          }),
          SubscriptionLifecyclePolicy: object({
            autoStart: { type: 'boolean' },
            required: { type: 'boolean' },
            reconnect: ref('RetryPolicy'),
          }),
          SubscriptionDef: object(
            {
              id,
              kind: { const: 'subscription' },
              name: { type: 'string' },
              metadata: { type: 'object' },
              integrationId: id,
              source: {
                type: 'string',
                description:
                  'A semantic source name the adapter maps to a topic, URL, queue or device. ' +
                  'Never a broker address, a socket or a path.',
              },
              arguments: { type: 'object', additionalProperties: expression },
              eventId: id,
              lifecycle: ref('SubscriptionLifecyclePolicy'),
              delivery: ref('SubscriptionDeliveryPolicy'),
            },
            ['id', 'kind', 'integrationId', 'eventId'],
          ),
          StorageDef: object(
            {
              id,
              kind: { const: 'storage' },
              name: { type: 'string' },
              metadata: { type: 'object' },
              blobEntityId: id,
              readAuthorization: expression,
              uploadAuthorization: expression,
              acceptedMediaTypes: { type: 'array', items: { type: 'string' } },
              maxSizeBytes: { type: 'number' },
              retry: ref('RetryPolicy'),
            },
            ['id', 'kind', 'blobEntityId'],
          ),
        }),

    ...(!atLeast(contract, 'axiom.server.v6')
      ? {}
      : {
          RelationshipEndpoint: object({ entityId: id, fieldId: id }, ['entityId', 'fieldId']),
          RelationshipDef: object(
            {
              id,
              kind: { const: 'relationship' },
              name: { type: 'string' },
              metadata: { type: 'object' },
              from: ref('RelationshipEndpoint'),
              to: ref('RelationshipEndpoint'),
              cardinality: { enum: [...RELATIONSHIP_CARDINALITIES] },
            },
            ['id', 'kind', 'from', 'to', 'cardinality'],
          ),
          ReadPolicyDef: object(
            {
              id,
              kind: { const: 'read-policy' },
              name: { type: 'string' },
              metadata: { type: 'object' },
              entityId: id,
              rowScopeId: id,
              predicate: expression,
            },
            ['id', 'kind', 'entityId', 'rowScopeId', 'predicate'],
          ),
          QueryParameter: object(
            { id, name: { type: 'string' }, valueType: ref('TypeRef'), required: { type: 'boolean' } },
            ['id', 'valueType'],
          ),
          QuerySortKey: object(
            {
              key: expression,
              direction: { enum: [...QUERY_SORT_DIRECTIONS] },
              nulls: { enum: [...QUERY_NULLS_ORDERS] },
            },
            ['key'],
          ),
          QueryProjectionField: object({ id, value: expression }, ['id', 'value']),
          QueryProjection: object(
            { entityId: id, fields: { type: 'array', items: ref('QueryProjectionField') } },
            ['entityId', 'fields'],
          ),
          QueryRelationshipUse: object(
            { relationshipId: id, bindAs: id, maxPageSize: { type: 'number' } },
            ['relationshipId', 'bindAs'],
          ),
          QueryAggregate: object(
            { function: { enum: [...QUERY_AGGREGATE_FUNCTIONS] }, key: expression, as: id },
            ['function', 'as'],
          ),
          QueryPagination: object(
            {
              strategy: { enum: [...QUERY_PAGINATION_STRATEGIES] },
              maxPageSize: { type: 'number' },
              defaultPageSize: { type: 'number' },
            },
            ['strategy'],
          ),
          QueryDef: object(
            {
              id,
              kind: { const: 'query' },
              name: { type: 'string' },
              metadata: { type: 'object' },
              parameters: { type: 'array', items: ref('QueryParameter') },
              source: id,
              rowScopeId: id,
              filter: expression,
              sort: { type: 'array', items: ref('QuerySortKey') },
              relationships: { type: 'array', items: ref('QueryRelationshipUse') },
              projection: ref('QueryProjection'),
              groupBy: { type: 'array', items: expression },
              aggregate: { type: 'array', items: ref('QueryAggregate') },
              pagination: ref('QueryPagination'),
              readPolicyId: id,
            },
            ['id', 'kind', 'source', 'rowScopeId'],
          ),
        }),

    ...(!atLeast(contract, 'axiom.server.v7')
      ? {}
      : {
          MigrationConstant: object({ id, value: ref('LiteralValue') }, ['id', 'value']),
          MigrationOperation: {
            description: `The closed migration operation vocabulary: ${[...MIGRATION_OPERATION_KINDS].join(', ')}.`,
            oneOf: [
              variant('add-entity', { id, destructive: { type: 'boolean' }, entity: ref('EntityDef') }, ['id', 'entity']),
              variant('remove-entity', { id, destructive: { type: 'boolean' }, entityId: id }, ['id', 'entityId']),
              variant(
                'add-field',
                {
                  id,
                  destructive: { type: 'boolean' },
                  entityId: id,
                  field: ref('FieldDef'),
                  populate: expression,
                  constants: { type: 'array', items: ref('MigrationConstant') },
                },
                ['id', 'entityId', 'field'],
              ),
              variant('remove-field', { id, destructive: { type: 'boolean' }, entityId: id, fieldId: id }, ['id', 'entityId', 'fieldId']),
              variant(
                'change-field',
                {
                  id,
                  destructive: { type: 'boolean' },
                  entityId: id,
                  fieldId: id,
                  to: object({ valueType: ref('TypeRef'), required: { type: 'boolean' } }),
                },
                ['id', 'entityId', 'fieldId', 'to'],
              ),
              variant(
                'populate-field',
                {
                  id,
                  destructive: { type: 'boolean' },
                  entityId: id,
                  fieldId: id,
                  value: expression,
                  constants: { type: 'array', items: ref('MigrationConstant') },
                },
                ['id', 'entityId', 'fieldId', 'value'],
              ),
              variant(
                'transform-field',
                {
                  id,
                  destructive: { type: 'boolean' },
                  entityId: id,
                  fieldId: id,
                  fromType: ref('TypeRef'),
                  toType: ref('TypeRef'),
                  expression,
                  constants: { type: 'array', items: ref('MigrationConstant') },
                },
                ['id', 'entityId', 'fieldId', 'fromType', 'toType', 'expression'],
              ),
              variant(
                'transform-record',
                {
                  id,
                  destructive: { type: 'boolean' },
                  entityId: id,
                  produce: expression,
                  removesFields: { type: 'array', items: id },
                  addsFields: { type: 'array', items: id },
                  constants: { type: 'array', items: ref('MigrationConstant') },
                },
                ['id', 'entityId', 'produce'],
              ),
              variant('add-relationship', { id, destructive: { type: 'boolean' }, relationship: ref('RelationshipDef') }, ['id', 'relationship']),
              variant('remove-relationship', { id, destructive: { type: 'boolean' }, relationshipId: id }, ['id', 'relationshipId']),
            ],
          },
          MigrationDef: object(
            {
              id,
              kind: { const: 'migration' },
              name: { type: 'string' },
              metadata: { type: 'object' },
              fromSchema: { type: 'integer', minimum: 1 },
              toSchema: { type: 'integer', minimum: 2 },
              operations: { type: 'array', items: ref('MigrationOperation') },
              reversibility: { enum: [...MIGRATION_REVERSIBILITIES] },
              reverseOperations: { type: 'array', items: ref('MigrationOperation') },
            },
            ['id', 'kind', 'fromSchema', 'toSchema', 'operations'],
          ),
        }),
  },
});

/** `axiom.server.v1` → `v1`, for a file name and a title. */
function short(contract) {
  return contract.slice(contract.lastIndexOf('.') + 1);
}

function expressionKindsFor(contract) {
  return contract === 'axiom.server.v1'
    ? EXPRESSION_KINDS.filter((kind) => !SERVER_IR_V2_EXPRESSION_KINDS.includes(kind))
    : [...EXPRESSION_KINDS];
}

function builtinFunctionsFor(contract) {
  return atLeast(contract, 'axiom.server.v7')
    ? [...BUILTIN_FUNCTIONS]
    : BUILTIN_FUNCTIONS.filter((name) => !SERVER_IR_V7_BUILTIN_FUNCTIONS.includes(name));
}

function operationKindsFor(contract) {
  return OPERATION_KINDS.filter((kind) => {
    if (!atLeast(contract, 'axiom.server.v3') && SERVER_IR_V3_OPERATION_KINDS.includes(kind)) {
      return false;
    }
    if (!atLeast(contract, 'axiom.server.v5') && SERVER_IR_V5_OPERATION_KINDS.includes(kind)) {
      return false;
    }
    return atLeast(contract, 'axiom.server.v6') || !SERVER_IR_V6_OPERATION_KINDS.includes(kind);
  });
}

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

    ServerRequest: {
      oneOf: [ref('SnapshotRequest'), ref('InvokeRequest'), ref('EventRequest'), ref('QueryRequest')],
    },
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

    EventRequest: object(
      {
        kind: { const: 'event' },
        protocol: { const: PROTOCOL_VERSION },
        eventId: id,
        payload: {},
        credential: ref('Credential'),
      },
      ['kind', 'protocol', 'eventId', 'payload'],
    ),
    EventResponse: object(
      {
        kind: { const: 'event-result' },
        protocol: { const: PROTOCOL_VERSION },
        ok: { type: 'boolean' },
        diagnostics: { type: 'array', items: diagnostic },
      },
      ['kind', 'protocol', 'ok', 'diagnostics'],
    ),

    QueryRequest: object(
      {
        kind: { const: 'query' },
        protocol: { const: PROTOCOL_VERSION },
        queryId: id,
        arguments: { type: 'object' },
        cursor: { type: 'string' },
        pageSize: { type: 'integer', minimum: 1 },
        offset: { type: 'integer', minimum: 0 },
        credential: ref('Credential'),
      },
      ['kind', 'protocol', 'queryId'],
    ),
    QueryPageResult: object(
      {
        items: { type: 'array', items: { type: 'object' } },
        nextCursor: { type: ['string', 'null'] },
        hasMore: { type: 'boolean' },
      },
      ['items', 'nextCursor', 'hasMore'],
    ),
    QueryAggregateResult: object(
      {
        rows: {
          type: 'array',
          items: object({ key: { type: 'array' }, values: { type: 'object' } }, ['values']),
        },
      },
      ['rows'],
    ),
    QueryResponse: object(
      {
        kind: { const: 'query-result' },
        protocol: { const: PROTOCOL_VERSION },
        ok: { type: 'boolean' },
        diagnostics: { type: 'array', items: diagnostic },
        page: ref('QueryPageResult'),
        aggregate: ref('QueryAggregateResult'),
        revision: { type: 'integer', minimum: 0 },
      },
      ['kind', 'protocol', 'ok', 'diagnostics', 'revision'],
    ),

    ServerResponse: {
      oneOf: [
        ref('SnapshotResponse'),
        ref('InvokeResponse'),
        ref('ErrorResponse'),
        ref('EventResponse'),
        ref('QueryResponse'),
      ],
    },
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
const written = [];
for (const contract of SERVER_IR_CONTRACTS) {
  const file = `server-ir.${short(contract)}.schema.json`;
  await writeFile(path.join(directory, file), `${JSON.stringify(buildServerIR(contract), null, 2)}\n`);
  written.push(file);
}
await writeFile(path.join(directory, 'protocol.v1.schema.json'), `${JSON.stringify(protocol, null, 2)}\n`);
written.push('protocol.v1.schema.json');
console.log(`Wrote ${written.join(', ')}`);
