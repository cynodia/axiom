import type { Expression } from './expressions.js';
import { fieldId } from './ids.js';
import type { FieldId, NodeId } from './ids.js';
import type { RetryPolicy } from './integrations.js';
import type { EntityDef, NodeBase } from './nodes.js';
import { primitiveType } from './type-ref.js';

/**
 * Binary application data — an attachment, a document, a photograph, a diagnostic log —
 * given a semantic home.
 *
 * The abstraction is a **stored object addressed by an opaque key**, never a path, an
 * inode or a file descriptor. That is what lets the same graph run against a local
 * directory in development, an S3-like store in production and an in-memory store in a
 * test without a single graph edit, and it is why `readFile(path)` is not, and will not
 * become, graph vocabulary.
 *
 * Bytes never enter the graph, the Server IR or canonical state. What state holds is a
 * `BlobRef`: a small record of key, media type, size and optional filename/checksum.
 * Transfer of the bytes themselves is out of band, through the host's own upload and
 * download transport — which is why an application declares no HTTP route for either.
 */

/**
 * Reserved field ids of the canonical `BlobRef` record.
 *
 * They follow the `EFFECT_*` convention rather than the `GROUP_*` one: a naming convention
 * plus the builder below, not a runtime-enforced reservation. Field ids are graph-global,
 * so one graph declares **one** blob entity with `blobRefEntity()` and every store and every
 * attachment field references it.
 *
 * `key` is the whole public identity of a stored object. It is opaque: nothing may parse
 * it, and it deliberately reveals no bucket, container, region, account, path or provider —
 * a client that holds one has learned nothing about where the bytes live, and holding one
 * grants no permission (see `StorageDef.readAuthorization`).
 */
export const BLOB_KEY_FIELD: FieldId = fieldId('field_blob_key');
export const BLOB_MEDIA_TYPE_FIELD: FieldId = fieldId('field_blob_media_type');
export const BLOB_SIZE_FIELD: FieldId = fieldId('field_blob_size');
export const BLOB_FILENAME_FIELD: FieldId = fieldId('field_blob_filename');
export const BLOB_CHECKSUM_FIELD: FieldId = fieldId('field_blob_checksum');

/** Every field of a canonical `BlobRef`, in declaration order. */
export const BLOB_REF_FIELDS: readonly FieldId[] = [
  BLOB_KEY_FIELD,
  BLOB_MEDIA_TYPE_FIELD,
  BLOB_SIZE_FIELD,
  BLOB_FILENAME_FIELD,
  BLOB_CHECKSUM_FIELD,
];

/**
 * The canonical reference-to-a-stored-object entity. Declare it once with
 * `graph.addNode(blobRefEntity(ENTITY_ID))`, name it from every `StorageDef.blobEntityId`,
 * and store it wherever an attachment belongs:
 *
 * ```ts
 * // Document { id, title, attachment: BlobRef }
 * { id: F_DOCUMENT_ATTACHMENT, valueType: optionalType(entityType(ENTITY_BLOB)) }
 * ```
 *
 * `key` is the identity field, so an attachment can be addressed by it the way any other
 * entity instance can. `checksum` is offered and never required: content addressing is a
 * legitimate storage model and a poor universal one, so a store that computes a digest
 * publishes it here and a store that does not simply omits it.
 */
export function blobRefEntity(id: NodeId): EntityDef {
  return {
    id,
    kind: 'entity',
    name: 'BlobRef',
    identityFieldId: BLOB_KEY_FIELD,
    fields: [
      { id: BLOB_KEY_FIELD, name: 'Key', valueType: primitiveType('string'), required: true },
      { id: BLOB_MEDIA_TYPE_FIELD, name: 'Media type', valueType: primitiveType('string'), required: true },
      { id: BLOB_SIZE_FIELD, name: 'Size', valueType: primitiveType('number'), required: true },
      { id: BLOB_FILENAME_FIELD, name: 'Filename', valueType: primitiveType('string') },
      { id: BLOB_CHECKSUM_FIELD, name: 'Checksum', valueType: primitiveType('string') },
    ],
  };
}

/**
 * Where a stored object is in its lifecycle.
 *
 * An upload lands `staged`: it exists, it has a key, and nothing references it yet. A
 * `blob-commit` operation promotes it to `stored`. That two-step exists because external
 * object storage does **not** participate in an Axiom transaction and pretending otherwise
 * would be a lie: if the transaction that meant to reference the upload rolls back, the
 * commit never dispatches, the object stays `staged`, and staged objects are swept. The
 * failure mode is a temporary orphan the host can enumerate, not a state referencing bytes
 * that were never stored.
 */
export type BlobLifecycle = 'staged' | 'stored';

export const BLOB_LIFECYCLES: readonly BlobLifecycle[] = ['staged', 'stored'];

/**
 * A named object store.
 *
 * It is to blobs what `IntegrationDef` is to external operations: the semantic capability,
 * never the provider. No bucket, endpoint, region, credential or directory appears here or
 * anywhere else in a graph — a `BlobStorageAdapter` supplies all of it.
 *
 * **Authorization is declared, not routed.** `readAuthorization` is evaluated by the host
 * before a single byte is served, with the caller bound to `PRINCIPAL` and the requested
 * `BlobRef` bound to `ref(<this storage's id>)`. That is what makes "possession of a key is
 * not permission" enforceable: a guessed or leaked key still has to satisfy a rule written
 * over authoritative state.
 */
export interface StorageDef extends NodeBase {
  kind: 'storage';
  /** The entity every `BlobRef` of this store conforms to — built with `blobRefEntity()`. */
  blobEntityId: NodeId;
  /**
   * Who may read this object's bytes or metadata through the transport. Absent means **no
   * one**: a store that declares no rule serves nothing, because the safe default for a
   * missing access rule is refusal, not disclosure.
   */
  readAuthorization?: Expression;
  /** Who may upload into this store. Absent means no one, for the same reason. */
  uploadAuthorization?: Expression;
  /** Media types the upload transport accepts. Absent accepts any. */
  acceptedMediaTypes?: string[];
  /** The largest upload the transport accepts, in bytes. */
  maxSizeBytes?: number;
  /** Retry policy for a failed `blob-commit`/`blob-delete`. Absent means `'none'`. */
  retry?: RetryPolicy;
}
