import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalPilotRequest, createPilotPlan, runPilot } from '../../scripts/assistant-quality-pilot.mjs';
import { runPilotPipeline } from '../../scripts/assistant-quality-pilot-pipeline.mjs';
import { pilotGraphSnapshot } from '../../scripts/assistant-quality-pilot-graph.mjs';

const source = 'classes: { object: { shape: rectangle } }\nobject: Example {\n  class: object\n  Notes: |md\n    A card.\n  |\n}\n';
const spec = { version: 1, params: {}, steps: [], authoring: { version: 1,
  assistant: { promptContractVersion: 4, objectFlowIntent: { blocks: [{ id: 'example', name: 'Objects', description: 'Select objects.' }] },
    diagramIntentPrompt: 'Show objects.' }, d2: { source } } };
const freeze = { dataHash: 'a'.repeat(64), catalogHash: 'b'.repeat(64), promptHash: 'c'.repeat(64), model: 'sandbox', modelRevision: 'fixture-v1' };
const limits = { maxModelRequests: 1, maxRows: 5, timeoutMs: 1000, traversalDepth: 2 };
const templateRef = { root: 'Cst_QueryTool', templateCode: 'Example', baseSpecHash: 'd'.repeat(64) };

test('frozen pilot schedules A/B for flow, includes exhausted jobs and does not expose the oracle', async () => {
  const options = { freeze, limits, scenarios: [{ id: 'case-example', split: 'holdout', dataKind: 'synthetic', modes: ['flow'],
    input: { spec, templateRef }, oracle: { outcome: 'accepted', rows: [{ blockId: 'example', values: { id: 'evaluator-private' } }] } }] };
  const plan = createPilotPlan(options);
  assert.equal(plan.jobs.length, 6);
  assert.equal(createPilotPlan(options).fingerprint, plan.fingerprint);
  assert.notEqual(createPilotPlan({ ...options, repeats: 2 }).fingerprint, plan.fingerprint);
  const report = await runPilot(plan, { evidence: 'offline-simulation', execute: ({ reserveModelRequest, ...input }) => {
    assert.doesNotMatch(JSON.stringify(input), /evaluator-private|oracle/);
    assert.throws(() => { reserveModelRequest(); reserveModelRequest(); }, /pilot_model_request_budget/);
    return { failure: 'pilot_fixture_failure' };
  } });
  assert.equal(report.attempts.length, 6);
  assert.equal(report.metrics.overall.failures, 1);
  assert.equal(report.metrics.overall.budgetSkipped, 5);
  assert.equal(report.metrics.overall.evaluated, 1);
  assert.equal(report.modelRequests, 1);
});

test('equal A/B executions do not show a gain when a repeat is stopped by the request budget', async () => {
  const plan = createPilotPlan({ freeze, limits: { ...limits, maxModelRequests: 3 }, repeats: 2,
    scenarios: [{ id: 'budget', split: 'holdout', dataKind: 'synthetic', modes: ['flow'],
      input: { spec, templateRef }, oracle: { outcome: 'accepted', rows: [] } }] });
  const report = await runPilot(plan, { evidence: 'offline-simulation', execute: ({ reserveModelRequest }) => {
    reserveModelRequest();
    reserveModelRequest();
    return { complete: true, stages: { flow: { status: 'accepted' }, rows: { status: 'accepted' } }, rows: [] };
  } });
  assert.equal(report.modelRequests, 3);
  assert.equal(report.attempts.length, 4);
  assert.equal(report.metrics.overall.exact, 1);
  assert.equal(report.metrics.overall.budgetSkipped, 3);
  assert.equal(report.metrics.overall.failures, 0);
  assert.equal(report.metrics.comparisons.length, 1);
  assert.equal(report.metrics.comparisons[0].status, 'incomplete');
  assert.equal(report.metrics.comparisons[0].reason, 'request_budget');
  assert.equal(Object.hasOwn(report.metrics.comparisons[0], 'exactRateDelta'), false);
});

