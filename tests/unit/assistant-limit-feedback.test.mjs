import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assistantSemanticPlanValidationFeedback } from '../../scripts/dev-proxy-server.mjs';

const clientSource = readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
const dictionaries = new Function('DEFAULT_PERMISSION_DENIED_TEXT', clientSource.slice(clientSource.indexOf('  var I18N = '), clientSource.indexOf('  var activeLanguage = ')) + '\nreturn I18N;')('permission denied');
function clientFunction(name) {
  const start = clientSource.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  return clientSource.slice(start, clientSource.indexOf('\n  }', start) + 4);
}
function localize(feedback, language) {
  return new Function('state', 'I18N', 'feedback', clientFunction('t') + '\n' + clientFunction('localizeAssistantSemanticPlanFeedback') + '\nreturn localizeAssistantSemanticPlanFeedback(feedback);')({ language }, dictionaries, feedback);
}

test('local timeout feedback names its exact setting and retained checkpoint', () => {
  const feedback = assistantSemanticPlanValidationFeedback({
    code: 'assistant_timeout', semanticPlanResume: { stage: 'mcpContextReady' },
    diagnostics: { limits: [{ timeout: true, effectiveLimit: 10000, stage: 'semanticPlan' }] }
  });
  assert.match(feedback.summary, /10000 мс/);
  assert.match(feedback.causes[0].message, /assistant\.mcp\.timeoutMs = 10000/);
  assert.match(feedback.action, /MCP-контекст сохранен/);
  assert.equal(feedback.code, 'assistant_timeout');
  assert.deepEqual(feedback.params, { effectiveLimit: 10000, settingPath: 'assistant.mcp.timeoutMs', stage: 'semanticPlan', checkpointRetained: true });
  assert.equal(assistantSemanticPlanValidationFeedback({ code: 'litellm_error', statusCode: 504 }), null);
});

for (const reason of ['permission', 'timeout', 'incomplete', 'maxClasses', 'maxContextBytes', 'toolNotAllowed', 'descriptionUnverified', 'nameNotFound']) {
  test(`class verification failure ${reason} does not blame the user description`, () => {
    const feedback = assistantSemanticPlanValidationFeedback({ details: [{
      kind: 'semanticPlanClassUnavailable', blockName: 'Networks', className: 'Network', reason,
      classContextLimited: true, catalogCompleteness: { fetched: 50, visible: 45 }
    }] });
    assert.match(feedback.causes[0].message, /не подтверждает отсутствие/);
    assert.doesNotMatch(feedback.action, /Исправьте класс/);
    assert.doesNotMatch(feedback.action, /CMDBuild Code/);
    assert.equal(feedback.code, 'semanticPlanClassUnavailable');
    assert.equal(feedback.params.reason, reason);
    assert.equal(feedback.params.blockName, 'Networks');
    assert.equal(feedback.params.className, 'Network');
    assert.equal(feedback.params.fetched, 50);
  });
}

for (const reason of ['maxClasses', 'maxContextBytes', 'timeout', 'missingFields', 'missingMetadata']) {
  test(`incomplete context ${reason} carries exact localizable diagnostics`, () => {
    const issue = {
      kind: 'semanticPlanContextIncomplete', reason, blockName: 'Сети Network', blockId: 'block-1',
      settingPath: reason === 'timeout' ? 'assistant.mcp.timeoutMs' : `assistant.mcp.${reason}`,
      requiredCount: 23, effectiveLimit: 10, classNames: ['Network', 'Сеть']
    };
    const feedback = assistantSemanticPlanValidationFeedback({ details: [issue] });
    assert.equal(feedback.code, issue.kind);
    assert.deepEqual(feedback.params, {
      reason, blockName: issue.blockName, blockId: issue.blockId, settingPath: issue.settingPath,
      requiredCount: 23, effectiveLimit: 10, classNames: issue.classNames
    });
    assert.match(feedback.action, new RegExp(issue.settingPath.replaceAll('.', '\\.')));
  });
}

test('confirmed absence remains distinct from unverified name or Description', () => {
  const feedback = assistantSemanticPlanValidationFeedback({ details: [{
    kind: 'semanticPlanClassUnavailable', reason: 'absent', className: 'Network', blockName: 'Networks'
  }] });
  assert.equal(feedback.params.reason, 'absent');
  assert.match(feedback.action, /Исправьте класс/);
});

