# Axiom Core

Part of [Axiom](https://github.com/cynodia/axiom), an AI-native semantic web application
framework.

**Status: experimental / alpha.** The API may change between alpha releases.

The Application Graph and its semantic model: nodes, fields, structured types,
expressions, **locations** (addressable writable positions), edge derivation, validation
and type inference. It also owns the presentation and UX layer — semantic roles, layout and
spacing tokens, device classes, value formats and the `Theme` — with presentation
resolution and validation. As of 0.8 it also owns the vocabulary for external
integrations, effects, triggers and events: `IntegrationDef`, `IntegrationOperationDef`,
`EventDef`, `TriggerDef`, and the `integration-query`/`integration-effect` operation
kinds — see [`docs/INTEGRATIONS.md`](https://github.com/cynodia/axiom/blob/main/docs/INTEGRATIONS.md).

Presentation lives here because it is part of the canonical graph: it is intent, not
styling, and it names no colour, length or CSS property.

Main exports: `ApplicationGraph`, `TypeRef` builders, expression builders, `Location`
builders, `Presentation`, `Theme`, `resolvePresentationMap`, `validateGraph`,
`VALIDATION_CODES`, `ApplicationIR`, `ServerIR`, `IntegrationDef`, `IntegrationOperationDef`,
`EventDef`, `TriggerDef`.

## Installation

```bash
npm install @cynodia/axiom-core
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
