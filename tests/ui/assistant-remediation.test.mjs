import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { createUiRequestDiagnostics } from '../../scripts/ui-request-diagnostics.mjs';
import { createAssistantDiagnosticsUi } from '../../scripts/assistant-diagnostics-ui.mjs';

function clientScript() {
  const source = fs.readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function dynamicPagesClientScript()');
  const end = source.indexOf('\nfunction isCollectionLimitedAuthoringRequest', start);
  assert.ok(start >= 0 && end > start, 'generated client boundaries must exist');
  const constants = {
    createUiRequestDiagnostics, createAssistantDiagnosticsUi,
    DEFAULT_EMPTY_RESULT_TEXT: 'empty', DEFAULT_PERMISSION_DENIED_TEXT: 'denied', DEFAULT_TEMPLATE_CACHE_TTL_SEC: 3600,
    D2_IMPORT_SEMANTIC_MODEL_REVISION: 10, D2_IMPORT_ENDPOINT_PROFILE_VERSION: 1, D2_IMPORT_STRUCTURE_TREE_VERSION: 5,
    D2_IMPORT_ANALYSIS_CHECKPOINT_VERSION: 1, D2_IMPORT_ASSISTANT_CHECKPOINT_VERSION: 3, ASSISTANT_PROMPT_CONTRACT_VERSION: 3,
    DEFAULT_ASSISTANT_SYSTEM_PROMPT: 'system', DEFAULT_ASSISTANT_OBJECT_FLOW_PROMPT: 'flow', DEFAULT_ASSISTANT_OBJECT_FLOW_SEMANTIC_PROMPT: 'semantic',
    DEFAULT_ASSISTANT_DIAGRAM_SEMANTICS_PROMPT: 'diagram', DEFAULT_ASSISTANT_DIAGRAM_BINDING_INTENT_PROMPT: 'binding',
    DEFAULT_ASSISTANT_DIAGRAM_PLACEMENT_PROMPT: 'placement', DEFAULT_ASSISTANT_DIAGRAM_CONNECTIONS_PROMPT: 'connections', DEFAULT_ASSISTANT_DIAGRAM_CRITIQUE_PROMPT: 'critique'
  };
  const generate = new Function(...Object.keys(constants), source.slice(start, end) + '\nreturn dynamicPagesClientScript();');
  const script = generate(...Object.values(constants));
  const startup = "  updateChrome();\n  setupLanguageSelector();\n  if (boot.mode === 'runtime') loadRuntime();\n  else loadDesigner();";
  assert.ok(script.includes(startup));
  // Suppress only startup I/O; retain the real renderers, event handlers and request pipeline.
  return script.replace(startup, `window.remediation = { state, assistantDiagnosticsUi, renderDesigner,
    captureVisibleDesignerState, captureRuntimeSettings, runtimeSettingsDraft, defaultRuntimeConfig, defaultSpec };
    setupLanguageSelector();`);
}

