// Self-contained factory embedded into the Designer client.
export function createAssistantDiagnosticsUi(deps) {
  const dict = {
    ru: {
      title: 'Диагностика Assistant', off: 'Выключено', basic: 'Основная', verbose: 'Подробная', mode: 'Режим захвата',
      apply: 'Применить режим', refresh: 'Обновить', clear: 'Удалить записи', search: 'Найти записи', request: 'Request ID', template: 'Шаблон',
      unknown: 'Статус не загружен', until: 'Действует до', expired: 'Окно захвата завершено', empty: 'Записей нет', open: 'Открыть', download: 'Скачать JSON',
      loading: 'Загрузка…', copy: 'Копировать', copied: 'Скопировано', copyFailed: 'Не удалось скопировать',
      sensitive: 'Подробный режим сохраняет промты, Notes и модель CMDBuild всех пользователей текущего контура. Эти данные остаются чувствительными после маскирования секретов.',
      confirm: 'Включить подробный захват для всех пользователей текущего контура? Промты и схема будут сохранены с ограниченным сроком хранения.',
      confirmClear: 'Удалить все сохранённые трассировки Assistant текущего контура?', admin: 'Подробные записи доступны только администратору.',
      trace: 'Запросы и ответы Assistant', unavailable: 'Подробная запись недоступна', partial: 'Запись содержит пропуски или ограничения объёма',
      progress: 'Запись ещё формируется. Обновите её после завершения запроса.', stored: 'Объём хранилища', evicted: 'Удалено старых записей',
      phase: 'Этап', status: 'Статус', time: 'Время', limits: 'Настройки захвата сохраняются общей кнопкой «Сохранить». Применение режима также сохраняет текущие настройки. Выключение не удаляет записи.'
    },
    en: {
      title: 'Assistant diagnostics', off: 'Off', basic: 'Basic', verbose: 'Verbose', mode: 'Capture mode',
      apply: 'Apply mode', refresh: 'Refresh', clear: 'Delete records', search: 'Find records', request: 'Request ID', template: 'Template',
      unknown: 'Status has not been loaded', until: 'Active until', expired: 'The capture window has ended', empty: 'No records', open: 'Open', download: 'Download JSON',
      loading: 'Loading…', copy: 'Copy', copied: 'Copied', copyFailed: 'Copy failed',
      sensitive: 'Verbose mode stores prompts, Notes and the CMDBuild model for all users in this deployment scope. This data remains sensitive after secret redaction.',
      confirm: 'Enable verbose capture for all users in this deployment scope? Prompts and schema will be stored for a limited time.',
      confirmClear: 'Delete all stored Assistant traces in this scope?', admin: 'Detailed records are available only to administrators.',
      trace: 'Assistant requests and responses', unavailable: 'Detailed record is unavailable', partial: 'This record contains omissions or size limits',
      progress: 'The record is still being captured. Refresh it after the request finishes.', stored: 'Stored bytes', evicted: 'Older records removed',
      phase: 'Phase', status: 'Status', time: 'Time', limits: 'Capture settings use the main Save button. Applying a mode also saves the current settings. Stopping capture does not delete records.'
    }
  };
  let ui = {};
  const e = deps.escapeHtml;
  const text = (key) => (dict[deps.getState().language] || dict.ru)[key] || key;
  const canManage = () => Boolean(deps.getState().session?.rolePrivileges?.admin_classes_modify);
  function sync() {
    const state = deps.getState();
    const root = String(state.root || 'Cst_QueryTool');
    if (ui.root !== root || ui.session !== state.session || ui.selection !== state.rootSelectionGeneration) ui = { root, session: state.session, selection: state.rootSelectionGeneration, generation: 0, status: null, traces: [], trace: null, error: '', busy: false, loaded: false, mode: 'Off', requestId: '', templateCode: '' };
    return root;
  }
  function owner() { sync(); return { instance: ui, root: ui.root, session: ui.session, selection: ui.selection }; }
  function current(token) { sync(); return canManage() && ui === token.instance && ui.session === token.session && ui.selection === token.selection && (token.generation === undefined || token.generation === ui.generation); }
  const path = (suffix) => deps.apiPrefix + '/assistant/diagnostics/' + suffix;
  const query = () => '?root=' + encodeURIComponent(sync());
  const id = (trace) => String(trace && (trace.id || trace.traceId) || '');
  function redraw() {
    if (typeof document === 'undefined') return;
    const panel = document.getElementById('cmdp-assistant-debug-panel');
    if (panel && panel.getAttribute('data-debug-root') === sync()) {
      const active = document.activeElement;
      const focus = active && panel.contains(active) ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
      panel.innerHTML = renderPanel();
      const restored = focus && document.getElementById(focus.id);
      if (restored) { restored.focus(); if (typeof restored.setSelectionRange === 'function' && focus.start !== null) restored.setSelectionRange(focus.start, focus.end); }
    }
  }
  async function call(suffix, options, token = owner()) {
    if (!current(token)) return null;
    const result = await deps.request(path(suffix) + '?root=' + encodeURIComponent(token.root), options);
    if (!result.ok || !result.json || result.json.success !== true) {
      const error = deps.createRequestError(result);
      error.status = result.status;
      throw error;
    }
    return result.json;
  }
  function errorMessage(error) { return deps.safeError ? deps.safeError(error) : String(error?.message || error).slice(0, 512); }
  async function update(work, token = owner()) {
    if (!current(token)) return;
    const generation = ++ui.generation;
    token.generation = generation;
    ui.busy = true; ui.error = ''; redraw();
    try {
      const apply = await work(token);
      if (current(token) && ui.generation === generation && typeof apply === 'function') apply();
    } catch (error) {
      if (current(token) && ui.generation === generation) ui.error = errorMessage(error);
    } finally {
      if (current(token) && ui.generation === generation) { ui.busy = false; redraw(); }
    }
  }
  function renderTrace(trace) {
    if (!trace) return '';
    const traceId = id(trace);
    const spans = Array.isArray(trace.spans) ? trace.spans : [];
    const partial = trace.truncated || trace.capture?.truncated || trace.capture?.omitted || trace.diagnostics?.truncated || trace.diagnostics?.omitted || trace.omissions?.length;
    return '<section data-assistant-debug-trace="' + e(traceId) + '"><h4>' + e(text('trace')) + '</h4>'
      + '<p class="code-inline">' + e(String(trace.requestId || traceId)) + '</p>'
      + (partial ? '<p class="notice warning">' + e(text('partial')) + '</p>' : '')
      + (['running', 'in_progress'].includes(trace.status) ? '<p role="status">' + e(text('progress')) + '</p>' : '')
      + '<div class="toolbar"><a class="button" href="' + e(path('traces/' + encodeURIComponent(traceId) + '/export') + query()) + '">' + e(text('download')) + '</a>'
      + '<button type="button" data-action="assistant-debug-open" data-trace-id="' + e(traceId) + '">' + e(text('refresh')) + '</button></div>'
      + '<pre class="code-inline" style="white-space:pre-wrap;overflow-wrap:anywhere">' + e(JSON.stringify({ mode: trace.mode, status: trace.status, capture: trace.capture, diagnostics: trace.diagnostics, limits: trace.limits, startedAt: trace.startedAt, finishedAt: trace.finishedAt }, null, 2)) + '</pre>'
      + spans.map((span) => '<details class="help-details" data-assistant-debug-span="' + e(String(span.id || '')) + '" data-trace-id="' + e(traceId) + '" data-debug-root="' + e(ui.root) + '">'
        + '<summary>' + e(String(span.kind || '') + ' · ' + String(span.name || span.path || span.id || '') + (span.statusCode ? ' · HTTP ' + span.statusCode : '')) + '</summary>'
        + '<p data-debug-span-status role="status"></p><button type="button" class="icon-button" data-action="assistant-debug-copy" title="' + e(text('copy')) + '" aria-label="' + e(text('copy')) + '">⧉</button>'
        + '<pre data-debug-span-body tabindex="0" style="max-height:600px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere"></pre></details>').join('') + '</section>';
  }
  function renderPanel() {
    const status = ui.status;
    const mode = status?.mode || 'Off';
    const active = status?.activeUntil && Date.parse(status.activeUntil) > Date.now();
    return '<div class="visual-grid"><label>' + e(text('mode')) + '<select id="cmdp-assistant-debug-mode"' + (ui.busy ? ' disabled' : '') + '>'
      + [['Off', 'off'], ['Basic', 'basic'], ['Verbose', 'verbose']].map(([value, key]) => '<option value="' + value + '"' + (ui.mode === value ? ' selected' : '') + '>' + e(text(key)) + '</option>').join('')
      + '</select></label></div><div class="toolbar"><button type="button" data-action="assistant-debug-apply"' + (ui.busy ? ' disabled' : '') + '>' + e(text('apply')) + '</button>'
      + '<button type="button" data-action="assistant-debug-status"' + (ui.busy ? ' disabled' : '') + '>' + e(text('refresh')) + '</button>'
      + '<button type="button" class="danger" data-action="assistant-debug-clear"' + (ui.busy ? ' disabled' : '') + '>' + e(text('clear')) + '</button></div>'
      + '<p role="status">' + e(ui.busy ? text('loading') : status ? text(mode === 'Verbose' && active ? 'verbose' : mode === 'Basic' && active ? 'basic' : 'off') + (status.activeUntil ? ' · ' + text('until') + ': ' + status.activeUntil : '') : text('unknown')) + '</p>'
      + (status ? '<p class="muted">' + e(text('stored') + ': ' + String(status.storedBytes ?? status.storageBytes ?? '—') + (status.evictedCount === undefined ? '' : ' · ' + text('evicted') + ': ' + String(status.evictedCount))) + '</p>' : '')
      + (ui.error ? '<p class="notice error" role="alert">' + e(ui.error) + '</p>' : '')
      + '<div class="visual-grid"><label>' + e(text('request')) + '<input id="cmdp-assistant-debug-request" maxlength="128" value="' + e(ui.requestId) + '"></label>'
      + '<label>' + e(text('template')) + '<input id="cmdp-assistant-debug-template" maxlength="128" value="' + e(ui.templateCode) + '"></label></div>'
      + '<button type="button" data-action="assistant-debug-search"' + (ui.busy ? ' disabled' : '') + '>' + e(text('search')) + '</button>'
      + '<div class="table-wrap" style="max-width:100%;min-width:0;overflow-x:auto"><table class="compact"><thead><tr>' + ['time', 'request', 'template', 'phase', 'status'].map((key) => '<th>' + e(text(key)) + '</th>').join('') + '<th></th></tr></thead><tbody>'
      + (ui.traces.length ? ui.traces.map((trace) => '<tr><td>' + e(String(trace.startedAt || '')) + '</td><td class="code-inline">' + e(String(trace.requestId || '')) + '</td><td>' + e(String(trace.templateCode || '')) + '</td><td>' + e(String(trace.action || trace.phase || '')) + '</td><td>' + e(String(trace.statusCode || trace.status || '')) + '</td><td><button type="button" data-action="assistant-debug-open" data-trace-id="' + e(id(trace)) + '">' + e(text('open')) + '</button></td></tr>').join('') : '<tr><td colspan="6">' + e(text('empty')) + '</td></tr>')
      + '</tbody></table></div>' + renderTrace(ui.trace);
  }
  function render() {
    sync();
    if (!canManage()) return '';
    if (!ui.loaded) { ui.loaded = true; Promise.resolve().then(refresh); }
    return '<h3>' + e(text('title')) + '</h3><p class="notice warning">' + e(text('sensitive')) + '</p><p class="muted">' + e(text('limits')) + '</p>'
      + '<div id="cmdp-assistant-debug-panel" style="min-width:0" data-debug-root="' + e(ui.root) + '">' + renderPanel() + '</div>';
  }
  function renderReference(ref) {
    if (!ref) return '';
    if (!canManage()) return '';
    if (!ref.traceId) return '<p class="notice warning">' + e(text('unavailable')) + (ref.warning ? ': ' + e(String(ref.warning)) : '') + '</p>';
    return '<details class="help-details" data-assistant-debug-reference="' + e(String(ref.traceId)) + '" data-debug-pending="' + (ref.storageStatus === 'pending' ? 'true' : 'false') + '" data-debug-root="' + e(sync()) + '"><summary>' + e(text('trace')) + '</summary><div data-debug-reference-content></div><button type="button" data-action="assistant-debug-open">' + e(text('refresh')) + '</button></details>';
  }
  function refresh() {
    if (!canManage()) return Promise.resolve();
    return update(async (token) => {
      const result = await call('status', undefined, token);
      return () => { ui.status = result.status; ui.mode = result.status?.mode || 'Off'; };
    });
  }
  function handleAction(target) {
    const action = target?.getAttribute('data-action') || '';
    if (!action.startsWith('assistant-debug-')) return false;
    if (!canManage()) return true;
    sync();
    const token = owner();
    if (action === 'assistant-debug-copy') {
      const details = target.closest('[data-assistant-debug-span]');
      const body = details?.querySelector('[data-debug-span-body]');
      const status = details?.querySelector('[data-debug-span-status]');
      Promise.resolve().then(() => navigator.clipboard.writeText(body?.textContent || '')).then(() => { if (status) status.textContent = text('copied'); }).catch(() => { if (status) status.textContent = text('copyFailed'); });
      return true;
    }
    ui.requestId = document.getElementById('cmdp-assistant-debug-request')?.value ?? ui.requestId;
    ui.templateCode = document.getElementById('cmdp-assistant-debug-template')?.value || '';
    ui.mode = document.getElementById('cmdp-assistant-debug-mode')?.value || ui.mode;
    if (action === 'assistant-debug-status') { refresh(); return true; }
    if (action === 'assistant-debug-apply') {
      const mode = ui.mode;
      if (mode === 'Verbose' && !window.confirm(text('confirm'))) return true;
      update(async () => {
        const policyPayload = mode === 'Off' ? null : deps.capturePolicy?.(token.root);
        let result;
        if (mode === 'Off') result = await call('capture', { method: 'DELETE' }, token);
        else {
          const policy = await deps.savePolicy(token.root, policyPayload);
          if (!current(token)) return;
          result = await call('capture', { method: 'POST', body: { mode, durationSec: policy.captureDurationSec, confirmed: true } }, token);
        }
        return () => { ui.status = result.status; ui.mode = result.status?.mode || mode; };
      }, token);
    } else if (action === 'assistant-debug-clear') {
      if (!window.confirm(text('confirmClear'))) return true;
      update(async () => { await call('traces', { method: 'DELETE' }, token); return () => { ui.traces = []; ui.trace = null; }; }, token);
    } else if (action === 'assistant-debug-search') {
      const requestId = ui.requestId, templateCode = ui.templateCode;
      update(async () => {
        const suffix = 'traces';
        const result = await deps.request(path(suffix) + '?root=' + encodeURIComponent(token.root) + '&requestId=' + encodeURIComponent(requestId) + '&templateCode=' + encodeURIComponent(templateCode));
        if (!result.ok || result.json?.success !== true) throw deps.createRequestError(result);
        return () => { ui.traces = result.json.traces || []; };
      });
    } else if (action === 'assistant-debug-open') {
      const traceId = target.getAttribute('data-trace-id') || '';
      const reference = target.closest('[data-assistant-debug-reference]');
      if (reference) {
        reference.dataset.debugLoaded = 'false';
        handleToggle({ target: reference });
        return true;
      }
      update(async () => { const result = await call('traces/' + encodeURIComponent(traceId), undefined, token); return () => { ui.trace = result.trace; }; }, token);
    }
    return true;
  }
  async function handleToggle(event) {
    const target = event.target;
    if (!target?.open || !canManage()) return;
    const root = target.getAttribute('data-debug-root');
    if (root !== sync() || target.dataset.debugLoaded === 'true' || target.dataset.debugLoading === 'true') return;
    const token = owner();
    const spanId = target.getAttribute('data-assistant-debug-span');
    const traceId = spanId ? target.getAttribute('data-trace-id') : target.getAttribute('data-assistant-debug-reference');
    if (!traceId) return;
    target.dataset.debugLoading = 'true';
    const output = spanId ? target.querySelector('[data-debug-span-body]') : target.querySelector('[data-debug-reference-content]');
    if (!output) return;
    output.textContent = text('loading');
    try {
      const deadline = Date.now() + 5000;
      const pending = target.getAttribute('data-debug-pending') === 'true';
      let result;
      for (;;) {
        try { result = await call('traces/' + encodeURIComponent(traceId) + (spanId ? '/spans/' + encodeURIComponent(spanId) : ''), pending ? { timeoutMs: Math.max(1, deadline - Date.now()), maxRetries: 0 } : undefined, token); break; }
        catch (error) {
          if (target.getAttribute('data-debug-pending') !== 'true' || error.status !== 404 || Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
          if (!target.isConnected || !target.open || !current(token)) return;
        }
      }
      if (!target.isConnected || !current(token)) return;
      if (spanId) output.textContent = JSON.stringify(result.span, null, 2);
      else output.innerHTML = renderTrace(result.trace);
      target.dataset.debugLoaded = 'true';
    } catch (error) { if (target.isConnected && current(token)) output.textContent = target.getAttribute('data-debug-pending') === 'true' && error.status === 404 ? text('progress') : errorMessage(error); }
    finally { target.dataset.debugLoading = 'false'; }
  }
  function handleInput(event) {
    const target = event.target;
    sync();
    if (target?.id === 'cmdp-assistant-debug-request') ui.requestId = target.value;
    if (target?.id === 'cmdp-assistant-debug-template') ui.templateCode = target.value;
    if (target?.id === 'cmdp-assistant-debug-mode') ui.mode = target.value;
  }
  return { render, renderReference, handleAction, handleToggle, handleInput, refresh, text };
}
