# Presentation

Axiom 0.7.0-alpha.1. Presentation is **semantic UX intent**, expressed as data on a UI
node. It names roles, tokens and device classes. It never names a colour, a length, a media
query or a CSS property.

```text
Business behavior is semantic data.
UI structure is semantic data.
UX intent is semantic data.
CSS and DOM are renderer implementation detail.
```

## Four separated concerns

| | Describes | Lives in |
| --- | --- | --- |
| **UI semantics** | What exists and what it does — views, containers, text, repeats, forms, inputs, buttons. | The graph. See [`UI.md`](UI.md). |
| **Presentation semantics** | What it *means* and how it is organized — roles, layout, spacing, sizing, device classes. | The graph, as `UIBase.presentation`. |
| **Theme** | What those meanings look like — colours, type scale, spacing values, radii, breakpoints. | The graph, as `graph.theme`. |
| **Renderer** | How any of it reaches a screen. | The framework. Not addressable from the graph. |

0.5 added **no new UI node kinds**. A role on an existing node stays analyzable; a new node
kind would not.

## PRESENTATION NEVER AUTHORIZES BEHAVIOR

```text
hidden            ≠ forbidden
not rendered      ≠ prohibited
disabled-looking  ≠ prohibited
role: destructive ≠ a constraint
uxRole: whatever  ≠ a permission
```

Business enforcement belongs to exactly three places:

- `ActionDef` guards — refuse this invocation;
- `ConstraintDef` — refuse this state;
- `TransitionConstraintDef` — refuse this change.

A governed write is checked whether or not any control for it is visible. Hiding a button
is a clarity decision layered on a rule that already holds.

## Declaring intent

```ts
presentation: {
  role?, uxRole?, emphasis?, density?, textRole?, surface?, treatment?, icon?,
  accessibleLabel?, description?,
  layout?, sizing?, padding?, gap?,
  format?, control?,
  responsive?, rendererOverrides?,
}
```

Every field is optional. A graph with no presentation metadata at all MUST still render as
a usable application.

```ts
graph.addNode<ContainerNode>({
  id: ACTIONS,
  kind: 'container',
  children: [CANCEL, SAVE],
  presentation: {
    uxRole: 'action-group',
    responsive: { compact: { layout: 'vertical' } },
  },
});
```

`uxRole: 'action-group'` is high-information: it already implies a horizontal, wrapping,
centre-aligned, end-justified group. Annotate where intent differs from the default, not on
every node.

## Vocabulary

Closed sets, each exported as an array. **A token outside its set is a validation error**,
because a renderer cannot act on a value it does not know.

| Property | Values | Array |
| --- | --- | --- |
| `role` | `primary` `secondary` `tertiary` `destructive` `success` `warning` `informational` `muted` | `PRESENTATION_ROLES` |
| `uxRole` | `primary-action` `secondary-action` `destructive-action` `navigation-action` `form-section` `action-group` `navigation-group` `empty-state` `error-state` `warning-state` `success-state` `informational-state` `toolbar` `sidebar` `content-region` `header-region` `footer-region` | `UX_ROLES` |
| `emphasis` | `subtle` `normal` `strong` | `EMPHASIS_LEVELS` |
| `density` | `compact` `comfortable` `spacious` | `DENSITIES` |
| `textRole` | `body` `caption` `label` `heading` `title` `display` | `TEXT_ROLES` |
| `headingLevel` | `1` `2` `3` `4` `5` `6` `'none'` | `HEADING_LEVELS` |
| `surface` | `transparent` `base` `subtle` `raised` `inset` | `SURFACE_ROLES` |
| `treatment` | `plain` `badge` `pill` | `TREATMENTS` |
| `control` | `default` `switch` `checkbox` `radio-group` `select` `multiline` `stepper` | `CONTROL_VARIANTS` |
| `icon` | `add` `delete` `edit` `save` `close` `warning` `success` `error` `information` `navigation-back` `navigation-forward` `menu` `search` `refresh` `settings` `more` | `ICON_NAMES` |
| `layout.kind` | `vertical` `horizontal` `grid` `stack` | `LAYOUT_KINDS` |
| `gap`, `padding` | `none` `xsmall` `small` `medium` `large` `xlarge` | `SPACING_TOKENS` |
| `sizing.width`, `sizing.height` | `fit` `fill` `content` `narrow` `medium` `wide` | `SIZING_VALUES` |
| `sizing.minWidth`, `sizing.maxWidth` | `narrow` `medium` `wide` | `BOUNDED_SIZES` |
| `layout.align` | `start` `center` `end` `stretch` | `ALIGNMENTS` |
| `layout.justify` | the above plus `between` | `JUSTIFICATIONS` |
| device class | `compact` `regular` `wide` | `DEVICE_CLASSES` |
| `format.kind` | `text` `number` `currency` `percentage` `boolean` `date` `datetime` | `VALUE_FORMAT_KINDS` |