async function withClient(viewport, scenario) {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', headless: true });
  const expected = [];
  try {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(5000);
    const errors = [], unexpected = [], writes = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const expectRequest = (method, pathname) => {
      let receive, reply;
      let timer;
      const received = new Promise((resolve, reject) => {
        receive = resolve;
        timer = setTimeout(() => reject(new Error(`Missing mock request: ${method} ${pathname}`)), 5000);
      });
      const response = new Promise((resolve) => { reply = resolve; });
      expected.push({ method, pathname, receive, response, timer });
      return { received, respond: (json, status = 200) => reply({ json, status }), fail: () => reply({ abort: true }) };
    };
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === 'http://remediation.test' && request.isNavigationRequest() && url.pathname === '/') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>*{box-sizing:border-box}body{font:14px sans-serif;margin:12px}input,textarea,select{max-width:100%}label{display:block}section{max-width:100%}.visual-grid{display:grid;gap:8px}pre{overflow-wrap:anywhere}table{font-size:12px}</style></head><body><select id="cmdp-language"><option value="ru">RU</option><option value="en">EN</option></select><div id="app"></div></body></html>' });
      }
      const call = { method: request.method(), path: url.pathname, root: url.searchParams.get('root'), body: request.postDataJSON() };
      if (call.method !== 'GET') writes.push(call);
      const index = expected.findIndex((item) => item.method === call.method && item.pathname === url.pathname);
      if (url.origin === 'http://remediation.test' && index >= 0) {
        const item = expected.splice(index, 1)[0];
        clearTimeout(item.timer);
        item.receive(call);
        const response = await item.response;
        return response.abort ? route.abort('failed') : route.fulfill(response);
      }
      if (url.origin === 'http://remediation.test' && call.method === 'GET') {
        if (url.pathname === '/cmdbuild/custom-api/csrf') return route.fulfill({ json: { success: true, token: 'mock-csrf' } });
        if (url.pathname === '/cmdbuild/custom-api/client-log' && url.searchParams.get('stage') === 'script-loaded') return route.fulfill({ status: 204 });
        if (url.pathname === '/cmdbuild/custom-api/assistant/diagnostics/status') return route.fulfill({ json: { success: true, status: { mode: 'Off' } } });
      }
      unexpected.push(call);
      return route.abort('blockedbyclient');
    });
    await page.goto('http://remediation.test/');
    await page.addScriptTag({ content: clientScript() });
    await page.evaluate(() => {
      const ui = window.remediation;
      ui.state.session = { rolePrivileges: { admin_classes_modify: true } };
      ui.state.config = { exists: true, runtimeConfig: ui.defaultRuntimeConfig() };
      ui.state.designerSection = 'settings';
      ui.renderDesigner();
    });
    await scenario({ page, expectRequest, writes });
    assert.deepEqual(errors, [], 'no browser runtime errors');
    assert.deepEqual(unexpected, [], 'all network traffic must be explicitly mocked');
    assert.equal(expected.length, 0, 'all expected calls must occur');
  } finally {
    expected.forEach((item) => clearTimeout(item.timer));
    await browser.close();
  }
}

async function assertVisible(locator, viewport) {
  assert.equal(await locator.isVisible(), true);
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 100 && box.height > 0 && box.x >= 0 && box.x + box.width <= viewport.width, 'usable visible geometry');
}

async function openSemanticPlan(page, language = 'ru') {
  await page.locator('#cmdp-language').selectOption(language);
  await page.evaluate(() => {
    const ui = window.remediation;
    ui.state.selectedTemplate = { code: 'retry-test', spec: ui.defaultSpec() };
    ui.state.assistantObjectFlowIntent = { context: 'Devices', blocks: [
      { id: 'devices', name: 'Devices', description: 'Devices', resultKind: 'cards', uses: [] }
    ] };
    ui.state.designerSection = 'assistant';
    ui.renderDesigner();
  });
}

const semanticPath = '/cmdbuild/custom-api/assistant/object-flow/semantic-plan';

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  for (const language of ['ru', 'en']) {
    test(`invalid JSON permits only manual checkpoint retry in ${language} at ${viewport.width}px`, async () => {
      await withClient(viewport, async ({ page, expectRequest, writes }) => {
        await openSemanticPlan(page, language);
        const context = expectRequest('POST', semanticPath);
        await page.locator('[data-action="assistant-flow-prepare"]').click();
        const initial = await context.received;
        const checkpoint = { resumeId: initial.body.resumeId, stage: 'mcpContextReady', expiresAt: new Date(Date.now() + 60000).toISOString() };
        const plan = expectRequest('POST', semanticPath);
        context.respond({ success: true, checkpoint });
        assert.equal((await plan.received).body.stage, 'plan');
        plan.respond({ success: false, code: 'assistant_invalid_json', retryable: true, resume: checkpoint }, 502);
        const retry = page.locator('[data-action="assistant-flow-prepare-retry"]');
        await retry.waitFor();
        await assertVisible(retry, viewport);
        const rejected = page.locator('[data-assistant-flow-rejected]');
        await assertVisible(rejected, viewport);
        assert.match(await rejected.innerText(), language === 'ru' ? /Модель вернула текст вместо JSON-плана; результат не применен/ : /model returned text instead of a JSON plan; not applied/);
        assert.equal(await page.locator('[data-action="assistant-flow-apply"]').isDisabled(), true);
        await page.waitForTimeout(100);
        assert.equal(writes.filter((call) => call.path === semanticPath).length, 2, 'no automatic retry');
        const manual = expectRequest('POST', semanticPath);
        await retry.click();
        const resumed = await manual.received;
        assert.equal(resumed.body.stage, 'plan');
        assert.equal(resumed.body.resumeId, initial.body.resumeId);
        assert.equal(resumed.root, initial.root);
        manual.respond({ success: false, code: 'assistant_invalid_json', retryable: false, resume: checkpoint }, 502);
        await page.waitForFunction(() => !window.remediation.state.assistantFlowBusy);
        assert.equal(await retry.count(), 0, 'server denial wins even with saved checkpoint');
        assert.equal(await page.evaluate(() => window.remediation.state.assistantFlowResume), null);
        assert.equal(await page.evaluate(() => window.remediation.state.assistantFlowSemanticPlan), null);
        await page.screenshot({ path: `/tmp/assistant-retry-${language}-${viewport.width}.png`, fullPage: true });
      });
    });
  }
}

