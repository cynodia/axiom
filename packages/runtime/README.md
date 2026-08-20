# Axiom Runtime

Part of [Axiom](https://github.com/cynodia/axiom), an AI-native semantic web application
framework.

**Status: experimental / alpha.** The API may change between alpha releases.

The domain-independent runtime: the state store, expression evaluation, the mutation
engine, constraint checking, the semantic UI renderer and routing. It takes its whole
environment through a `HostEnvironment`, so it runs in a browser or headlessly.

## Installation

```bash
npm install @cynodia/axiom-runtime@alpha
```

Most applications should install the facade package instead, which re-exports this one:

```bash
npm install @cynodia/axiom@alpha
```

## License

MIT

Copyright (c) 2026 AskTech AS.