Two 0.2 spellings are still accepted and normalized: `role: 'danger'` → `destructive`,
`density: 'normal'` → `comfortable`.

### Layout

```ts
layout: 'horizontal'                                    // shorthand for { kind: 'horizontal' }
layout: { kind: 'horizontal', gap: 'medium', align: 'center', justify: 'between', wrap: true }
layout: { kind: 'grid', gap: 'medium', columns: { mode: 'adaptive', minimum: 'medium' } }
layout: { kind: 'grid', columns: 3 }
```

- `align` is across the layout direction, `justify` along it.
- `wrap` defaults to **`true`** for `horizontal` and `grid`, `false` otherwise. A row that cannot wrap is the most common way a layout becomes unusable on a narrow display, so refusing to wrap must be stated explicitly.
- `columns: { mode: 'adaptive', minimum }` means "as many columns of at least this width as fit". Prefer it to a fixed count.
- `stack` is a tight vertical column — the 0.2 meaning of `ContainerNode.layout: 'stack'`. It does **not** overlap children.

### Type scale and document outline

These are two decisions, and conflating them produces wrong document semantics.

| | Decides | Property |
| --- | --- | --- |
| **Type scale** | how large and heavy the text is drawn | `textRole` |
| **Outline** | whether it is a heading, and at which level | `headingLevel` |

```ts
// A dashboard statistic: drawn large, not a heading.
presentation: { textRole: 'display', headingLevel: 'none' }

// A section heading in ordinary body type.
presentation: { textRole: 'body', headingLevel: 2 }
```

Omitted, the level follows the text role — `display` → 1, `title` → 2, `heading` → 3,
everything else → `'none'`. That is the 0.5.0 mapping, kept so an application that declared
only text roles keeps its outline. **An explicit `headingLevel` always wins**, and
`TEXT_ROLE_HEADING_LEVELS` is the mapping as data.

The rendered element follows the resolved level: `1`…`6` become `<h1>`…`<h6>`, and `'none'`
is a `<span>` however large it is drawn.

### Sizing and spacing

```ts
sizing: { width: 'fill', maxWidth: 'wide' }
padding: 'medium'                              // all sides
padding: { horizontal: 'large', vertical: 'medium' }
gap: 'small'                                   // shorthand for layout.gap
```

- `fill` takes the available space, `content` sizes to its content, `fit` sizes to content but may shrink.
- `minWidth` wider than `maxWidth` is reported as `CONFLICTING_SIZING`.
- No canonical presentation names a measurement. `width: 437px` is not expressible.

## Resolution precedence

Six layers, lowest first:

```text
1. renderer defaults    a flat baseline that never depends on the node
2. application theme    Theme.defaults, applied application-wide
3. parent/inherited     density only
4. semantic inference   node kind, then UX role, then application semantics
5. node presentation    what the node itself declares
6. responsive override  per device class, on top of everything above
```