for (const mode of ['missing', 'wrong-id', 'expired', 'wrong-stage', 'string-true', 'no-flag', 'auth', 'network']) {
  test(`semantic retry rejects ${mode} server contract`, async () => {
    await withClient({ width: 1280, height: 900 }, async ({ page, expectRequest, writes }) => {
      await openSemanticPlan(page);
      const pending = expectRequest('POST', semanticPath);
      await page.locator('[data-action="assistant-flow-prepare"]').click();
      const initial = await pending.received;
      const resume = { resumeId: mode === 'wrong-id' ? 'other' : initial.body.resumeId,
        stage: mode === 'wrong-stage' ? 'completed' : 'mcpContextReady',
        expiresAt: new Date(Date.now() + (mode === 'expired' ? -60000 : 60000)).toISOString() };
      if (mode === 'network') pending.fail();
      else pending.respond({ success: false, code: mode === 'auth' ? 'permission_denied' : 'assistant_invalid_json',
        ...(mode === 'no-flag' ? {} : { retryable: mode === 'string-true' ? 'true' : mode !== 'auth' }),
        resume: mode === 'missing' ? null : resume }, mode === 'auth' ? 403 : 502);
      await page.waitForFunction(() => !window.remediation.state.assistantFlowBusy);
      assert.equal(await page.locator('[data-action="assistant-flow-prepare-retry"]').count(), 0);
      assert.equal(await page.evaluate(() => window.remediation.state.assistantFlowResume), null);
      assert.equal(writes.filter((call) => call.path === semanticPath).length, 1);
    });
  });
}

for (const language of ['ru', 'en']) {
  for (const [code, retryable, summary] of [
    ['assistant_empty_response', true, { ru: 'Модель вернула пустой ответ; результат не применен.', en: 'The model returned an empty response; not applied.' }],
    ['assistant_output_truncated', false, { ru: 'Ответ модели обрезан; результат не применен.', en: 'The model response was truncated; not applied.' }],
    ['assistant_response_format_unsupported', false, { ru: 'Провайдер не поддерживает выбранный формат ответа; результат не применен.', en: 'The provider does not support the selected response format; not applied.' }]
  ]) {
    test(`${code} localized in ${language}, retryable=${retryable}`, async () => {
      await withClient({ width: 1280, height: 900 }, async ({ page, expectRequest }) => {
        await openSemanticPlan(page, language);
        const pending = expectRequest('POST', semanticPath);
        await page.locator('[data-action="assistant-flow-prepare"]').click();
        const initial = await pending.received;
        pending.respond({ success: false, code, retryable, resume: {
          resumeId: initial.body.resumeId, stage: 'mcpContextReady', expiresAt: new Date(Date.now() + 60000).toISOString()
        } }, 502);
        await page.waitForFunction(() => !window.remediation.state.assistantFlowBusy);
        const rejected = page.locator('[data-assistant-flow-rejected]');
        await assertVisible(rejected, { width: 1280 });
        assert.ok((await rejected.innerText()).includes(summary[language]));
        if (code === 'assistant_response_format_unsupported') assert.match(await rejected.innerText(), /assistant\.llm\.responseFormat/);
        if (code === 'assistant_output_truncated') {
          assert.match(await rejected.innerText(), /assistant\.llm\.maxTokens/);
          assert.match(await rejected.innerText(), language === 'ru' ? /автоматически не увеличиваются/ : /not increased automatically/);
        }
        assert.equal(await page.locator('[data-action="assistant-flow-prepare-retry"]').count(), Number(retryable));
        assert.match(await rejected.locator('h4').innerText(), retryable
          ? language === 'ru' ? /приостановлен/ : /paused/
          : language === 'ru' ? /отклонен/ : /rejected/);
      });
    });
  }
}