test('semantic plan uses the same checkpoint and never inherits saved result fragments', async () => {
  let requests = 0, resumeId;
  const capture = await runPilotPipeline({ mode: 'flow', draft: spec, templateRef, blockIds: ['example'], maxRows: 5,
    reserveModelRequest: () => {}, request: async (path, request) => {
      assert.equal(path, '/assistant/object-flow/semantic-plan');
      assert.deepEqual(request.editorDelta.spec.result, { tables: [], diagrams: [] });
      assert.equal(request.editorDelta.spec.visualModels, null);
      assert.deepEqual(request.editorDelta.spec.steps, []);
      assert.equal(request.editorDelta.spec.authoring.d2, undefined);
      assert.equal(request.editorDelta.spec.authoring.assistant.diagramIntentPrompt, undefined);
      requests++;
      if (request.stage === 'context') {
        resumeId = request.resumeId;
        return { status: 202, json: { success: true, checkpoint: { resumeId } } };
      }
      assert.equal(request.resumeId, resumeId);
      return { status: 200, json: { success: true, semanticPlan: { blocks: [{ resultContract: { outputKind: 'unresolved' } }] } } };
    } });
  assert.equal(requests, 2);
  assert.equal(capture.stages.flow.status, 'unresolved');
  assert.equal(capture.complete, false);
  assert.equal(capture.telemetry.calls, null);
});

test('mapping continues the same checkpoint, explicitly applies a local draft and rejects empty preview', async () => {
  let checkpoint;
  const called = [];
  const proposal = { roles: [{ id: 'r', visualKind: 'node' }], structureTree: { items: [{ id: 'n', roleId: 'r' }] }, relationRules: [] };
  const capture = await runPilotPipeline({ mode: 'mapping', draft: spec, templateRef, blockIds: ['example'], maxRows: 5,
    reserveModelRequest: () => {}, request: async (path, body) => {
      called.push(path);
      if (path.endsWith('/analyze')) return { status: 200, json: { success: true, proposal } };
      if (path.endsWith('/interpret')) return { status: 200, json: { success: true, decisions: [] } };
      if (path.endsWith('/map-selections') && body.stage === 'roles') {
        checkpoint = body.resumeId;
        return { status: 202, json: { success: true, checkpoint: { resumeId: checkpoint, nextStage: 'topology' } } };
      }
      if (path.endsWith('/map-selections')) {
        assert.equal(body.resumeId, checkpoint);
        return { status: 200, json: { success: true, mappings: [{ structureItemId: 'n', roleId: 'r', mapping: { materialization: { kind: 'stage' } } }], relationRules: [] } };
      }
      if (path.endsWith('/apply')) {
        assert.equal(body.proposal.structureTree.items[0].mapping, undefined);
        assert.equal(body.structureTree.items[0].mapping.materialization.kind, 'stage');
        return { status: 200, json: { success: true, spec: { result: { diagrams: [{}] } } } };
      }
      assert.equal(path, '/draft/preview');
      return { status: 200, json: { success: true, result: { diagrams: [] } } };
    } });
  assert.equal(called.length, 6);
  assert.equal(capture.failure, 'pilot_expected_one_diagram');
  assert.equal(capture.stages.mapping.status, 'accepted');
  assert.equal(capture.complete, false);
});

test('graph identities ignore runtime IDs but detect wrong parent and preserve multiedges', () => {
  const create = (s) => ({ groups: [{ id: s + 'p', importRole: { structureItemId: 'parent' } }], nodes: [
    { id: s + 'n', group: s + 'p', importRole: { structureItemId: 'node' }, data: { sourceRef: { className: 'Node', id: 7 } } },
  ], edges: [1, 2].map((id) => ({ id: s + id, source: s + 'n', target: s + 'p', importRole: { edgeClassKey: 'relation' },
    direction: 'forward', data: { sourceRef: { className: 'Relation', id } } })) });
  const baseline = pilotGraphSnapshot(create('old'));
  assert.deepEqual(baseline, pilotGraphSnapshot(create('new')));
  assert.equal(new Set(baseline.edges.map((edge) => edge.id)).size, 2);
  const changed = create('new');
  changed.nodes[0].group = '';
  assert.notDeepEqual(baseline.placements, pilotGraphSnapshot(changed).placements);
});

test('local client rejects non-draft writes and never selects a host from scenario data', async () => {
  const calls = [];
  const request = await createLocalPilotRequest({ timeoutMs: 1000, env: { CMDP_PILOT_COOKIE: 'CMDBuild-Authorization=mock' },
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      assert.equal(new URL(url).origin, 'http://127.0.0.1:8093');
      assert.equal(options.redirect, 'error');
      return Response.json({ token: 'csrf', success: true });
    } });
  await assert.rejects(request('/templates', {}, {}), /pilot_forbidden_endpoint/);
  await request('/draft/preview', {}, { root: 'Cst_QueryTool' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'POST');
});
