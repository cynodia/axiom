# Axiom Compiler

Part of [Axiom](https://github.com/cynodia/axiom), an AI-native semantic web application
framework.

**Status: experimental / alpha.** The API may change between alpha releases.

Validates an Application Graph, normalizes it into a runtime-ready IR, and emits a
self-contained HTML page with the runtime inlined.

Normalization resolves presentation once — renderer defaults, theme, inheritance, semantic
inference, node declarations and responsive overrides — and puts the result in the IR, still
as roles and tokens rather than CSS. `createThemeStylesheet` is the web renderer's
translation of a theme into CSS custom properties and rules, and is the only place in the
framework that decides a role is a colour.

Main exports: `compileToIR`, `compileToHtml`, `createThemeStylesheet`,
`GraphValidationError`.

## Installation

```bash
npm install @cynodia/axiom-compiler@alpha
```

Most applications should install the facade package instead, which re-exports this one:

```bash
npm install @cynodia/axiom@alpha
```


## Documentation

The canonical operational contract lives in the `docs/` directory of the
[`@cynodia/axiom`](https://www.npmjs.com/package/@cynodia/axiom) package, and in
[the repository](https://github.com/cynodia/axiom). Start with `docs/AGENT_REFERENCE.md`.

## License

MIT

Copyright (c) 2026 AskTech AS.
