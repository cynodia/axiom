/**
 * A transport-independent channel adapter for live queries (spec13 §87, §88, §194).
 *
 * `AxiomServer.openLiveQuery` already returns an `AsyncIterable<LiveQueryMessage>` that names
 * no transport. This module is the thin, reusable glue that pumps that iterable over *any*
 * duplex message channel — a WebSocket, an SSE pair, a `MessagePort`, a worker channel — as
 * a small frame vocabulary. A reference WebSocket host is then two lines:
 *
 * ```ts
 * ws.on('connection', (socket) => {
 *   serveLiveQueryChannel(server, {
 *     send: (frame) => socket.send(JSON.stringify(frame)),
 *     onFrame: (cb) => socket.on('message', (raw) => cb(JSON.parse(String(raw)))),
 *     onClose: (cb) => socket.on('close', cb),
 *     close: () => socket.close(),
 *   });
 * });
 * ```
 *
 * The **application** writes none of this: no `socket.on`, no `broadcast`, no `redis.publish`,
 * no `setInterval`, no manual diff (spec13 §195). It is framework glue, and it is
 * deliberately not normative — a runtime in another language frames the same
 * `LiveQueryMessage`s however its transport prefers (spec13 §194).
 */

import type { AxiomServer } from './server.js';
import type { LiveQueryHandle, LiveQueryMessage } from './live-query.js';

/** Client → server. */
export type LiveQueryClientFrame =
  | { t: 'open'; id: string; queryId: string; arguments?: Record<string, unknown>; credential?: unknown }
  | { t: 'resume'; id: string; cursor: string; queryId: string; arguments?: Record<string, unknown>; credential?: unknown }
  | { t: 'close'; id: string };

/** Server → client. `id` echoes the client's stream id. */
export type LiveQueryServerFrame =
  | { t: 'message'; id: string; message: LiveQueryMessage }
  | { t: 'error'; id: string; code: string; message: string }
  | { t: 'closed'; id: string };

