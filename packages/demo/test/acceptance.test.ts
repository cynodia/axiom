import assert from 'node:assert/strict';
import test from 'node:test';
import { field, optionalType, primitiveType, ref } from '@axiom/core';
import type { ActionDef, EntityDef, FieldDisplayNode, FieldId, InputNode, NodeId } from '@axiom/core';
import { AgentAPI } from '@axiom/agent-api';
import { compileToIR } from '@axiom/compiler';
import { createAxiomRuntime, createMemoryHost, findByNodeId, textOf } from '@axiom/runtime';
import type { MemoryElement, MemoryHostOptions } from '@axiom/runtime';
import { createIssueTrackerGraph, issueTrackerIds } from '@axiom/demo/issue-tracker';
import { createInventoryGraph, inventoryIds } from '@axiom/demo/inventory';
import type { ApplicationGraph } from '@axiom/core';

function run(graph: ApplicationGraph, options: MemoryHostOptions = {}) {
  const host = createMemoryHost({ path: '/', ...options });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();
  return { app, host };
}

function control(root: MemoryElement, id: NodeId): MemoryElement {
  const found = findByNodeId(root, id).find((element) => element.tagName !== 'label');
  assert.ok(found, `no control rendered for ${id}`);
  return found;
}

/**
 * Section 45 — the canonical demonstration. An agent adds a field, makes it editable
 * where the entity is edited and visible where a single record is shown, then commits.
 * Every step is a graph query or a graph transformation: no JavaScript, HTML, compiler
 * or runtime source is touched, and nothing is located by searching text.
 */
test('an agent adds a field and its UI through graph operations alone', () => {
  const graph = createIssueTrackerGraph();
  const agent = new AgentAPI(graph);

  // 1. Locate the entity semantically.
  const entity = graph.getNodesByKind('entity').find((candidate) => candidate.name === 'Issue');
  assert.ok(entity, 'the entity is found in the graph, not in a source file');

  const singleRecordStates = new Set(graph.getNodesByKind('state').map((state) => state.id));
  let addedFieldId = '' as FieldId;

  const outcome = agent.transact(
    (transaction) => {
      // 2-4. Add the field with a stable id and a structured type.
      const fieldId = transaction.addField(entity.id, {
        name: 'Reporter contact',
        valueType: optionalType(primitiveType('string')),
      });
      addedFieldId = fieldId;

      // 5-6. Wherever the entity is edited, add an input bound to the new field.
      for (const form of agent.getFormsForEntity(entity.id)) {
        transaction.bindField({
          parentId: form.id,
          target: form.target,
          fieldId,
          label: 'Reporter contact',
        });
        // A form that submits a record must also carry the field into the new instance.
        if (form.submitActionId) {
          transaction.addFieldToConstructors(entity.id, fieldId, field(form.target, fieldId));
        }
      }

      // Inputs that edit one record directly (rather than a repeated row) share a parent.
      // Each parent keeps its own binding target: a draft here, the selected record there.
      const editors = new Map<NodeId, InputNode['binding']['target']>();
      for (const node of agent
        .getUiNodesForEntity(entity.id)
        .filter((candidate): candidate is InputNode => candidate.kind === 'input')
        .filter(
          (candidate) =>
            candidate.binding.target.kind === 'ref' && singleRecordStates.has(candidate.binding.target.targetId),
        )) {
        for (const parent of agent.getDependents(node.id, ['contains'])) {
          if (!editors.has(parent.id)) {
            editors.set(parent.id, node.binding.target);
          }
        }
      }
      for (const form of agent.getFormsForEntity(entity.id)) {
        editors.delete(form.id);
      }
      for (const [parentId, target] of editors) {
        transaction.bindField({ parentId, target, fieldId, label: 'Reporter contact' });
      }

      // 7-8. Wherever a single record is displayed, add a read-only display too.
      const detailParents = new Map<NodeId, FieldDisplayNode['source']>();
      for (const node of agent
        .getUiNodesForEntity(entity.id)
        .filter((candidate): candidate is FieldDisplayNode => candidate.kind === 'field-display')
        .filter((candidate) => candidate.source.kind === 'ref' && singleRecordStates.has(candidate.source.targetId))) {
        for (const parent of agent.getDependents(node.id, ['contains'])) {
          if (!detailParents.has(parent.id)) {
            detailParents.set(parent.id, node.source);
          }
        }
      }
      for (const [parentId, source] of detailParents) {
        transaction.displayField({ parentId, source, fieldId, label: 'Reporter contact' });
      }
    },
    // 9-10. Validation and commit are part of the transaction.
    { reason: 'Record how to contact the reporter', actor: 'agent' },
  );

  assert.equal(outcome.committed, true, JSON.stringify(outcome.result.errors, null, 2));
  assert.equal(agent.validate().valid, true);

  const updated = graph.getNode<EntityDef>(entity.id);
  assert.ok(updated?.fields.some((entry) => entry.id === addedFieldId));

  // The application immediately renders and supports the new field.
  const created = run(graph, { path: '/issues/new' });
  const newInputs = agent
    .getUiNodesForEntity(entity.id)
    .filter((node): node is InputNode => node.kind === 'input' && node.binding.fieldId === addedFieldId);
  assert.equal(newInputs.length, 2, 'one input in the create form, one where a record is edited');

  const renderedInput = (root: MemoryElement): MemoryElement | undefined =>
    newInputs
      .flatMap((node) => findByNodeId(root, node.id))
      .find((element) => element.tagName !== 'label');

  const createInput = renderedInput(created.host.root);
  assert.ok(createInput, 'the new input renders in the create form');
  createInput.value = 'reporter@example.test';
  createInput.dispatch('input');

  control(created.host.root, 'ui_create_title_input' as NodeId).value = 'Contactable report';
  control(created.host.root, 'ui_create_title_input' as NodeId).dispatch('input');
  findByNodeId(created.host.root, issueTrackerIds.UI_CREATE_FORM)[0].dispatch('submit');

  const stored = created.app.getState(issueTrackerIds.STATE_ISSUES) as Array<Record<string, unknown>>;
  assert.equal(
    stored[0][addedFieldId],
    'reporter@example.test',
    'the create action now carries the new field into the record it builds',
  );

  // The detail view shows the new field for an existing record.
  const detail = run(graph, { path: '/issues/issue-1' });
  const detailInput = renderedInput(detail.host.root);
  assert.ok(detailInput, 'the new input also renders where a single record is edited');
  detailInput.value = '+47 555 0100';
  detailInput.dispatch('input');

  const records = detail.app.getState(issueTrackerIds.STATE_ISSUES) as Array<Record<string, unknown>>;
  assert.equal(records[0][addedFieldId], '+47 555 0100', 'editing writes through to the record');
  assert.match(textOf(detail.host.root), /Reporter contact/);
  assert.match(textOf(detail.host.root), /\+47 555 0100/);
});

