# Axiom Core

Part of [Axiom](https://github.com/cynodia/axiom), an AI-native semantic web application
framework.

**Status: experimental / alpha.** The API may change between alpha releases.

The Application Graph and its semantic model: nodes, fields, structured types,
expressions, **locations** (addressable writable positions), edge derivation,
validation and type inference.

It also owns the presentation and UX layer — semantic roles, layout, spacing and sizing
tokens, device classes, value formats and the `Theme` — together with presentation
resolution and validation. Presentation lives here because it is part of the canonical
graph: it is intent, not styling, and it names no colour, length or CSS property.

## Installation

```bash
npm install @cynodia/axiom-core@alpha
```

Most applications should install the facade package instead, which re-exports this one:

```bash
npm install @cynodia/axiom@alpha
```

## License

MIT

Copyright (c) 2026 AskTech AS.
