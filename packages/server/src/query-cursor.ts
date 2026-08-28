import type { CursorPosition } from './data-provider.js';
import type { LiteralValue, NodeId } from './deps.js';

/**
 * The keyset cursor.
 *
 * A cursor is **opaque application data** (spec 0.10 §12): a base64url token a client stores
 * and hands back, never parses. Inside it is the position of the previous page's last row,
 * plus a fingerprint of everything that must not change while paging — the query, the
 * principal, and the read policy in force (spec §13). Continuing a page verifies the
 * fingerprint against the *current* request; any mismatch is `QUERY_CURSOR_INVALID` and
 * nothing is disclosed. A cursor from principal A cannot resume A's position for B, and a
 * cursor minted for one query cannot be replayed against another.
 *
 * Integrity is an HMAC-SHA-256 over the serialized payload, keyed by a per-authority
 * secret. It uses `globalThis.crypto.subtle`, which is a web standard present in Node ≥ 20,
 * browsers, Deno and workers — so the mechanism is portable, not Node-specific.
 */

export interface CursorPayload {
  /** Which `QueryDef` this cursor belongs to. */
  q: string;
  /** A stable digest of the request's protected arguments. */
  a: string;
  /** A stable digest of the principal record (or `'anon'`). */
  p: string;
  /** A stable digest of the effective read policy (or `'none'`). */
  rp: string;
  /** The Server IR contract the query compiled under. */
  c: string;
  /**
   * The semantic schema fingerprint the query ran under (spec11 §44). Absent for a
   * document with no schema identity. A cursor minted under one schema is refused after a
   * migration changes it — a persisted cursor never silently survives a schema change.
   */
  s?: string;
  /** The previous page's last-row position. */
  pos: CursorPosition;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function hmac(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await importKey(secret);
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, bufferSource(data));
  return new Uint8Array(signature);
}

/** Normalizes a `Uint8Array` to a plain `ArrayBuffer`-backed view for the Web Crypto API. */
function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** A short, order-insensitive digest of a JSON-serializable value, for a fingerprint. */
export async function fingerprint(value: unknown): Promise<string> {
  const canonical = stableStringify(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bufferSource(encoder.encode(canonical)));
  return toBase64Url(new Uint8Array(digest)).slice(0, 22);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Produces the opaque token a client receives as `nextCursor`. */
export async function sealCursor(payload: CursorPayload, secret: string): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = toBase64Url(await hmac(secret, encoder.encode(body)));
  return `${body}.${signature}`;
}

/**
 * Verifies and decodes a cursor. Returns `null` for any tampering — a bad signature, a
 * truncated token, malformed JSON — so a caller reports `QUERY_CURSOR_INVALID` without
 * having to distinguish the failure modes.
 */
export async function openCursor(token: string, secret: string): Promise<CursorPayload | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  let expected: string;
  try {
    expected = toBase64Url(await hmac(secret, encoder.encode(body)));
  } catch {
    return null;
  }
  if (!timingSafeEqual(provided, expected)) {
    return null;
  }
  try {
    return JSON.parse(decoder.decode(fromBase64Url(body))) as CursorPayload;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** A random 32-byte secret, for an authority that was not given one. */
export function randomCursorSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export interface CursorContext {
  queryId: NodeId;
  argumentsFingerprint: string;
  principalFingerprint: string;
  policyFingerprint: string;
  contract: string;
  /** The current semantic schema fingerprint, or absent for a document with no schema identity. */
  schemaFingerprint?: string;
}

/** Whether a decoded cursor was minted for exactly this request context. */
export function cursorMatchesContext(payload: CursorPayload, context: CursorContext): boolean {
  return (
    payload.q === String(context.queryId) &&
    payload.a === context.argumentsFingerprint &&
    payload.p === context.principalFingerprint &&
    payload.rp === context.policyFingerprint &&
    payload.c === context.contract &&
    // Enforced only when the current document has a schema identity, so a pre-0.11 cursor
    // against a pre-0.11 document still matches.
    (context.schemaFingerprint ? payload.s === context.schemaFingerprint : true)
  );
}

export type { LiteralValue };
