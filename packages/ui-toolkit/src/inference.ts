import type {
  ActionDef,
  ApplicationGraph,
  EntityDef,
  FieldDef,
  FieldId,
  NodeId,
  StateDef,
  TypeRef,
  ValueFormat,
  ControlVariant,
} from '@cynodia/axiom-core';

/**
 * What the toolkit reads out of the graph instead of asking the author to restate it.
 *
 * The rule (§34): **infer what Axiom already knows; require only application-specific UX
 * choices.** Everything here is a read of an existing declaration — an entity's identity
 * field, a field's type, an action's `destructive` flag. Nothing here guesses from a *name*,
 * because a heuristic over names is precisely the kind of hidden rule that makes an agent's
 * output unpredictable.
 */

export function stateOf(graph: ApplicationGraph, id: NodeId): StateDef | undefined {
  const node = graph.getNode(id);
  return node?.kind === 'state' ? (node as StateDef) : undefined;
}

export function entityOf(graph: ApplicationGraph, id: NodeId): EntityDef | undefined {
  const node = graph.getNode(id);
  return node?.kind === 'entity' ? (node as EntityDef) : undefined;
}

export function actionOf(graph: ApplicationGraph, id: NodeId): ActionDef | undefined {
  const node = graph.getNode(id);
  return node?.kind === 'action' ? (node as ActionDef) : undefined;
}

/** The entity a collection state holds, if it holds one. */
export function memberEntityId(valueType: TypeRef): NodeId | undefined {
  if (valueType.kind === 'collection') {
    return memberEntityId(valueType.itemType) ?? undefined;
  }
  if (valueType.kind === 'optional') {
    return memberEntityId(valueType.valueType);
  }
  return valueType.kind === 'entity' ? valueType.entityId : undefined;
}

export function isCollection(valueType: TypeRef): boolean {
  return valueType.kind === 'collection' || (valueType.kind === 'optional' && isCollection(valueType.valueType));
}

export function fieldOf(entity: EntityDef, fieldId: FieldId): FieldDef | undefined {
  return entity.fields.find((field) => field.id === fieldId);
}

/** Unwraps `optional` so a nullable number is still a number for presentation purposes. */
export function baseType(valueType: TypeRef): TypeRef {
  return valueType.kind === 'optional' ? baseType(valueType.valueType) : valueType;
}

/**
 * A value format from a declared type.
 *
 * Deliberately conservative: it never infers `currency` or `percentage`, because nothing in
 * a `number` says which — that is an application-specific UX choice and stays explicit.
 * Guessing from a field named `price` is exactly the hidden heuristic §35 warns about.
 */
export function formatFor(valueType: TypeRef): ValueFormat | undefined {
  const base = baseType(valueType);
  if (base.kind !== 'primitive') {
    return undefined;
  }
  switch (base.primitive) {
    case 'number':
      return { kind: 'number' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'date':
      return { kind: 'date' };
    case 'datetime':
      return { kind: 'datetime' };
    default:
      return undefined;
  }
}

/** A control from a declared type. Absent means "let the runtime decide", which it can. */
export function controlFor(valueType: TypeRef): ControlVariant | undefined {
  const base = baseType(valueType);
  if (base.kind === 'enum') {
    return 'select';
  }
  if (base.kind !== 'primitive') {
    return undefined;
  }
  return base.primitive === 'boolean' ? 'checkbox' : base.primitive === 'number' ? 'stepper' : undefined;
}

/**
 * A human label for a field.
 *
 * `name` is metadata authors already write, so the toolkit uses it and falls back to the id
 * only when there is nothing else. It does **not** prettify an id into title case: a label
 * invented from an identifier is a guess presented as a fact.
 */
export function labelFor(field: FieldDef): string | undefined {
  return field.name;
}

/** Fields worth showing in a list when the author names none: every field but the identity. */
export function defaultListFields(entity: EntityDef): FieldId[] {
  return entity.fields.filter((field) => field.id !== entity.identityFieldId).map((field) => field.id);
}

/**
 * Fields worth editing when the author names none.
 *
 * A create form offers **every** field, identity included; an edit form omits the identity,
 * because an instance's identity is what addresses it and is not a thing to retype.
 *
 * Phase 1 had one rule for both and chose "omit the identity", by analogy with the list. That
 * was wrong for creation, and wrong in the dangerous direction: the form rendered, validated,
 * and then refused every submission for a value the author could not see was missing. Which
 * mode a form is in cannot be inferred from a draft state, so it is declared — and the
 * default is the one whose mistake is visible.
 */
export function defaultFormFields(entity: EntityDef, mode: 'create' | 'edit' = 'create'): FieldId[] {
  return mode === 'edit' ? defaultListFields(entity) : entity.fields.map((field) => field.id);
}

/** The UX role an action's own semantics imply. */
export function roleForAction(action: ActionDef, isPrimary: boolean): 'primary-action' | 'secondary-action' | 'destructive-action' {
  if (action.destructive) {
    return 'destructive-action';
  }
  return isPrimary ? 'primary-action' : 'secondary-action';
}