Every resolved property records which layer decided it, so the order is a tested property
rather than a claim:

```ts
agent.resolvePresentation(DELETE_BUTTON);
// { role: 'destructive', uxRole: 'destructive-action', density: 'comfortable', … ,
//   origins: { role: 'inferred', density: 'theme', 'layout.kind': 'inferred' } }
```

`PresentationOrigin` is one of `renderer-default` `theme` `inherited` `inferred` `node`
`responsive`.

### Control affordances come from the theme

An ordinary button needs a direction, an alignment, a gap and padding. None of that is
application intent, so none of it belongs on a node: it comes from `theme.buttons`.

```ts
buttons: {
  layout: 'horizontal',     // an icon sits beside its label, never above it
  gap: 'xsmall',
  align: 'center',
  justify: 'center',
  paddingScale: 1.15,       // relative to controls.paddingX
  iconPlacement: 'leading', // or 'trailing'
}
```

A button with a label, or an icon and a label, in any role, requires **zero** corrective
presentation. If you find yourself writing the same `layout` and `padding` on every button,
that is a theme change, not an application one.

Padding and gap tokens resolved to `none` emit no class at all, so a control's own metrics
are never overridden by the absence of a value.

### Inheritance

**`density` is the only property that inherits.** `INHERITED_PROPERTIES` is `['density']`.

Nothing else cascades: a container with `emphasis: 'strong'` does not make its subtree
bold. Density is taken from the parent only when the parent's own density was actually
decided by something; otherwise the child reports the same baseline origin its parent had.

## Semantic inference

Presentation is derived from what the application already says, rather than declared twice.
Inference runs in three ordered sub-steps, all reported as origin `inferred`.

### 1. From the node kind

| Kind | Implies |
| --- | --- |
| `view` | vertical, gap `large`, width `fill` |
| `container` | the direction from `ContainerNode.layout` (or vertical), width `fill` |
| `form` | vertical, gap `medium`, surface `raised`, padding `large`, width `fill` |
| `repeat` | vertical, gap `small`, width `fill` |
| `conditional` | vertical, gap `medium`, width `fill` |
| `field-display` | horizontal, gap `xsmall`, align `center`, wrapping, width `content` |
| `text` | width `content` |
| `input` | vertical, gap `xsmall`, width `fill` |
| `button` | role `secondary`, width `content`, and its internal arrangement from `theme.buttons` |

### 2. From the UX role

This is the semantic compression: one role carries a whole arrangement.

| `uxRole` | Implies |
| --- | --- |
| `primary-action` | role `primary`, emphasis `strong` |
| `secondary-action` | role `secondary` |
| `destructive-action` | role `destructive` |
| `navigation-action` | role `tertiary` |
| `toolbar` | horizontal, gap `small`, align `center`, wrapping, surface `base`, padding `small` |
| `action-group` | horizontal, gap `small`, align `center`, justify `end`, wrapping |
| `navigation-group` | horizontal, gap `small`, align `center`, wrapping |
| `form-section` | vertical, gap `small`, surface `transparent` |
| `content-region` | vertical, gap `large` |
| `header-region` | horizontal, gap `medium`, align `center`, justify `between`, surface `base`, padding |
| `footer-region` | horizontal, gap `medium`, align `center`, emphasis `subtle`, padding |
| `sidebar` | vertical, gap `small`, surface `subtle`, padding, `maxWidth: 'narrow'` |
| `empty-state` | vertical, centred, surface `subtle`, generous padding, emphasis `subtle` |
| `error-state` | role `destructive`, icon `error`, surface `inset`, horizontal, padding |
| `warning-state` `success-state` `informational-state` | the matching role and icon, same arrangement |

A UX role stays inspectable **as that role** — `agent.findNodesByUxRole('toolbar')` finds
it. Nothing is compiled into an opaque renderer component.

### 3. From the application semantics

