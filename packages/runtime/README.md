# Axiom Runtime

Part of [Axiom](https://github.com/cynodia/axiom), an AI-native semantic web application
framework.

**Status: stable (1.0.0).** The public API and portable semantics follow the 1.x compatibility policy (`docs/COMPATIBILITY.md`, shipped in @cynodia/axiom).

The domain-independent runtime: the state store, expression evaluation, the mutation
engine, constraint checking, the semantic UI renderer and routing. It takes its whole
environment through a `HostEnvironment`, so it runs in a browser or headlessly.

The renderer reads presentation the compiler has already resolved and turns it into
semantic class names, landmark and heading elements, and formatted values. It writes no
styles and computes no lengths.

Main exports: `createAxiomRuntime`, `createBrowserHost`, `createMemoryHost`,
`RUNTIME_DIAGNOSTIC_CODES`, `formatValue`, `presentationClassList`.

## Installation

```bash
npm install @cynodia/axiom-runtime
```

Most applications should install the facade package instead, which re-exports this one:

```bash
npm install @cynodia/axiom
```


## Documentation

The canonical operational contract lives in the `docs/` directory of the
[`@cynodia/axiom`](https://www.npmjs.com/package/@cynodia/axiom) package, and in
[the repository](https://github.com/cynodia/axiom). Start with `docs/AGENT_REFERENCE.md`.

## License

MIT

Copyright (c) 2026 AskTech AS.
