import { randomUUID } from 'node:crypto';
import { applyAssistantEditorDelta, assistantEditorDeltaFromSpec, assistantObjectFlowBusinessBlockManifest,
  assistantObjectFlowDiagramStages } from './dev-proxy-server.mjs';
import { isPilotBudgetLimit } from './assistant-quality-pilot-report.mjs';

const paths = {
  context: '/assistant/object-flow/semantic-plan', semantic: '/assistant/object-flow/semantic-plan',
  flow: '/assistant/object-flow/plan', flowApply: '/draft/object-flow/apply',
  analysis: '/draft/diagram-import/analyze', interpretation: '/assistant/diagram-import/interpret',
  mapping: '/assistant/diagram-import/map-selections', diagramApply: '/draft/diagram-import/apply',
  rows: '/draft/preview', graph: '/draft/preview',
};
const modelPhases = new Set(['semantic', 'flow', 'interpretation', 'mapping']);
const requireValue = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };

export function pilotPreviewRows(spec, result, blockIds) {
  const manifest = assistantObjectFlowBusinessBlockManifest(spec, assistantObjectFlowDiagramStages(spec));
  const blocks = new Map(manifest.blocks.map((block) => [block.id, block]));
  const tables = new Map((result.tables || []).map((table) => [table.name, table]));
  const selected = blockIds.map((id) => {
    const block = blocks.get(id);
    const table = tables.get(block?.terminalAlias);
    return block?.status === 'ready' && Array.isArray(table?.rows) ? { id, table } : null;
  }).filter(Boolean);
  return {
    rows: selected.flatMap(({ id, table }) => table.rows.map((values) => ({ blockId: id, values }))),
    blockIds: selected.map(({ id }) => id),
    complete: selected.length === blockIds.length && !selected.some(({ table }) => table.truncated !== false) && pilotPreviewComplete(result),
  };
}

export function pilotPreviewComplete(result) {
  return Array.isArray(result.trace) && !result.trace.some((step) => step.status !== 'ok' || step.truncated === true ||
    step.limitDiagnostics?.some((limit) => limit.limitHit)) && !result.limitDiagnostics?.some((limit) => limit.limitHit) &&
    !result.diagnosticPreview && result.diagramPreview?.partial !== true && !result.diagramPreview?.omissions?.length;
}

const roleOverrides = (proposal) => proposal.roles.map(({ id, visualKind, labelTemplate }) => ({ id, visualKind, labelTemplate }));

// A validated mapping response names placements and relation types; it does not replace the signed analysis.
function mergeMapping(proposal, reply) {
  requireValue(Array.isArray(reply.mappings) && Array.isArray(reply.relationRules), 'pilot_mapping_invalid');
  const placements = new Map(proposal.structureTree.items.map((item) => [item.id, item]));
  for (const candidate of reply.mappings) {
    const item = placements.get(candidate.structureItemId);
    requireValue(item?.roleId === candidate.roleId && item && candidate.mapping, 'pilot_mapping_identity');
    item.mapping = { ...item.mapping, ...candidate.mapping };
    delete item.mapping.source;
  }
  const rules = new Map(proposal.relationRules.map((rule) => [rule.d2ClassKey, rule]));
  for (const candidate of reply.relationRules) {
    const rule = rules.get(candidate.d2ClassKey);
    requireValue(rule, 'pilot_relation_identity');
    Object.assign(rule, candidate);
  }
  proposal.endpointProfiles = reply.endpointProfiles || [];
}