| Situation | Inferred |
| --- | --- |
| A button whose `actionId` is its enclosing form's `submitActionId` | role `primary`, emphasis `strong`, uxRole `primary-action` |
| A button whose action declares `destructive: true`, **or** whose action contains a `remove` operation, **or** which declares `destructive` itself | role `destructive`, uxRole `destructive-action` |
| A `field-display` of a `boolean` field | `format: { kind: 'boolean' }` |
| A `field-display` of a `date` / `datetime` field | `format: { kind: 'date' }` / `{ kind: 'datetime' }` |

Destructive intent is decided **last**, so a destructive primary action is still
destructive — it keeps the emphasis and loses the accent colour.

```ts
graph.addNode<ActionDef>({ id: DELETE, kind: 'action', destructive: true, operations: [...] });
graph.addNode<ButtonNode>({ id: BUTTON, kind: 'button', label: 'Delete', actionId: DELETE });
// The button is presented as destructive. It declares no role at all.
```

### Overrides and conflicts

An explicit `presentation.role` always wins over inference. A contradiction is reported:

| Declared | Code |
| --- | --- |
| A destructive action presented as `success` or `informational` | `DESTRUCTIVE_ACTION_PRESENTED_AS_SUCCESS` |
| `uxRole: 'destructive-action'` on a button whose action declares no destructive intent | `PRESENTATION_SEMANTIC_CONFLICT` |
| The primary action presented as `muted` | `PRESENTATION_SEMANTIC_CONFLICT` |

All are warnings. None makes a graph invalid.

## Responsive behavior

Device classes, never pixels. The renderer owns the breakpoints
(`theme.responsive`).

```ts
presentation: {
  layout: { kind: 'horizontal', gap: 'large' },
  responsive: {
    compact: { layout: 'vertical', gap: 'small' },
    wide: { padding: 'xlarge' },
  },
}
```

A `ResponsiveOverride` may set `layout`, `sizing`, `padding`, `gap`, `density` and
`hidden`. Anything it omits keeps its resolved value, and a device class that is not
mentioned gets no override at all.

### Responsive defaults

The renderer behaves sensibly with no responsive configuration. On a compact viewport:

- horizontal groups wrap (unless the graph refused wrapping);
- fixed multi-column grids collapse to one column, and drop to two on a regular viewport;
- bounded widths (`narrow` `medium` `wide`) stop being bounded;
- controls and buttons go full width;
- a non-wrapping row scrolls inside itself rather than overflowing the page.

An agent should not have to design every breakpoint by hand. Declare a responsive override
only where the automatic behavior is wrong.

Validation warns about a layout that will not survive a narrow display:

| Situation | Code |
| --- | --- |
| Explicit `wrap: false`, horizontal, 3+ children, no `compact` override | `RIGID_HORIZONTAL_LAYOUT` |
| More than 5 controls side by side | `EXCESSIVE_HORIZONTAL_ACTIONS` |

## Value formatting

Formatting is presentation. The stored value never changes, and there is no way to supply a
function.

```ts
{ kind: 'text' }
{ kind: 'number', decimals?, grouping? }
{ kind: 'currency', currency, decimals? }              // 1250 → "NOK 1,250.00"
{ kind: 'percentage', decimals?, scale?: 'fraction' | 'percent' }   // 0.421 → "42.1%"
{ kind: 'boolean', trueLabel?, falseLabel? }           // true → "Read"
{ kind: 'date', style?: 'short' | 'medium' | 'long' }
{ kind: 'datetime', style? }
```

- `currency` MUST name a currency.
- `percentage` treats the value as a fraction unless `scale: 'percent'`.
- `boolean` defaults to `Yes` / `No`.
- The locale comes from `theme.locale`.
- A value the format cannot describe falls back to its plain text form rather than inventing a plausible result.
- `treatment: 'badge'` or `'pill'` renders a formatted value as a chip rather than bare words.

