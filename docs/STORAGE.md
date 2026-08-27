# Storage and blobs

Axiom 0.9.0-alpha.2. How an application stores, references, serves and deletes binary data —
an attachment, a document, a photograph, a diagnostic log — with no filesystem path, no
upload route and no download route anywhere in it.

[`SUBSCRIPTIONS.md`](SUBSCRIPTIONS.md) is the other half of 0.9; [`EFFECTS.md`](EFFECTS.md)
is the outbox machinery this reuses rather than duplicating.

## The abstraction

A **stored object addressed by an opaque key**. Never a path, an inode or a descriptor.

That is what lets the same graph run against a local directory in development, an S3-like
store in production and an in-memory store in a test without a single edit — and it is why
`readFile(path)` is not, and will not become, graph vocabulary. See
[`ANTI_PATTERNS.md`](ANTI_PATTERNS.md#os-io-primitives-are-not-graph-vocabulary).

**Bytes never enter the graph, the Server IR or canonical state.** What state holds is a
`BlobRef`. Transfer of the bytes is out of band, through the host's own transport.

## BlobRef

```ts
graph.addNode<EntityDef>(blobRefEntity(ENTITY_BLOB));
```

An ordinary entity, built once per graph, with reserved field ids:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `BLOB_KEY_FIELD` | string | yes | The opaque key. The identity field. |
| `BLOB_MEDIA_TYPE_FIELD` | string | yes | The object's media type. |
| `BLOB_SIZE_FIELD` | number | yes | Bytes. |
| `BLOB_FILENAME_FIELD` | string | no | The name it was uploaded under. |
| `BLOB_CHECKSUM_FIELD` | string | no | A digest, when the store computes one. |

Those five fields are the **whole** public contract. A `BlobRef` crossing to a client carries
no bucket, container, region, account, path, provider name or lifecycle bookkeeping. Field ids
are graph-global, so one graph declares one blob entity and every store and every attachment
field references it.

Store it wherever an attachment belongs:

```ts
// Document { id, title, attachment: BlobRef }
{ id: F_DOCUMENT_ATTACHMENT, valueType: optionalType(entityType(ENTITY_BLOB)) }
```

A `BlobRef` is ordinary authoritative state: it persists, it survives a restart, it is
observable, and its identity is stable enough to hold in a record.

**Checksums are offered, never required.** Content addressing is a legitimate storage model
and a poor universal one, so a store that computes a digest publishes it and one that does
not omits it.

## StorageDef

```ts
interface StorageDef {
  id: NodeId;
  kind: 'storage';
  blobEntityId: NodeId;
  readAuthorization?: Expression;
  uploadAuthorization?: Expression;
  acceptedMediaTypes?: string[];
  maxSizeBytes?: number;
  retry?: { policy: 'none' | 'fixed' | 'exponential'; maxAttempts?: number; delayMs?: number };
}
```

`StorageDef` is to blobs what `IntegrationDef` is to operations: the semantic capability,
never the provider. No bucket, endpoint, region, credential or directory appears here or
anywhere else in a graph — a `BlobStorageAdapter` supplies all of it. A local filesystem
adapter is perfectly legitimate; its paths are host configuration.

## Authorization

**Possession of a key is not permission.** `readAuthorization` is evaluated by the authority
before a single byte is served, with the caller bound to `PRINCIPAL` and the requested
`BlobRef` bound to `ref(<this storage's id>)`:

```ts
graph.addNode<StorageDef>({
  id: STORAGE_DIAGNOSTICS,
  kind: 'storage',
  blobEntityId: ENTITY_BLOB,
  // Readable only while some device actually references it.
  readAuthorization: some(ref(STATE_DEVICES), SCOPE, binary('eq',
    field(field(ref(SCOPE), F_DEVICE_LOG), BLOB_KEY_FIELD),
    field(ref(STORAGE_DIAGNOSTICS), BLOB_KEY_FIELD))),
  uploadAuthorization: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('operator')),
});
```

MUST: a store with **no** rule serves nothing and accepts nothing. The safe default for a
missing access rule is refusal, so an author who forgets one gets a closed door.

A key that names nothing and a key the caller may not read are answered **identically**
(`BLOB_ACCESS_DENIED`), deliberately: distinguishing them would turn the endpoint into an
oracle a hostile client could enumerate keys with.

Delete goes through an action, so an action's ordinary `authorization` governs it.

## Operations

| Operation | Shape | When it runs |
| --- | --- | --- |
| `blob-metadata` | query-like | Resolved **before** the transaction opens, binds the `BlobRef` into scope via `bindAs`. |
| `blob-commit` | effect-like | Recorded as intent; dispatched **after** the transaction commits. |
| `blob-delete` | effect-like | The same. |

None is legal inside a `for-each`. All three make their action server-authority, exactly as an
integration operation does.

```ts
{ kind: 'blob-metadata', storageId: STORAGE, blobKey: <Expression>, bindAs: SCOPE }
{ kind: 'blob-commit',   storageId: STORAGE, blobKey: <Expression>, succeededEventId?, failedEventId? }
{ kind: 'blob-delete',   storageId: STORAGE, blobKey: <Expression>, succeededEventId?, failedEventId? }
```

`blob-metadata` returns the `BlobRef` and never the bytes. A key that names nothing, or names
a still-staged object, **fails the invocation** rather than binding a plausible empty record —
`BLOB_METADATA_FAILED`, with the store's own code in `details.code`.

There is no `list`. Add one only when a real application scenario requires it.

## Lifecycle: staged, then committed

An object has two lifecycle values:

| | Meaning |
| --- | --- |
| `staged` | It exists and has a key. **Nothing references it.** |
| `stored` | A committed transaction claimed it, through `blob-commit`. |

This exists because **external object storage does not participate in an Axiom transaction**,
and pretending otherwise would be a lie. The consequences are stated rather than hidden:

**Storage succeeds, state commit fails.** The upload is already staged. The transaction that
meant to reference it rolls back, so the `blob-commit` intent is discarded with every other
effect of that transaction and the object stays `staged`. `BlobStorageAdapter.listStaged()`
enumerates them, so an orphan is a sweepable staged object rather than a committed object
nothing points at.

**State deletion succeeds, blob deletion fails.** The transaction committed: the record no
longer references the object, and that is correct. The `blob-delete` effect then failed, and
it is visible in `server.blobLog()` with its status and `lastError`. State correctness and
external cleanup remain **separately observable** rather than falsely coupled — the alternative
would be rolling back correct state because a remote store was briefly unreachable.

Orphan policy, therefore: **staged upload + commit, plus a host-side sweep of staged objects.**
Nothing pretends the store joined the transaction.

## Upload

```
user selects a file
      ↓
POST /axiom/blob/<storageId>          ← the host's transport, identical for every application
      ↓  (uploadAuthorization, acceptedMediaTypes, maxSizeBytes all checked here)
BlobRef                                ← staged
      ↓
action argument
      ↓
authoritative state + blob-commit
```

Application-authored upload routes: **zero**. `POST /axiom/blob/<storageId>` is the endpoint
for every Axiom application there will ever be, exactly as `POST /axiom` is the semantic one.
The request body is the bytes; `content-type` is the media type; the optional
`x-axiom-filename` header carries the filename. The response is `{ kind: 'blob', ref }`.

Programmatically, the same path is `server.stageBlob(storageId, principal, upload)`.

## Download

```
GET /axiom/blob/<storageId>/<key>
```

Application-authored download routes: **zero**. The authority evaluates the store's
`readAuthorization` against the caller, then the host streams the bytes with the object's
media type and, when it has one, a `content-disposition` naming the stored filename. The
opaque key is never offered as a filename.

Programmatically: `server.authorizeBlobRead(storageId, key, principal)`.

## Blobs are never base64 in state

MUST NOT: encode an object's contents into a `LiteralValue`, a state value, an action
argument or the Server IR. A 5MB attachment leaves the record it is attached to exactly as
large as a 5-byte one, because what the record holds is five scalars.

## Adapters

```ts
interface BlobStorageAdapter {
  stage(upload): Promise<BlobStoreResult<StoredBlob>>;
  commit(key): Promise<BlobStoreResult<StoredBlob>>;
  metadata(key): Promise<BlobStoreResult<StoredBlob>>;
  read(key): Promise<BlobStoreResult<{ blob: StoredBlob; data: Uint8Array }>>;
  delete(key): Promise<BlobStoreResult<null>>;
  listStaged?(olderThanMs?): Promise<StoredBlob[]>;
}
```

Registered per `StorageDef.id` on `createAxiomServer({ blobStores })` or
`serveAxiomApplication({ blobStores })`. A declared store with no adapter fails `start()`.

`stage` is the only write path, deliberately: there is no point at which a store could be
told to write an object that the transaction referencing it might still refuse.

`createMemoryBlobStore()` implements the complete lifecycle deterministically, with seeding
and per-operation failure injection for tests and conformance fixtures.

## Idempotency and retries

Storage effects ride the **same** transactional outbox integration effects do: committed
atomically with the state that references the object, dispatched post-commit, retried under
`StorageDef.retry`, and reported through `server.blobLog()` (a filtered view of
`effectLog()`). There is no second durability system.

## Observability

```ts
server.blobLog();  // EffectRecord[] whose `storage` is set
```

Each carries `storage.operation` (`'commit'` / `'delete'`), `storage.key`, `status`,
`attempts` and `lastError`. An uncommitted upload and a failed external deletion are both
visible here; neither is a silent orphan.

## Contract

Storage vocabulary requires `axiom.server.v5`, computed from the document. See
[`AUTHORITY.md`](AUTHORITY.md#contract-identifiers).

## Diagnostic codes

| Code | Meaning |
| --- | --- |
| `UNKNOWN_STORAGE` | (validation) A `storageId` or `blobEntityId` that does not resolve. |
| `INVALID_BLOB_ENTITY` | (validation) The named entity is not the `blobRefEntity()` shape. |
| `INVALID_BLOB_OPERATION` | (validation) A blob operation that cannot execute as written. |
| `BLOB_STORE_MISSING` | No adapter is registered for the store. |
| `BLOB_NOT_FOUND` | No object with that key, or the key names a still-staged upload. |
| `BLOB_ACCESS_DENIED` | The caller may not read, download or upload. Also the answer for a key that names nothing. |
| `BLOB_TOO_LARGE` | The upload exceeds `maxSizeBytes`. |
| `BLOB_MEDIA_TYPE_REJECTED` | The media type is not in `acceptedMediaTypes`. |
| `BLOB_OPERATION_FAILED` | A `blob-commit` or `blob-delete` failed at the store after its retry policy. |
| `BLOB_STORAGE_UNAVAILABLE` | (runtime) The host provides no object storage at all. |
| `BLOB_METADATA_FAILED` | (runtime) A `blob-metadata` lookup failed; the store's own code is in `details.code`. |
