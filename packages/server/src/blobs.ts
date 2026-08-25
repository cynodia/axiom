import {
  BLOB_CHECKSUM_FIELD,
  BLOB_FILENAME_FIELD,
  BLOB_KEY_FIELD,
  BLOB_MEDIA_TYPE_FIELD,
  BLOB_SIZE_FIELD,
} from './deps.js';
import type { LiteralValue, NodeId } from './deps.js';

/** Mirrors core's `BlobLifecycle` without importing a value across the package boundary. */
type BlobLifecycle = 'staged' | 'stored';

/**
 * The storage half of the external-I/O boundary.
 *
 * Everything provider-specific lives behind this interface: a bucket name, a directory, a
 * connection string, a signing key, an SDK. Above it there is only an opaque key and a
 * small record of metadata, which is what makes the same graph run against a local
 * directory, an S3-like store and the in-memory store below without an edit.
 */

/** What the store knows about one object. Never the bytes. */
export interface StoredBlob {
  key: string;
  mediaType: string;
  size: number;
  filename?: string;
  checksum?: string;
  /** `staged` until a `blob-commit` promotes it; see `BlobLifecycle` in core. */
  lifecycle: 'staged' | 'stored';
  /** Host-side bookkeeping. Never disclosed and never part of the `BlobRef` contract. */
  createdAt?: string;
}

export interface BlobStoreSuccess<T> {
  ok: true;
  value: T;
}

export interface BlobStoreFailure {
  ok: false;
  code: string;
  message: string;
  retryable?: boolean;
}

export type BlobStoreResult<T> = BlobStoreSuccess<T> | BlobStoreFailure;

export interface BlobUpload {
  data: Uint8Array;
  mediaType: string;
  filename?: string;
}

/**
 * Translates semantic storage operations into provider-specific execution.
 *
 * `stage` is the write path and it is deliberately the only one: an object is created
 * staged, and becomes durable application data only when a committed transaction says so.
 * There is no "store directly" entry point, because there is no point at which a store
 * could be told to write an object that the transaction referencing it might still refuse.
 */
export interface BlobStorageAdapter {
  /** Accepts bytes and returns the object's key and metadata. The object starts `staged`. */
  stage(upload: BlobUpload): Promise<BlobStoreResult<StoredBlob>>;
  /** Promotes a staged object. Committing an already-stored object succeeds unchanged. */
  commit(key: string): Promise<BlobStoreResult<StoredBlob>>;
  /** Metadata for one object. A missing key is a failure, never an empty record. */
  metadata(key: string): Promise<BlobStoreResult<StoredBlob>>;
  /** The bytes, for the download transport. */
  read(key: string): Promise<BlobStoreResult<{ blob: StoredBlob; data: Uint8Array }>>;
  /** Removes an object. Deleting a key that is already gone succeeds. */
  delete(key: string): Promise<BlobStoreResult<null>>;
  /** Staged objects older than `olderThanMs`, so orphans are enumerable rather than lost. */
  listStaged?(olderThanMs?: number): Promise<StoredBlob[]>;
}

export type BlobStorageRegistry = Record<NodeId, BlobStorageAdapter>;

/**
 * The public `BlobRef` record, keyed by the reserved field ids.
 *
 * Exactly five fields cross the boundary, and `lifecycle`, `createdAt` and everything the
 * provider knows are not among them (spec 0.9 §53). A client that receives one has learned
 * an opaque key, a media type, a size and — if the author stored them — a filename and a
 * checksum. Nothing about where the bytes are.
 */
export function blobRef(blob: StoredBlob): Record<string, LiteralValue> {
  return {
    [BLOB_KEY_FIELD]: blob.key,
    [BLOB_MEDIA_TYPE_FIELD]: blob.mediaType,
    [BLOB_SIZE_FIELD]: blob.size,
    ...(blob.filename !== undefined ? { [BLOB_FILENAME_FIELD]: blob.filename } : {}),
    ...(blob.checksum !== undefined ? { [BLOB_CHECKSUM_FIELD]: blob.checksum } : {}),
  };
}