**Never store a formatted string in canonical state.** `unitPrice` is `1250`, not
`"NOK 1,250.00"`.

## Theme

A theme is the one place concrete values belong. It is plain serializable data — no
callbacks anywhere in it, so a complete application including its visual identity is JSON.

```ts
graph.setTheme({ appearance: 'dark', defaults: { density: 'compact' }, spacing: { medium: 8 } });
```

Declare only what differs; the rest comes from `DEFAULT_THEME` via `resolveTheme`.

```ts
interface Theme {
  id; name;
  appearance: 'light' | 'dark' | 'system';
  locale: string;
  defaults: { density, emphasis, textRole, surface, gap, padding };   // precedence layer 2
  typography: { fontFamily, headingFamily?, monoFamily, roles, emphasis };
  spacing: Record<SpacingToken, number>;
  radius: Record<RadiusToken, number>;
  sizes: Record<BoundedSize, number>;
  surfaces: Record<SurfaceRole, { color, border, elevation, radius }>;
  controls: { height, paddingX, radius, borderWidth, focusWidth };
  density: Record<Density, { scale: number }>;
  colors: { light: SemanticColorSet; dark: SemanticColorSet };
  responsive: { compact: { maxWidth }, regular: { minWidth, maxWidth }, wide: { minWidth } };
  icons: Record<IconName, string>;
}
```

`SemanticColorSet` is role-based: `background` `surface` `elevated` `inset` `text`
`textMuted` `border` `accent` `destructive` `warning` `success` `informational` `muted`
`focus`, each filled role paired with the text colour drawn on it (`accentText`,
`destructiveText`, …) so contrast is a theme decision rather than a renderer guess.
`SEMANTIC_COLOR_ROLES` enumerates them. Application nodes never reference a colour.

`DEFAULT_THEME` is neutral, modern, accessible and responsive. `COMPACT_DARK_THEME` is a
second identity for the same graphs.

### A theme cannot change behaviour

Changing the theme MUST NOT alter actions, constraints, transition constraints, locations,
state or routing. This is what makes an application-wide visual change one operation:

```ts
// "Use a denser enterprise identity" — one change, not fifty node edits.
agent.transact((tx) => tx.setTheme({ defaults: { density: 'compact' }, spacing: { medium: 8 } }));
```

Reach for the theme whenever the change is application-wide. Reach for node presentation
only when *this* node differs from the rest.

### Light and dark

`appearance: 'light' | 'dark' | 'system'` needs no second graph. Presentation intent is
unchanged; `role: 'destructive'` renders appropriately in both. `compileToHtml(graph, {
appearance })` pins the emitted page, and a host may set `data-axiom-appearance` on the
document.

## Accessibility

Semantic roles produce accessible structure, so the two cannot drift apart.

| Declared | Rendered as |
| --- | --- |
| `uxRole: 'header-region'` | `<header>` |
| `uxRole: 'navigation-group'` | `<nav>` |
| `uxRole: 'content-region'` | `<main>` |
| `uxRole: 'footer-region'` | `<footer>` |
| `uxRole: 'sidebar'` | `<aside>` |
| `uxRole: 'form-section'` | `<section>` |
| `uxRole: 'toolbar'` | `role="toolbar"` |
| `uxRole: 'error-state'` | `role="alert"` |
| `uxRole: 'warning-state'` / `success-state` / `informational-state` | `role="status"` |
| `headingLevel: 1`…`6` | `<h1>`…`<h6>` |
| `headingLevel: 'none'` | `<span>`, whatever the type scale |

Also automatic:

- An input's label names its control by id; `presentation.accessibleLabel` becomes `aria-label` where there is no visible label.
- `aria-required` is derived from the **model** — the `required` flag of the field the location addresses.
- `presentation.description` becomes help text related with `aria-describedby`.
- A refused write marks the control `aria-invalid` and announces the reason next to it.
- An icon is `aria-hidden`; an icon-only control needs `accessibleLabel`.

