/**
 * The narrow DOM surface the renderer uses. Declaring it structurally keeps the runtime
 * free of DOM library types and lets tests supply an in-memory implementation.
 */
export interface DomEvent {
  type: string;
  preventDefault?(): void;
  target?: unknown;
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

/** Everything the runtime needs from its environment, so nothing is read from globals. */
export interface HostEnvironment {
  document: DomDocument;
  getPath(): string;
  pushPath(path: string): void;
  onPathChange(listener: () => void): void;
  confirm(message: string): boolean;
  now(): string;
  uuid(): string;
  storage?: StorageAdapter;
  report?(message: string): void;
}
