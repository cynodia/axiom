import type {
  Expression,
  FieldId,
  LiteralValue,
  NodeId,
  QueryAggregate,
  QueryProjection,
  QueryRelationshipUse,
  RelationshipDef,
} from './deps.js';

/**
 * The semantic data provider contract.
 *
 * Everything provider-specific — SQL, an index, a storage layout, an execution plan — lives
 * *behind* this interface. Above it there is only portable semantic IR: a normalized query
 * (`ProviderQuery`) and typed rows back. The application never invokes a provider directly
 * (spec 0.10 §27); the authoritative runtime does, after it has bound the principal,
 * combined the read policy into the filter, clamped the page size and decoded the cursor.
 *
 * A provider that cannot execute a required semantic exactly **rejects** it — it never
 * loads the table and approximates in memory (spec §9, §81, §84). `capabilities` and the
 * `unsupported` list a `QueryPlan` carries are how that rejection is made inspectable
 * *before* deployment.
 */

/** A capability a provider may or may not be able to push down. */
export type DataProviderCapability =
  | 'filter'
  | 'sort'
  | 'cursor'
  | 'offset'
  | 'projection'
  | 'relationship'
  | 'aggregate'
  | 'group'
  | 'transactional-reads'
  /** The provider is a bounded in-memory source that has *explicitly* declared local evaluation is safe (spec §9). */
  | 'local-evaluation';

export const DATA_PROVIDER_CAPABILITIES: readonly DataProviderCapability[] = [
  'filter',
  'sort',
  'cursor',
  'offset',
  'projection',
  'relationship',
  'aggregate',
  'group',
  'transactional-reads',
  'local-evaluation',
];

export interface ProviderCapabilities {
  supports: readonly DataProviderCapability[];
  /**
   * The authority's hard ceiling on a page, regardless of what a `QueryDef` or a request
   * asks for. A hostile `pageSize: 10_000_000` cannot cause unbounded materialization
   * (spec §15).
   */
  maxPageSize: number;
}

export function providerSupports(
  capabilities: ProviderCapabilities,
  capability: DataProviderCapability,
): boolean {
  return capabilities.supports.includes(capability);
}

/** Success/failure envelope, matching `BlobStoreResult` in shape. */
export interface ProviderSuccess<T> {
  ok: true;
  value: T;
}

export interface ProviderFailure {
  ok: false;
  code: string;
  message: string;
  retryable?: boolean;
}

export type ProviderResult<T> = ProviderSuccess<T> | ProviderFailure;

/** One page of a query result. Cursor representation is opaque application data (spec §12). */
export interface QueryPage<T = Record<string, LiteralValue>> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * What a provider returns for a row query. The provider never signs a cursor — it reports
 * the keyset position of the last row it returned, and the runtime seals that into the
 * opaque, fingerprinted `nextCursor` string a client receives (spec §13).
 */
export interface ProviderPage {
  items: Record<string, LiteralValue>[];
  hasMore: boolean;
  lastPosition?: CursorPosition;
}

/**
 * One aggregate result row: the group-key values (absent for an ungrouped aggregate) and
 * the aggregate scalars keyed by their `as` field id.
 */
export interface AggregateRow {
  key?: LiteralValue[];
  values: Record<string, LiteralValue>;
}

export interface AggregateResult {
  rows: AggregateRow[];
}

/** A keyset cursor's decoded position: the previous page's last row, in sort order. */
export interface CursorPosition {
  /** The projected sort-key values at the last row of the previous page. */
  sortValues: LiteralValue[];
  /** The identity value of that row — the final, canonical tie-breaker (spec §11). */
  identityValue: LiteralValue;
}

export interface ProviderSortKey {
  key: Expression;
  direction: 'asc' | 'desc';
  nulls: 'first' | 'last';
  /** A short human/agent-readable label for the plan, e.g. `"createdAt DESC"`. */
  label: string;
}

export interface ProviderRelationship {
  use: QueryRelationshipUse;
  relationship: RelationshipDef;
}

/**
 * A row mutation an action commits against provider-backed data (spec §37, §42). All the
 * mutations of one action are applied atomically or not at all (spec §44).
 */
export interface ProviderMutation {
  entityId: NodeId;
  identityFieldId: FieldId;
  identityValue: LiteralValue;
  kind: 'set' | 'remove';
  /** For `set`: the full proposed row. */
  row?: Record<string, LiteralValue>;
}