/**
 * Section 46 — destructive actions are found by their semantics, never by looking for
 * words like "delete" in source text.
 */
test('an agent makes every destructive action require confirmation in one transaction', () => {
  const graph = createInventoryGraph();
  const agent = new AgentAPI(graph);

  // Set up an application that never declared confirmation.
  agent.transact((transaction) => {
    for (const action of transaction.findDestructiveActions()) {
      transaction.updateNode({ ...action, requiresConfirmation: false, confirmationMessage: undefined });
    }
  }, { reason: 'Start from an application without confirmations' });

  const destructive = agent.findDestructiveActions();
  assert.deepEqual(
    destructive.map((action) => action.name),
    ['deleteProduct'],
    'found through the remove-item operation it performs',
  );

  const before = run(graph, { path: '/products/product-1', confirm: false });
  before.app.invokeAction(inventoryIds.ACTION_DELETE_PRODUCT, {
    [inventoryIds.PARAM_DELETE_PRODUCT]: (before.app.getState(inventoryIds.STATE_PRODUCTS) as unknown[])[0],
  });
  assert.deepEqual(before.host.confirmations, [], 'nothing asks for confirmation yet');
  assert.equal((before.app.getState(inventoryIds.STATE_PRODUCTS) as unknown[]).length, 1);

  const outcome = agent.transact(
    (transaction) => {
      for (const action of transaction.findDestructiveActions()) {
        transaction.updateNode({
          ...action,
          destructive: true,
          requiresConfirmation: true,
          confirmationMessage: `Confirm ${action.name ?? action.id}. This cannot be undone.`,
        } as ActionDef);
      }
    },
    { reason: 'Require confirmation for destructive actions', actor: 'agent' },
  );

  assert.equal(outcome.committed, true);
  for (const action of agent.findDestructiveActions()) {
    assert.equal(action.requiresConfirmation, true);
  }

  const after = run(graph, { path: '/products/product-1', confirm: false });
  after.app.invokeAction(inventoryIds.ACTION_DELETE_PRODUCT, {
    [inventoryIds.PARAM_DELETE_PRODUCT]: (after.app.getState(inventoryIds.STATE_PRODUCTS) as unknown[])[0],
  });
  assert.equal(after.host.confirmations.length, 1, 'the same action now asks first');
  assert.equal(
    (after.app.getState(inventoryIds.STATE_PRODUCTS) as unknown[]).length,
    2,
    'declining leaves the data untouched',
  );
});