for (const language of ['ru', 'en']) {
  test(`client dictionaries localize timeout and preserve checkpoint in ${language}`, () => {
    const feedback = assistantSemanticPlanValidationFeedback({ code: 'assistant_timeout', timeoutMs: 12345, semanticPlanResume: {} });
    const rendered = localize(feedback, language);
    assert.match(rendered.causes[0].message, /assistant\.mcp\.timeoutMs = 12345/);
    assert.match(rendered.action, language === 'en' ? /MCP context was saved/ : /MCP-контекст сохранен/);
    if (language === 'en') assert.doesNotMatch(JSON.stringify([rendered.summary, rendered.action, rendered.causes]), /[А-Яа-яЁё]/);
    assert.doesNotMatch(localize({ ...feedback, params: { ...feedback.params, checkpointRetained: false } }, language).action, language === 'en' ? /was saved/ : /сохранен/);
  });

  test(`client dictionaries localize all class and context reasons in ${language} without translating identifiers`, () => {
    for (const reason of ['permission', 'timeout', 'maxClasses', 'maxContextBytes', 'missingFields', 'missingMetadata', 'toolNotAllowed', 'incomplete', 'descriptionUnverified', 'nameNotFound', 'absent']) {
      for (const kind of ['semanticPlanClassUnavailable', 'semanticPlanContextIncomplete']) {
        const feedback = assistantSemanticPlanValidationFeedback({ details: [{
          kind, reason, blockName: 'Network result', className: 'Network', classNames: ['Network', 'CustomClass'],
          settingPath: 'assistant.mcp.maxClasses', requiredCount: 23, effectiveLimit: 10
        }] });
        const rendered = localize(feedback, language);
        const text = JSON.stringify([rendered.summary, rendered.causes, rendered.action]);
        assert.ok(text.includes('Network result'));
        assert.ok(text.includes('Network'));
        assert.doesNotMatch(text, /assistantFeedback|\{[a-zA-Z]+\}/);
        if (language === 'en') assert.doesNotMatch(text, /[А-Яа-яЁё]/);
        if (kind === 'semanticPlanContextIncomplete') {
          for (const value of ['CustomClass', '23', '10', 'assistant.mcp.maxClasses']) assert.ok(text.includes(value), text);
        }
      }
    }
    const rendered = localize({ code: 'semanticPlanClassUnavailable', params: { blockName: 'Сети Network', className: 'Сеть' } }, language);
    assert.ok(rendered.summary.includes('Сети Network'));
    assert.ok(rendered.summary.includes('Сеть'));
  });

  test(`client localizes ambiguous and mismatched class feedback in ${language}`, () => {
    for (const kind of ['semanticPlanClassAmbiguous', 'semanticPlanOutputClassMismatch']) {
      const feedback = assistantSemanticPlanValidationFeedback({ details: [{
        kind, className: 'Network', blockName: 'Network result', candidates: [{ name: 'NetworkA' }, { name: 'NetworkB' }],
        expectedClassName: 'NetworkA', actualClassName: 'NetworkB'
      }] });
      const text = JSON.stringify(localize(feedback, language).causes);
      assert.ok(text.includes('NetworkA'));
      assert.ok(text.includes('NetworkB'));
      if (language === 'en') assert.doesNotMatch(text, /[А-Яа-яЁё]/);
    }
  });
}

test('semantic retry keeps translated fallback and uses confirmed checkpoint state', () => {
  const state = { language: 'en' };
  const retry = new Function('state', 'I18N', clientFunction('t') + '\n' + clientFunction('setAssistantSemanticPlanRetryState') + '\nreturn setAssistantSemanticPlanRetryState;')(state, dictionaries);
  retry({}, {}, true);
  assert.equal(state.assistantFlowFeedback.summary, 'Semantic plan is paused.');
  assert.match(state.assistantFlowFeedback.action, /CMDB context was saved/);
  const feedback = { code: 'assistant_timeout', params: { effectiveLimit: 10000, settingPath: 'assistant.mcp.timeoutMs', checkpointRetained: true } };
  retry({}, {}, false, feedback);
  assert.equal(state.assistantFlowFeedback.params.checkpointRetained, false);
  assert.equal(feedback.params.checkpointRetained, true);
});