Also automatic, per render instance rather than per node, so nothing leaks between repeated
rows: element ids, `for`, `aria-describedby` and `aria-invalid`. See
[`UI.md`](UI.md#render-instances).

Validation reports only what it can determine reliably:
`FORM_INPUT_MISSING_LABEL`, `INTERACTIVE_ELEMENT_MISSING_LABEL`,
`INVALID_HEADING_STRUCTURE`, `DESTRUCTIVE_ACTION_UNMARKED`.

## Renderer independence

`ApplicationIR.presentation` carries resolved presentation as **roles, tokens and device
classes** — never CSS. That is what keeps a second renderer possible; there is a test
asserting no colour, length or CSS property appears in it.

The web renderer is one implementation:

- `createThemeStylesheet(theme)` produces CSS custom properties and rules from theme data.
- The runtime emits semantic class names (`axiom-role-destructive`, `axiom-layout-horizontal`, `axiom-compact-layout-vertical`) and no inline styles.
- `layout: vertical`, `role: primary`, `surface: raised` are equally meaningful to a native, signage or terminal renderer, even if the output differs completely.

## UX findings

Presentation validation answers questions a stylesheet could never answer. All of these are
**warnings**; none stops an application from compiling.

```text
MULTIPLE_PRIMARY_ACTIONS                 FORM_WITHOUT_PRIMARY_ACTION
DESTRUCTIVE_ACTION_PRESENTED_AS_SUCCESS  DESTRUCTIVE_ACTION_UNMARKED
EMPTY_STATE_WITHOUT_RECOVERY_ACTION      EXCESSIVE_HORIZONTAL_ACTIONS
RIGID_HORIZONTAL_LAYOUT                  CONFLICTING_SIZING
PRESENTATION_SEMANTIC_CONFLICT           INTERACTIVE_ELEMENT_MISSING_LABEL
FORM_INPUT_MISSING_LABEL                 INVALID_HEADING_STRUCTURE
OPAQUE_PRESENTATION
```

Only `UNKNOWN_PRESENTATION_TOKEN` is an error.

And it is queryable — see [`AGENT_API.md`](AGENT_API.md#presentation-and-ux-queries).

## The escape hatch

`rendererOverrides` attaches renderer-specific presentation, and is explicitly the thing
semantic analysis does not understand.

```ts
presentation: { rendererOverrides: { web: { className: 'legacy-panel' } } }
```

- It is keyed by renderer.
- It makes the node `opaque` in resolved presentation.
- It reports `OPAQUE_PRESENTATION`, and `AgentAPI.getOpaquePresentationNodes()` lists every node using it.
- There is **no raw-CSS channel** in the graph. The web renderer attaches the class name and nothing else.
- Ordinary applications need none of it, and the acceptance fixtures use none.

## Invalid usage

```ts
// WRONG — recreating CSS.
presentation: { style: { display: 'flex', gap: '12px', color: '#c00' } }

// RIGHT
presentation: { layout: { kind: 'horizontal', gap: 'medium' }, role: 'destructive' }
```

```ts
// WRONG — a formatted string in canonical state.
{ [F_UNIT_PRICE]: 'NOK 1,250.00' }

// RIGHT — the value stays a number; the display is formatted.
{ [F_UNIT_PRICE]: 1250 }
presentation: { format: { kind: 'currency', currency: 'NOK' } }
```

```ts
// WRONG — presentation used as a permission.
presentation: { responsive: { compact: { hidden: true } } }   // "so nobody can edit it on mobile"

// RIGHT — a rule that holds on every path.
{ kind: 'transition-constraint', entityId: ENTITY_ORDER, … }
```

```ts
// WRONG — the same intent restated on fifty nodes.
presentation: { density: 'compact' }   // × 50

// RIGHT — one theme change.
graph.setTheme({ defaults: { density: 'compact' } });
```