export interface LiveQueryChannel {
  send(frame: LiveQueryServerFrame): void;
  onFrame(handler: (frame: LiveQueryClientFrame) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface ServeLiveQueryChannelOptions {
  /** Hard cap on concurrent live streams for one channel (spec13 §46-§48, §130). */
  maxStreams?: number;
}

export interface LiveQueryChannelServer {
  /** Number of live streams currently open on this channel. */
  readonly openStreams: number;
  /** Close every stream and stop listening. Idempotent. */
  stop(): void;
}

/**
 * Serve live queries for one connected channel. Returns a handle whose `stop()` tears down
 * every stream — call it when the underlying transport closes (this also happens
 * automatically via {@link LiveQueryChannel.onClose}).
 */
export function serveLiveQueryChannel(
  server: AxiomServer,
  channel: LiveQueryChannel,
  options: ServeLiveQueryChannelOptions = {},
): LiveQueryChannelServer {
  const maxStreams = Math.max(1, options.maxStreams ?? 64);
  const streams = new Map<string, { handle: LiveQueryHandle; stop: () => void }>();
  let stopped = false;

  async function pump(id: string, handle: LiveQueryHandle): Promise<void> {
    try {
      for await (const message of handle) {
        if (stopped || !streams.has(id)) break;
        channel.send({ t: 'message', id, message });
        if (message.kind === 'closed') break;
      }
    } catch (error) {
      channel.send({
        t: 'error',
        id,
        code: 'LIVE_QUERY_STREAM_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (streams.delete(id) && !stopped) channel.send({ t: 'closed', id });
    }
  }

  async function open(frame: LiveQueryClientFrame & { t: 'open' | 'resume' }): Promise<void> {
    if (streams.has(frame.id)) {
      channel.send({ t: 'error', id: frame.id, code: 'LIVE_QUERY_STREAM_EXISTS', message: `stream ${frame.id} is already open` });
      return;
    }
    if (streams.size >= maxStreams) {
      channel.send({ t: 'error', id: frame.id, code: 'LIVE_QUERY_TOO_MANY_STREAMS', message: `channel is at its ${maxStreams}-stream limit` });
      return;
    }
    const request = {
      queryId: frame.queryId,
      ...(frame.arguments ? { arguments: frame.arguments } : {}),
      ...(frame.credential !== undefined ? { credential: frame.credential } : {}),
    };
    const result =
      frame.t === 'open'
        ? await server.openLiveQuery(request)
        : await server.resumeLiveQuery(frame.cursor, request);
    if ('error' in result) {
      channel.send({ t: 'error', id: frame.id, code: result.error.code, message: result.error.message });
      return;
    }
    streams.set(frame.id, { handle: result, stop: () => result.close() });
    void pump(frame.id, result);
  }

  channel.onFrame((frame) => {
    if (stopped) return;
    if (frame.t === 'open' || frame.t === 'resume') {
      void open(frame);
    } else if (frame.t === 'close') {
      const stream = streams.get(frame.id);
      if (stream) {
        streams.delete(frame.id);
        stream.stop();
        channel.send({ t: 'closed', id: frame.id });
      }
    }
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const [, stream] of streams) stream.stop();
    streams.clear();
  };
  channel.onClose(stop);

  return {
    get openStreams() {
      return streams.size;
    },
    stop,
  };
}

/**
 * The client side: turn a channel into an `openLiveQuery`-shaped factory. Each call opens a
 * stream and returns an `AsyncIterable<LiveQueryMessage>` — the exact contract the in-process
 * `LiveQueryHandle` offers, so client code is identical on either transport.
 */
export interface LiveQueryChannelClient {
  open(queryId: string, options?: { arguments?: Record<string, unknown>; credential?: unknown }): LiveQueryClientStream;
  resume(
    cursor: string,
    queryId: string,
    options?: { arguments?: Record<string, unknown>; credential?: unknown },
  ): LiveQueryClientStream;
}

export interface LiveQueryClientStream extends AsyncIterable<LiveQueryMessage> {
  readonly id: string;
  close(): void;
}

export interface ClientChannel {
  send(frame: LiveQueryClientFrame): void;
  onFrame(handler: (frame: LiveQueryServerFrame) => void): void;
  onClose(handler: () => void): void;
}

export function createLiveQueryChannelClient(channel: ClientChannel): LiveQueryChannelClient {
  let counter = 0;
  const streams = new Map<
    string,
    { queue: LiveQueryMessage[]; waiters: Array<(r: IteratorResult<LiveQueryMessage>) => void>; done: boolean }
  >();

  const deliver = (id: string, result: IteratorResult<LiveQueryMessage>): void => {
    const stream = streams.get(id);
    if (!stream) return;
    const waiter = stream.waiters.shift();
    if (waiter) waiter(result);
    else if (!result.done) stream.queue.push(result.value);
  };

  channel.onFrame((frame) => {
    const stream = streams.get(frame.id);
    if (!stream) return;
    if (frame.t === 'message') {
      deliver(frame.id, { value: frame.message, done: false });
    } else if (frame.t === 'error') {
      deliver(frame.id, { value: { kind: 'error', code: frame.code, message: frame.message }, done: false });
    } else if (frame.t === 'closed') {
      stream.done = true;
      for (const waiter of stream.waiters.splice(0)) waiter({ value: undefined as never, done: true });
      streams.delete(frame.id);
    }
  });
  channel.onClose(() => {
    for (const [id, stream] of streams) {
      stream.done = true;
      for (const waiter of stream.waiters.splice(0)) waiter({ value: undefined as never, done: true });
      streams.delete(id);
    }
  });

  const makeStream = (id: string): LiveQueryClientStream => {
    streams.set(id, { queue: [], waiters: [], done: false });
    return {
      id,
      close: () => {
        if (streams.has(id)) {
          channel.send({ t: 'close', id });
          const stream = streams.get(id)!;
          stream.done = true;
          for (const waiter of stream.waiters.splice(0)) waiter({ value: undefined as never, done: true });
          streams.delete(id);
        }
      },
      [Symbol.asyncIterator](): AsyncIterator<LiveQueryMessage> {
        return {
          next: () => {
            const stream = streams.get(id);
            if (!stream) return Promise.resolve({ value: undefined as never, done: true });
            const queued = stream.queue.shift();
            if (queued) return Promise.resolve({ value: queued, done: false });
            if (stream.done) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((resolve) => stream.waiters.push(resolve));
          },
          return: () => {
            const stream = streams.get(id);
            if (stream) {
              channel.send({ t: 'close', id });
              streams.delete(id);
            }
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };
  };

  return {
    open: (queryId, opts = {}) => {
      const id = `s${(counter += 1)}`;
      const stream = makeStream(id);
      channel.send({
        t: 'open',
        id,
        queryId,
        ...(opts.arguments ? { arguments: opts.arguments } : {}),
        ...(opts.credential !== undefined ? { credential: opts.credential } : {}),
      });
      return stream;
    },
    resume: (cursor, queryId, opts = {}) => {
      const id = `s${(counter += 1)}`;
      const stream = makeStream(id);
      channel.send({
        t: 'resume',
        id,
        cursor,
        queryId,
        ...(opts.arguments ? { arguments: opts.arguments } : {}),
        ...(opts.credential !== undefined ? { credential: opts.credential } : {}),
      });
      return stream;
    },
  };
}

/**
 * An in-memory duplex channel pair — for tests and for a worker/`MessagePort` transport.
 * Frames are structured-cloned so neither side can hand the other a live object reference,
 * exactly as a real socket would enforce.
 */
export function createInMemoryChannelPair(): { server: LiveQueryChannel; client: ClientChannel } {
  const toServer: Array<(frame: LiveQueryClientFrame) => void> = [];
  const toClient: Array<(frame: LiveQueryServerFrame) => void> = [];
  const closeServer: Array<() => void> = [];
  const closeClient: Array<() => void> = [];
  let closed = false;
  const clone = <T>(value: T): T => structuredClone(value);

  return {
    server: {
      send: (frame) => {
        if (!closed) for (const handler of toClient) queueMicrotask(() => handler(clone(frame)));
      },
      onFrame: (handler) => void toServer.push(handler),
      onClose: (handler) => void closeServer.push(handler),
      close: () => {
        if (closed) return;
        closed = true;
        for (const handler of [...closeServer, ...closeClient]) queueMicrotask(handler);
      },
    },
    client: {
      send: (frame) => {
        if (!closed) for (const handler of toServer) queueMicrotask(() => handler(clone(frame)));
      },
      onFrame: (handler) => void toClient.push(handler),
      onClose: (handler) => void closeClient.push(handler),
    },
  };
}