for (const ownership of ['generation', 'root', 'session']) {
  test(`semantic response cannot replace ${ownership} ownership`, async () => {
    await withClient({ width: 1280, height: 900 }, async ({ page, expectRequest }) => {
      await openSemanticPlan(page);
      const pending = expectRequest('POST', semanticPath);
      await page.locator('[data-action="assistant-flow-prepare"]').click();
      const initial = await pending.received;
      await page.evaluate((ownership) => {
        const state = window.remediation.state;
        if (ownership === 'generation') state.assistantFlowRequestGeneration++;
        if (ownership === 'root') { const root = state.root; state.root = 'Other_QueryTool'; state.root = root; }
        if (ownership === 'session') state.sessionInstance++;
        state.assistantFlowResume = null;
        state.assistantFlowBusy = true;
        state.assistantFlowFeedback = { summary: 'Current owner feedback' };
      }, ownership);
      const ack = page.waitForResponse((response) => new URL(response.url()).pathname === semanticPath);
      pending.respond({ success: false, code: 'assistant_invalid_json', retryable: true,
        resume: { resumeId: initial.body.resumeId, stage: 'mcpContextReady', expiresAt: new Date(Date.now() + 60000).toISOString() } }, 502);
      await ack;
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.remediation.state.assistantFlowFeedback.summary), 'Current owner feedback');
      assert.equal(await page.evaluate(() => window.remediation.state.assistantFlowResume), null);
      assert.equal(await page.evaluate(() => window.remediation.state.assistantFlowBusy), true, 'stale finally preserves current owner busy state');
    });
  });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`embedded client raw settings and trace filters survive rerender at ${viewport.width}px`, async () => {
    await withClient(viewport, async ({ page, expectRequest, writes }) => {
      await page.locator('#cmdp-assistant-llm-max-tokens').fill('not-a-number');
      await page.locator('#cmdp-assistant-system-prompt').fill('unsaved prompt\nsecond line');
      await page.locator('#cmdp-assistant-llm-model').fill('unsaved-model');
      await page.locator('#cmdp-assistant-llm-response-format').selectOption('prompt');
      await page.locator('#cmdp-assistant-mcp-enabled').check();
      await page.locator('#cmdp-language').selectOption('en');
      await page.locator('[data-designer-section="about"]').click();
      assert.equal(await page.locator('#cmdp-assistant-llm-model').count(), 0);
      await page.locator('[data-designer-section="settings"]').click();
      assert.equal(await page.locator('#cmdp-assistant-llm-max-tokens').inputValue(), 'not-a-number');
      assert.equal(await page.locator('#cmdp-assistant-system-prompt').inputValue(), 'unsaved prompt\nsecond line');
      assert.equal(await page.locator('#cmdp-assistant-llm-model').inputValue(), 'unsaved-model');
      assert.equal(await page.locator('#cmdp-assistant-llm-response-format').inputValue(), 'prompt');
      await page.locator('#cmdp-assistant-llm-max-tokens').fill('16384');
      assert.equal(await page.evaluate(() => window.remediation.captureRuntimeSettings('Cst_QueryTool').runtimeConfig.assistant.llm.responseFormat), 'prompt');
      await page.locator('#cmdp-assistant-llm-max-tokens').fill('not-a-number');
      assert.equal(await page.locator('#cmdp-assistant-mcp-enabled').isChecked(), true);
      await assertVisible(page.locator('#cmdp-assistant-llm-model'), viewport);
      assert.equal(await page.evaluate(() => { try { window.remediation.captureRuntimeSettings('Cst_QueryTool'); return false; } catch { return true; } }), true);
      assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /unsaved-model|unsaved prompt|not-a-number/);
      const status = expectRequest('GET', '/cmdbuild/custom-api/assistant/diagnostics/status');
      await page.evaluate(() => { void window.remediation.assistantDiagnosticsUi.refresh(); });
      await status.received;
      const filter = page.locator('#cmdp-assistant-debug-request');
      await filter.fill('unsent filter');
      await page.locator('#cmdp-assistant-debug-template').fill('unsent-template');
      await filter.focus();
      await filter.evaluate((input) => input.setSelectionRange(3, 6));
      status.respond({ success: true, status: { mode: 'Basic' } });
      await page.waitForFunction(() => document.getElementById('cmdp-assistant-debug-mode').value === 'Basic');
      assert.equal(await filter.inputValue(), 'unsent filter');
      assert.equal(await page.locator('#cmdp-assistant-debug-template').inputValue(), 'unsent-template');
      assert.equal(await filter.evaluate((input) => document.activeElement === input), true);
      assert.deepEqual(await filter.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 6]);
      await assertVisible(filter, viewport);
      assert.deepEqual(writes, [], 'settings and trace filtering must not persist anything');
      await page.screenshot({ path: `/tmp/assistant-remediation-${viewport.width}.png`, fullPage: true });
    });
  });

  test(`Save POST ACK retains new edits and next PUT identity at ${viewport.width}px`, async () => {
    await withClient(viewport, async ({ page, expectRequest, writes }) => {
      await page.evaluate(() => {
        const ui = window.remediation;
        ui.state.selectedTemplate = { code: '', description: '', active: true, spec: {}, paramsSchema: {}, resultSchema: {} };
        ui.state.designerSection = 'template';
        ui.renderDesigner();
      });
      await page.locator('#cmdp-code').fill('remediation');
      await page.locator('#cmdp-description').fill('initial description');
      const post = expectRequest('POST', '/cmdbuild/custom-api/templates');
      await page.locator('[data-action="save-template"]').click();
      const created = await post.received;
      assert.equal(created.body.description, 'initial description');
      await page.locator('#cmdp-description').fill('new unsaved description');
      post.respond({ success: true, template: { ...created.body, id: 42, version: 1, specHash: 'hash-1' }, executionValidation: { executable: true } });
      await page.waitForFunction(() => window.remediation.state.selectedTemplate?.id === 42 && !window.remediation.state.savingTemplate);
      assert.equal(await page.locator('#cmdp-description').inputValue(), 'new unsaved description');
      assert.equal(await page.evaluate(() => window.remediation.state.templateDirty), true);
      assert.match(await page.locator('#app').innerText(), /Сохранена предыдущая редакция; есть несохранённые изменения|The previous revision was saved; there are unsaved changes/);
      assert.equal(await page.locator('#cmdp-code').evaluate((input) => input.readOnly), true);
      await assertVisible(page.locator('#cmdp-description'), viewport);
      const put = expectRequest('PUT', '/cmdbuild/custom-api/templates/remediation');
      await page.locator('[data-action="save-template"]').click();
      const updated = await put.received;
      assert.equal(updated.body.expectedSpecHash, 'hash-1');
      assert.equal(updated.body.description, 'new unsaved description');
      assert.equal(updated.root, created.root);
      put.respond({ success: true, template: { ...updated.body, id: 42, version: 2, specHash: 'hash-2' }, executionValidation: { executable: true } });
      await page.waitForFunction(() => window.remediation.state.selectedTemplate?.specHash === 'hash-2' && !window.remediation.state.savingTemplate);
      assert.equal(await page.evaluate(() => window.remediation.state.templateDirty), false);
      assert.deepEqual(writes.map((call) => call.method), ['POST', 'PUT']);
    });
  });

  test(`A-B-A invalidates pending capture before POST at ${viewport.width}px`, async () => {
    await withClient(viewport, async ({ page, expectRequest, writes }) => {
      const config = expectRequest('PUT', '/cmdbuild/custom-api/config');
      await page.locator('#cmdp-assistant-llm-model').fill('old-root-unsaved-model');
      await page.locator('#cmdp-assistant-debug-mode').selectOption('Basic');
      await page.locator('[data-action="assistant-debug-apply"]').click();
      const pending = await config.received;
      await page.evaluate(() => {
        const ui = window.remediation;
        const root = ui.state.root;
        ui.state.root = 'Other_QueryTool';
        ui.state.root = root;
        ui.renderDesigner();
      });
      const ack = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/cmdbuild/custom-api/config');
      config.respond({ success: true, config: { exists: true, runtimeConfig: pending.body.runtimeConfig }, effectiveAssistantDiagnostics: { captureDurationSec: 60 } });
      await ack;
      // Drain the original savePolicy -> current(token) continuation before checking negative effects.
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
      assert.equal(await page.locator('#cmdp-assistant-debug-mode').inputValue(), 'Off');
      assert.deepEqual(writes.map((call) => [call.method, call.path]), [['PUT', '/cmdbuild/custom-api/config']]);
      assert.notEqual(await page.locator('#cmdp-assistant-llm-model').inputValue(), 'old-root-unsaved-model');
      await assertVisible(page.locator('#cmdp-assistant-debug-request'), viewport);
    });
  });
}
