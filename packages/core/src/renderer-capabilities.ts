import type { UINodeKind } from './ui.js';

/**
 * What a renderer can actually draw.
 *
 * Axiom's rule is that a construct which is publicly declared, typechecks and passes
 * `validateGraph` must have defined runtime behaviour — and until now a UI node kind escaped
 * it. Adding a kind to `UI_NODE_KINDS` produced no compile error, no validation error and no
 * failing semantic test; the failure surfaced only when a browser tried to render the node and
 * got `UNSUPPORTED_UI_NODE` back. That is a runtime discovery of an authoring mistake, which
 * is exactly the shape of failure the framework forbids.
 *
 * A capability set closes it: validation is told which kinds the intended target can render,
 * and rejects a graph containing anything else. A renderer that grows a new kind publishes it
 * here; a renderer that has not implemented one cannot silently accept it.
 */
export interface RendererCapabilities {
  /** Names the renderer, so a diagnostic can say which target refused. */
  target: string;
  supportedUiKinds: readonly UINodeKind[];
}

/**
 * Every kind, for a caller that does not know or care about a target.
 *
 * `validateGraph` uses this when no capabilities are given, so a graph is never rejected for
 * a target nobody named. Compiling for a real renderer supplies the real set.
 */
export const ALL_UI_KINDS_SUPPORTED: RendererCapabilities = {
  target: 'any',
  supportedUiKinds: [
    'view',
    'container',
    'text',
    'repeat',
    'field-display',
    'form',
    'input',
    'button',
    'conditional',
    'diagnostic',
  ],
};