export async function runPilotPipeline({ request, templateRef, draft, baseSpec = draft, mode, params = {}, blockIds,
  maxRows, traversalDepth, maxResponses = 16, reserveModelRequest, graphSnapshot }) {
  const started = performance.now();
  let activePhase = '', requests = 0, modelRequests = 0, repairs = 0, spec = structuredClone(draft), snapshotsComplete = true;
  const stages = {}, events = [];
  const capture = { stages, events, rows: undefined, graph: undefined, complete: false, telemetry: {} };
  const { root, templateCode, baseSpecHash } = templateRef;
  const refs = { root, templateCode, baseSpecHash };
  const editor = () => {
    const { spec: editorSpec, version } = assistantEditorDeltaFromSpec(spec);
    // The server merges deltas into the saved reference. Remove applied mapping and
    // legacy visual carriers explicitly instead of letting them leak from the base.
    return { templateRef, editorDelta: { version, spec: { ...editorSpec,
      visualModel: editorSpec.visualModel ?? null, visualModels: editorSpec.visualModels ?? null,
      result: { ...editorSpec.result, tables: editorSpec.result?.tables || [], diagrams: [] } } } };
  };
  const current = () => applyAssistantEditorDelta(baseSpec, editor().editorDelta);
  const code = 'AssistantQualityPilotDraft';
  const call = async (phase, body, query = {}, transitional = false) => {
    activePhase = phase;
    requireValue(requests < maxResponses, 'pilot_attempt_request_budget');
    if (modelPhases.has(phase)) { reserveModelRequest(phase); modelRequests += 1; }
    requests += 1;
    const time = performance.now();
    const response = await request(paths[phase], body, { root, ...query });
    const { status, json } = response;
    events.push({ phase, status, durationMs: Math.round(performance.now() - time),
      code: /^[a-z][a-z0-9_]{0,100}$/.test(json?.code || '') ? json.code : null });
    const kinds = (Array.isArray(json?.errors) ? json.errors : []).map((error) => error?.kind || error?.code)
      .filter((kind) => typeof kind === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(kind));
    if (kinds.length) events.at(-1).errorKinds = [...new Set(kinds)].slice(0, 12);
    const context = json?.diagnostics?.mcp?.semanticContext;
    if (context?.complete === false) {
      events.at(-1).context = {
        reason: /^[A-Za-z][A-Za-z0-9_-]{0,50}$/.test(context.reason || '') ? context.reason : null,
        settingPath: /^assistant\.mcp\.[A-Za-z][A-Za-z0-9_]{0,50}$/.test(context.settingPath || '') ? context.settingPath : null,
        requiredCount: Number.isSafeInteger(context.requiredCount) ? context.requiredCount : null,
        effectiveLimit: Number.isSafeInteger(context.effectiveLimit) ? context.effectiveLimit : null
      };
    }
    if (!transitional) requireValue(status >= 200 && status < 300 && json?.success === true,
      events.at(-1).code || `pilot_http_${status}`);
    return json;
  };
  const stage = (name, status = 'accepted') => { stages[name] = { status }; };
  try {
    if (mode !== 'mapping') {
      if (mode === 'flow') {
        delete spec.authoring.d2;
        delete spec.authoring.assistant.diagramIntentPrompt;
      }
      const intent = spec.authoring.assistant.objectFlowIntent;
      const resumeId = randomUUID();
      const common = { ...editor(), intent, resumeId };
      const context = await call('context', { ...common, stage: 'context' });
      requireValue(context.checkpoint?.resumeId === resumeId, 'pilot_context_checkpoint_invalid');
      const semantic = await call('semantic', { ...common, stage: 'plan' });
      requireValue(Array.isArray(semantic.semanticPlan?.blocks) && semantic.semanticPlan.blocks.length > 0, 'pilot_semantic_invalid');
      if (semantic.semanticPlan.blocks.some((block) => block.resultContract?.outputKind === 'unresolved')) {
        stage('flow', 'unresolved');
        return capture;
      }
      const proposed = await call('flow', { ...common, semanticPlan: semantic.semanticPlan });
      requireValue(proposed.canApply === true && proposed.flow && Array.isArray(proposed.outputBindings), 'pilot_flow_not_applicable');
      const applied = await call('flowApply', { ...refs, currentSpec: current(), flow: proposed.flow,
        assistantObjectFlowIntent: intent, assistantOutputBindings: proposed.outputBindings });
      requireValue(Array.isArray(applied.spec?.steps) && applied.spec.steps.length > 0, 'pilot_flow_apply_invalid');
      spec = applied.spec;
      stage('flow');
      const preview = await call('rows', { code, spec, params }, { includeDiagrams: 'false', maxRows });
      const snapshot = pilotPreviewRows(spec, preview.result, blockIds);
      capture.rows = snapshot.rows;
      capture.blockIds = snapshot.blockIds;
      snapshotsComplete &&= snapshot.complete;
      stage('rows');
      if (!snapshotsComplete) return capture;
    }
    if (mode !== 'flow') {
      spec = current();
      const d2Source = spec.authoring.d2.source;
      const analyzed = await call('analysis', { ...refs, currentSpec: spec, d2Source });
      const signed = analyzed.proposal;
      requireValue(Array.isArray(signed?.roles) && Array.isArray(signed.structureTree?.items) && Array.isArray(signed.relationRules), 'pilot_analysis_invalid');
      const working = structuredClone(signed);
      const body = () => ({ ...editor(), proposal: signed, roles: roleOverrides(working),
        relationRules: working.relationRules, structureTree: working.structureTree, traversalDepth,
        prompt: spec.authoring.assistant.diagramIntentPrompt });
      const interpretation = await call('interpretation', body());
      requireValue(Array.isArray(interpretation.decisions), 'pilot_interpretation_invalid');
      for (const decision of interpretation.decisions) {
        const role = working.roles.find((candidate) => candidate.id === decision.roleId);
        requireValue(role, 'pilot_role_identity');
        if (decision.visualKind) role.visualKind = decision.visualKind;
        if (decision.labelTemplate !== undefined) role.labelTemplate = decision.labelTemplate;
      }
      const mappingInput = body(), resumeId = randomUUID();
      let mappingStage = 'roles', reply;
      for (let i = 0; i < 6; i += 1) {
        reply = await call('mapping', { ...mappingInput, stage: mappingStage, resumeId }, {}, true);
        if (events.at(-1).status === 200 && reply?.success === true) break;
        if (events.at(-1).status === 202 && reply?.success === true && reply.checkpoint?.resumeId === resumeId &&
          ['roles', 'topology'].includes(reply.checkpoint.nextStage)) { mappingStage = reply.checkpoint.nextStage; continue; }
        if (events.at(-1).status === 422 && reply?.retryable === true && reply.retryKind === 'correction' &&
          !repairs && reply.resume?.resumeId === resumeId && reply.resume.nextStage === mappingStage) { repairs += 1; continue; }
        requireValue(false, events.at(-1).code || `pilot_http_${events.at(-1).status}`);
      }
      requireValue(events.at(-1).status === 200 && reply?.success === true, 'pilot_mapping_continuation_budget');
      if (reply.mapping?.unresolved?.length || reply.connectionUnresolved?.length) {
        stage('mapping', 'unresolved');
        return capture;
      }
      mergeMapping(working, reply);
      const applied = await call('diagramApply', { ...refs, currentSpec: spec, d2Source, proposal: signed,
        roles: roleOverrides(working), structureTree: working.structureTree, relationRules: working.relationRules,
        endpointProfiles: working.endpointProfiles });
      requireValue(applied.spec?.result?.diagrams?.length === 1, 'pilot_diagram_apply_invalid');
      stage('mapping');
      const preview = await call('graph', { code, spec: applied.spec, params }, { maxRows });
      const result = preview.result;
      requireValue(result?.diagrams?.length === 1, 'pilot_expected_one_diagram');
      const diagram = result.diagrams[0];
      snapshotsComplete &&= result.d2Workflow?.state === 'applied' && pilotPreviewComplete(result) && !diagram.truncated &&
        !diagram.unplaced?.length && !diagram.execution?.unconfigured?.length &&
        diagram.svg?.rendered === true && diagram.execution?.svgContract?.status === 'verified';
      capture.graph = graphSnapshot(diagram);
      stage('graph');
    }
    capture.complete = snapshotsComplete;
  } catch (error) {
    capture.failure = isPilotBudgetLimit(error?.code) ? error.code :
      (events.at(-1)?.phase === activePhase && events.at(-1).code ||
      (/^pilot_[a-z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'pilot_transport_or_contract_failure'));
    capture.failedPhase = activePhase;
  } finally {
    capture.telemetry = { durationMs: Math.round(performance.now() - started), requests, modelRequests, repairs,
      calls: null, inputTokens: null, outputTokens: null };
  }
  return capture;
}