/**
 * The normalized query the runtime hands a provider. Everything policy- and
 * principal-dependent is already resolved: the `filter` here is
 * `requestedFilter AND readPolicy.predicate` with the policy's row scope rebound to
 * `rowScopeId`, and `principal` is the authenticated caller record (spec §47, §56).
 */
export interface ProviderQuery {
  queryId: NodeId;
  source: NodeId;
  rowScopeId: NodeId;
  /** Absent means "every row". */
  filter?: Expression;
  /** Canonical identity is already appended as the final key when paginating by cursor. */
  sort: ProviderSortKey[];
  identityFieldId?: FieldId;
  projection?: QueryProjection;
  relationships: ProviderRelationship[];
  groupBy: Expression[];
  aggregate: QueryAggregate[];
  /** Resolved, type-checked argument values by parameter id. */
  arguments: Record<string, LiteralValue>;
  /** The caller record bound to `PRINCIPAL`, or `null` when the application declares no principal. */
  principal: Record<string, LiteralValue> | null;
  /** Already clamped to `min(request, queryDef.maxPageSize, provider.maxPageSize)`. */
  pageSize: number;
  strategy: 'cursor' | 'offset';
  /** Cursor continuation position, decoded and verified by the runtime. */
  after?: CursorPosition;
  /** Offset strategy only. */
  offset?: number;
}

/**
 * A provider-produced description of what it will actually do — the physical plan, made
 * inspectable without exposing SQL (spec §30-31). `unsupported` being non-empty means the
 * query **must be rejected**: the provider cannot execute a required semantic exactly.
 */
export interface QueryPlan {
  queryId: NodeId;
  source: NodeId;
  pushedFilter: boolean;
  pushedSort: readonly string[];
  pagination: { strategy: 'cursor' | 'offset'; pageSize: number };
  projection: readonly string[];
  relationships: readonly string[];
  aggregates: readonly string[];
  /** Required semantics the provider cannot push down. Non-empty ⇒ the query is rejected. */
  unsupported: readonly string[];
}

export interface DataProvider {
  readonly capabilities: ProviderCapabilities;
  /** Executes a row query and returns one page (raw keyset position, not a sealed cursor). */
  query(query: ProviderQuery): Promise<ProviderResult<ProviderPage>>;
  /** Executes an aggregate/grouped query without materializing rows into the runtime (spec §25). */
  aggregate(query: ProviderQuery): Promise<ProviderResult<AggregateResult>>;
  /** Loads specific rows of an entity by identity, for a transactional action read (spec §39). */
  loadByIdentity(
    entityId: NodeId,
    identityFieldId: FieldId,
    values: readonly LiteralValue[],
  ): Promise<ProviderResult<Record<string, LiteralValue>[]>>;
  /** Applies an action's row mutations atomically (spec §42, §44). Optional until a provider supports writes. */
  applyMutations?(mutations: readonly ProviderMutation[]): Promise<ProviderResult<null>>;
  /** The plan the provider would run for this query. Pure — no execution, no I/O. */
  explain(query: ProviderQuery): QueryPlan;
}

export type DataProviderRegistry = Record<NodeId, DataProvider>;

/**
 * Which capabilities a query actually needs, as capability names. The runtime compares this
 * to `provider.capabilities.supports`; anything missing is an `unsupported` plan entry and
 * a `QUERY_CAPABILITY_UNSUPPORTED` rejection.
 */
export function requiredCapabilities(query: {
  filter?: unknown;
  sort?: { length: number };
  projection?: unknown;
  relationships?: { length: number };
  aggregate?: { length: number };
  groupBy?: { length: number };
  strategy: 'cursor' | 'offset';
}): DataProviderCapability[] {
  const needed: DataProviderCapability[] = [];
  if (query.filter) {
    needed.push('filter');
  }
  if ((query.sort?.length ?? 0) > 0) {
    needed.push('sort');
  }
  needed.push(query.strategy);
  if (query.projection) {
    needed.push('projection');
  }
  if ((query.relationships?.length ?? 0) > 0) {
    needed.push('relationship');
  }
  if ((query.aggregate?.length ?? 0) > 0) {
    needed.push('aggregate');
  }
  if ((query.groupBy?.length ?? 0) > 0) {
    needed.push('group');
  }
  return needed;
}