/** A stable, content-independent 32-bit digest, so a checksum needs no crypto dependency. */
function digest(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of data) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export interface MemoryBlobStoreOptions {
  /** Supplies keys. A deterministic host's `uuid` makes a conformance run reproducible. */
  uuid?(): string;
  now?(): string;
  /** Fails every operation whose name is listed, for failure-injection tests. */
  failOn?: Partial<Record<'stage' | 'commit' | 'metadata' | 'read' | 'delete', BlobStoreFailure>>;
  /**
   * Objects the store already holds, so a fixture can start from a stored attachment
   * without having had to upload one. `text` is the content, UTF-8; `size` and `checksum`
   * are computed from it exactly as a real staging would.
   */
  seed?: Array<{ key: string; mediaType: string; filename?: string; lifecycle?: BlobLifecycle; text?: string }>;
}

/**
 * In-memory object storage: the complete lifecycle, deterministically, with no filesystem.
 *
 * It is framework code rather than test scaffolding, for the same reason `createMemoryHost`
 * is: the semantics of staging, committing, reading and deleting must be executable without
 * a provider, or a conformance fixture could not state them.
 */
export function createMemoryBlobStore(options: MemoryBlobStoreOptions = {}): BlobStorageAdapter {
  const objects = new Map<string, { blob: StoredBlob; data: Uint8Array }>();
  for (const entry of options.seed ?? []) {
    const data = new TextEncoder().encode(entry.text ?? '');
    objects.set(entry.key, {
      blob: {
        key: entry.key,
        mediaType: entry.mediaType,
        size: data.byteLength,
        ...(entry.filename !== undefined ? { filename: entry.filename } : {}),
        checksum: digest(data),
        lifecycle: entry.lifecycle ?? 'stored',
      },
      data,
    });
  }
  let counter = 0;
  const uuid = options.uuid ?? (() => `blob-${(counter += 1)}`);
  const now = options.now ?? (() => new Date().toISOString());
  const injected = (name: keyof NonNullable<MemoryBlobStoreOptions['failOn']>): BlobStoreFailure | undefined =>
    options.failOn?.[name];

  return {
    async stage(upload: BlobUpload): Promise<BlobStoreResult<StoredBlob>> {
      const failure = injected('stage');
      if (failure) {
        return failure;
      }
      const data = Uint8Array.from(upload.data);
      const blob: StoredBlob = {
        key: uuid(),
        mediaType: upload.mediaType,
        size: data.byteLength,
        ...(upload.filename !== undefined ? { filename: upload.filename } : {}),
        checksum: digest(data),
        lifecycle: 'staged',
        createdAt: now(),
      };
      objects.set(blob.key, { blob, data });
      return { ok: true, value: blob };
    },
    async commit(key: string): Promise<BlobStoreResult<StoredBlob>> {
      const failure = injected('commit');
      if (failure) {
        return failure;
      }
      const entry = objects.get(key);
      if (!entry) {
        return { ok: false, code: 'BLOB_NOT_FOUND', message: `No stored object ${key}`, retryable: false };
      }
      entry.blob = { ...entry.blob, lifecycle: 'stored' };
      return { ok: true, value: entry.blob };
    },
    async metadata(key: string): Promise<BlobStoreResult<StoredBlob>> {
      const failure = injected('metadata');
      if (failure) {
        return failure;
      }
      const entry = objects.get(key);
      if (!entry) {
        return { ok: false, code: 'BLOB_NOT_FOUND', message: `No stored object ${key}`, retryable: false };
      }
      return { ok: true, value: entry.blob };
    },
    async read(key: string): Promise<BlobStoreResult<{ blob: StoredBlob; data: Uint8Array }>> {
      const failure = injected('read');
      if (failure) {
        return failure;
      }
      const entry = objects.get(key);
      if (!entry) {
        return { ok: false, code: 'BLOB_NOT_FOUND', message: `No stored object ${key}`, retryable: false };
      }
      return { ok: true, value: { blob: entry.blob, data: Uint8Array.from(entry.data) } };
    },
    async delete(key: string): Promise<BlobStoreResult<null>> {
      const failure = injected('delete');
      if (failure) {
        return failure;
      }
      objects.delete(key);
      return { ok: true, value: null };
    },
    async listStaged(): Promise<StoredBlob[]> {
      return [...objects.values()]
        .filter((entry) => entry.blob.lifecycle === 'staged')
        .map((entry) => ({ ...entry.blob }));
    },
  };
}
