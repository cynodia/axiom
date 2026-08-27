# Instructions for AI coding agents

You are consuming **Axiom** as an application framework. This file is routing only; the
contract lives in `docs/`.

## Read this first

**Read [`docs/AGENT_REFERENCE.md`](docs/AGENT_REFERENCE.md), in full, before writing any
application code.** It is the compressed operational contract for application authors and it
ships inside this package.

Then escalate in this order, and only as far as the question requires:

1. **`docs/AGENT_REFERENCE.md`** — the contract. Start here, every time.
2. **The `.d.ts` declarations in `dist/`** — the API contract. Signatures, unions and
   branded types are authoritative there.
3. **The focused document in `docs/`** for the topic — the full contract for one area. See
   the map in [`README.md`](README.md#documentation-map).
4. **A minimal public-API probe** — build the smallest graph that isolates the question,
   call `validateGraph` and read the returned codes. Diagnostics are structured and name
   what is wrong.

Only if all four leave the question open is reading framework implementation source
justified. That is framework debugging, not application authoring.

## Do not

- **Do not clone or reverse-engineer the Axiom repository to learn normal usage.** Everything
  needed to author an application is in this package. There is no published Axiom CLI.
- **Do not search the web or scrape npm for documentation.** This package is the primary
  source, and it describes this exact version.
- **Do not read, edit or patch generated output.** The emitted JavaScript, HTML and CSS are
  build products. Nothing is authored there.
- **Do not guess the API from React, Vue, Angular, Svelte or Express conventions.** Axiom has
  no component, no hook, no JSX, no route handler, no ORM and no callback anywhere in the
  graph. Guessing from those conventions produces graphs `validateGraph` rejects.
- **Do not reach for an escape hatch.** There is no `formatter: fn`, no `validator: fn`, no
  raw-CSS channel and no stored closure. If a capability seems missing, it is expressed as a
  graph node; look it up rather than working around it.

## Prefer canonical Axiom semantics

Each row is a pointer, not the rule. The rule itself lives in
[`docs/AGENT_REFERENCE.md`](docs/AGENT_REFERENCE.md) and in the topic document; read it
there rather than treating this table as a specification.

| Instead of | Use |
| --- | --- |
| Mutating an object an expression returned | A `Location`, addressing the writable position |
| A field name key in a record | The `FieldId` — runtime records are keyed by field id |
| A hand-written validation function | A `ConstraintDef` or `TransitionConstraintDef` |
| A hidden control to forbid an operation | A guard or a transition constraint. `hidden` is not `forbidden` |
| CSS, a colour or a length | A presentation role or token, and a `Theme` |
| A route handler, controller or SQL statement | `StateDef.authority` plus an `ActionDef` |
| A callback for new capability | The graph node that expresses it |

## When something fails

`validateGraph` and the runtime both report structured diagnostics with a code and a path.
Match on the code, never on the message, and look the code up:
[`docs/VALIDATION.md`](docs/VALIDATION.md) for authoring-time codes,
[`docs/RUNTIME.md`](docs/RUNTIME.md) for runtime codes. A construct that validates and then
does nothing is a framework defect, not something to work around — report it.

Mistakes that compile but are wrong are collected in
[`docs/ANTI_PATTERNS.md`](docs/ANTI_PATTERNS.md). Read it before the **first** attempt, not the
second: collection nulls, how a `repeat` binds its current item, and addressing a collection
member by identity rather than index all shape a first draft rather than repairing it.
