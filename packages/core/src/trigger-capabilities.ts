import type { TriggerKind } from './triggers.js';
import { TRIGGER_KINDS } from './triggers.js';

/**
 * What a trigger runtime can actually execute, for client-authority triggers.
 *
 * A server-authority trigger always executes on the authority, which implements every
 * kind, so this only ever gates client-authority triggers — the ones a compiled client IR
 * would otherwise have to execute itself. Before spec 8.1, a client-authority `interval`/
 * `delay`/`lifecycle` trigger validated, compiled into `ApplicationIR.triggers`, and then
 * silently never fired: no client runtime implemented any trigger kind at all. That is
 * exactly the "publicly declared, typechecks, passes validation, has no defined runtime
 * behaviour" shape the framework forbids — the same gap `RendererCapabilities` closed for
 * UI node kinds.
 *
 * A trigger runtime that implements a kind publishes it here; one that has not cannot
 * silently accept it.
 */
export interface TriggerRuntimeCapabilities {
  /** Names the runtime, so a diagnostic can say which target refused. */
  target: string;
  supportedTriggerKinds: readonly TriggerKind[];
}

/**
 * Every kind, for a caller that does not know or care about a target — validation is never
 * rejected for a trigger runtime nobody named. Compiling for a real target supplies the
 * real set.
 */
export const ALL_TRIGGER_KINDS_SUPPORTED: TriggerRuntimeCapabilities = {
  target: 'any',
  supportedTriggerKinds: TRIGGER_KINDS,
};
