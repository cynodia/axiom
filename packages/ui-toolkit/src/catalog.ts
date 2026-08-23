import type { PatternDefinition, PatternInput } from './pattern.js';
import type { Toolkit } from './expand.js';

/**
 * The machine-readable catalogue.
 *
 * The thesis under test (§48): for an agent, a queryable schema is worth more than prose. An
 * agent that can ask what a pattern requires does not have to read the implementation, guess
 * from an example, or discover a required input by causing a failure.
 */
export interface PatternDescription {
  name: string;
  purpose: string;
  required: string[];
  optional: string[];
  inputs: Record<string, PatternInput>;
  slots: readonly string[];
  produces: readonly string[];
  /** The generated tree, part by part. Ids are `ui_<instance>_<part>`. */
  expansion: readonly { part: string; kind: string; role: string }[];
  /** How a generated id is built, so an author can reference one before it exists. */
  generatedIdFormat: string;
  /** What the pattern works out for itself, and from what. */
  inferred: Record<string, string>;
}

export function listPatterns(toolkit: Toolkit): string[] {
  return [...toolkit.patterns.keys()].sort();
}

export function describePattern(toolkit: Toolkit, name: string): PatternDescription | undefined {
  const definition = toolkit.patterns.get(name) as PatternDefinition<never> | undefined;
  if (!definition) {
    return undefined;
  }
  const entries = Object.entries(definition.inputs);
  return {
    name: definition.name,
    purpose: definition.purpose,
    required: entries.filter(([, input]) => input.required).map(([key]) => key),
    optional: entries.filter(([, input]) => !input.required).map(([key]) => key),
    inputs: definition.inputs,
    slots: definition.slots,
    produces: definition.produces,
    expansion: definition.expansion,
    generatedIdFormat: 'ui_<instance>_<part>, or ui_<instance>_<part>_<index> for a repeated part',
    inferred: Object.fromEntries(
      entries
        .filter(([, input]) => input.inferredWhenAbsent !== undefined)
        .map(([key, input]) => [key, input.inferredWhenAbsent as string]),
    ),
  };
}

export function describeToolkit(toolkit: Toolkit): PatternDescription[] {
  return listPatterns(toolkit)
    .map((name) => describePattern(toolkit, name))
    .filter((entry): entry is PatternDescription => entry !== undefined);
}
