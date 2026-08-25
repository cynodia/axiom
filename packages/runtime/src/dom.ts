/**
 * The narrow DOM surface the renderer uses. Declaring it structurally keeps the runtime
 * free of DOM library types and lets tests supply an in-memory implementation.
 */
export interface DomEvent {
  type: string;
  preventDefault?(): void;
  target?: unknown;
  /**
   * The key, for a keyboard event.
   *
   * Named the way every host already names it, and read for exactly two purposes: dismissing
   * a dialog on `Escape` and containing focus on `Tab`. It is not a general keyboard channel
   * — an application cannot bind a key, because a key binding would be behaviour expressed
   * outside the graph.
   */
  key?: string;
  shiftKey?: boolean;
}

export type DomListener = (event: DomEvent) => void;

export interface DomElement {
  tagName: string;
  textContent: string | null;
  value?: string;
  checked?: boolean;
  selectionStart?: number | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: DomElement): unknown;
  replaceChildren(...children: DomElement[]): void;
  addEventListener(type: string, listener: DomListener): void;
  focus?(): void;
}

export interface DomDocument {
  createElement(tagName: string): DomElement;
}

export interface StorageAdapter {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

/**
 * A confirmation, described rather than drawn. A host may present it however its platform
 * presents such things; nothing here is browser-specific, and the graph never constructs
 * dialog markup.
 */
export interface ConfirmationRequest {
  actionId: string;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  severity: 'informational' | 'warning' | 'destructive';
  /** A single line for hosts that can only ask a plain question. */
  message: string;
}

export interface IntegrationQuerySuccess {
  ok: true;
  value: unknown;
}

export interface IntegrationQueryFailure {
  ok: false;
  code: string;
  message: string;
  retryable?: boolean;
}

export type IntegrationQueryOutcome = IntegrationQuerySuccess | IntegrationQueryFailure;

/** Everything the runtime needs from its environment, so nothing is read from globals. */
export interface HostEnvironment {
  document: DomDocument;
  getPath(): string;
  pushPath(path: string): void;
  onPathChange(listener: () => void): void;
  confirm(message: string): boolean;
  /** Preferred over `confirm` when the host can present a structured confirmation. */
  confirmRequest?(request: ConfirmationRequest): boolean;
  now(): string;
  uuid(): string;
  storage?: StorageAdapter;
  report?(message: string): void;
  /**
   * Executes an integration query operation by id and returns its result.
   *
   * Only the authoritative runtime ever calls this, executing an `integration-query`
   * operation: no client-compiled action ever contains one (integrations default
   * server-only), so a browser host never needs to implement it.
   */
  queryIntegration?(
    operationId: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number },
  ): Promise<IntegrationQueryOutcome>;
  /**
   * Reads a stored object's metadata by key and returns it as a `BlobRef` record.
   *
   * The same shape as `queryIntegration`, and for the same reason: a `blob-metadata`
   * operation is a finite question resolved before the transaction opens. It returns the
   * reference, never the bytes — nothing in the runtime ever holds an object's contents.
   * Only the authoritative runtime calls this; object stores, like integrations, are
   * server-only.
   */
  readBlobMetadata?(
    storageId: string,
    key: string,
  ): Promise<IntegrationQueryOutcome>;
}
