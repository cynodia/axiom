import type { DomDocument, DomElement, DomEvent, DomListener, HostEnvironment, StorageAdapter } from './dom.js';

/**
 * An in-memory DOM and host. The runtime never touches browser globals directly, so the
 * same renderer that drives a real page can be driven headlessly in tests.
 */
export class MemoryElement implements DomElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  children: MemoryElement[] = [];
  textContent: string | null = null;
  value?: string;
  checked?: boolean;
  selectionStart: number | null = null;
  focused = false;
  private readonly listeners = new Map<string, DomListener[]>();

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: DomElement): unknown {
    this.children.push(child as MemoryElement);
    return child;
  }

  replaceChildren(...children: DomElement[]): void {
    this.children = children.map((child) => child as MemoryElement);
  }

  addEventListener(type: string, listener: DomListener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  focus(): void {
    this.focused = true;
  }

  dispatch(type: string, event: Partial<DomEvent> = {}): void {
    const payload: DomEvent = { type, target: this, preventDefault: () => undefined, ...event };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload);
    }
  }

  hasListener(type: string): boolean {
    return (this.listeners.get(type) ?? []).length > 0;
  }
}

export class MemoryDocument implements DomDocument {
  createElement(tagName: string): DomElement {
    return new MemoryElement(tagName);
  }
}

export interface MemoryHostOptions {
  path?: string;
  confirm?: boolean | (() => boolean);
  storage?: boolean;
}

export interface MemoryHost extends HostEnvironment {
  root: MemoryElement;
  path: string;
  reports: string[];
  confirmations: string[];
  storage?: StorageAdapter;
}

export function createMemoryHost(options: MemoryHostOptions = {}): MemoryHost {
  const listeners: Array<() => void> = [];
  const values = new Map<string, string>();
  let counter = 0;
  const confirmResult = options.confirm ?? true;

  const host: MemoryHost = {
    root: new MemoryElement('div'),
    path: options.path ?? '/',
    reports: [],
    confirmations: [],
    document: new MemoryDocument(),
    getPath: () => host.path,
    pushPath: (next: string) => {
      host.path = next;
    },
    onPathChange: (listener: () => void) => {
      listeners.push(listener);
    },
    confirm: (message: string) => {
      host.confirmations.push(message);
      return typeof confirmResult === 'function' ? confirmResult() : confirmResult;
    },
    now: () => {
      counter += 1;
      return `2026-01-01T00:00:${String(counter).padStart(2, '0')}.000Z`;
    },
    uuid: () => {
      counter += 1;
      return `id-${counter}`;
    },
    report: (message: string) => {
      host.reports.push(message);
    },
  };

  if (options.storage) {
    host.storage = {
      read: (key: string) => values.get(key) ?? null,
      write: (key: string, value: string) => {
        values.set(key, value);
      },
    };
  }

  return host;
}

/** Depth-first collection of every element matching a predicate. */
export function findAll(root: MemoryElement, predicate: (element: MemoryElement) => boolean): MemoryElement[] {
  const found: MemoryElement[] = [];
  const visit = (element: MemoryElement): void => {
    if (predicate(element)) {
      found.push(element);
    }
    for (const child of element.children) {
      visit(child);
    }
  };
  visit(root);
  return found;
}

export function findByNodeId(root: MemoryElement, nodeId: string): MemoryElement[] {
  return findAll(root, (element) => element.getAttribute('data-node') === nodeId);
}

export function findByTag(root: MemoryElement, tagName: string): MemoryElement[] {
  return findAll(root, (element) => element.tagName === tagName);
}

/** Concatenated text of an element and its descendants. */
export function textOf(element: MemoryElement): string {
  const parts: string[] = [];
  const visit = (current: MemoryElement): void => {
    if (current.textContent) {
      parts.push(current.textContent);
    }
    for (const child of current.children) {
      visit(child);
    }
  };
  visit(element);
  return parts.join(' ');
}

export function typeInto(element: MemoryElement, value: string): void {
  element.value = value;
  element.dispatch('input');
}

export function toggle(element: MemoryElement, checked: boolean): void {
  element.checked = checked;
  element.dispatch('change');
}

export function click(element: MemoryElement): void {
  element.dispatch('click');
}

export function submit(element: MemoryElement): void {
  element.dispatch('submit');
}
