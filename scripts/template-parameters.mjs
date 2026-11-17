// Self-contained so the same resolver can be embedded in the browser client.
export function resolveTemplateParameters(spec, params = {}) {
  const values = {};
  const origins = {};
  const candidates = [];
  const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const child = (path, key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
  const set = (name, value, path) => {
    Object.defineProperty(values, name, { value, enumerable: true, configurable: true, writable: true });
    Object.defineProperty(origins, name, { value: path, enumerable: true, configurable: true, writable: true });
  };
  const defined = (name) => Object.hasOwn(values, name) && values[name] !== undefined;
  const candidate = (parameterName, path, value) => {
    if (value !== undefined) candidates.push({ parameterName, path, value });
  };
  for (const key of ['defaults', 'paramDefaults']) {
    const source = spec && spec[key];
    if (!record(source)) continue;
    for (const [name, value] of Object.entries(source)) {
      const path = child(`$.spec.${key}`, name);
      candidate(name, path, value);
      if (value !== undefined && value !== null && !defined(name)) set(name, value, path);
    }
  }
  if (spec && spec.classNameFallback) {
    const path = '$.spec.classNameFallback';
    candidate('className', path, spec.classNameFallback);
    if (!defined('className')) set('className', spec.classNameFallback, path);
  }
  const definitions = spec && spec.params;
  if (record(definitions)) {
    for (const [name, definition] of Object.entries(definitions)) {
      if (!record(definition)) continue;
      const path = child('$.spec.params', name);
      candidate(name, `${path}.default`, definition.default);
      candidate(name, `${path}.defaultValue`, definition.defaultValue);
      if (defined(name)) continue;
      if (definition.default !== undefined) set(name, definition.default, `${path}.default`);
      else if (definition.defaultValue !== undefined) set(name, definition.defaultValue, `${path}.defaultValue`);
    }
  }
  if (record(params)) {
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '' && defined(name)) continue;
      set(name, value, child('$.params', name));
    }
  }
  return { values, origins, candidates: candidates.map((item) => ({
    ...item, effective: origins[item.parameterName] === item.path,
    shadowedBy: origins[item.parameterName] === item.path ? '' : origins[item.parameterName] || ''
  })) };
}
