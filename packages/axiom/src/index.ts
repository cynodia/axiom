/**
 * Axiom — the public entry point for application authors.
 *
 * An Axiom application is a typed semantic graph. This package re-exports everything
 * needed to define one, validate it, compile it and run it:
 *
 * - `@cynodia/axiom-core` — the graph, semantic types, locations and validation.
 * - `@cynodia/axiom-compiler` — normalization into an IR and page emission.
 * - `@cynodia/axiom-runtime` — the generic runtime that executes an application.
 * - `@cynodia/axiom-agent-api` — semantic queries and transactional transformations.
 *
 * Installing the individual packages instead is supported but rarely necessary.
 */
export * from '@cynodia/axiom-core';
export * from '@cynodia/axiom-runtime';
export * from '@cynodia/axiom-compiler';
export * from '@cynodia/axiom-agent-api';
