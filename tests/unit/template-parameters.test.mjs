import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { resolveTemplateParameters } from '../../scripts/template-parameters.mjs';
import { applyTemplateParamDefaults } from '../../scripts/dev-proxy-server.mjs';

test('parameter defaults retain runtime precedence and expose all physical sources', () => {
  const spec = { defaults: { location: 901 }, paramDefaults: { location: 902 },
    params: { location: { type: 'integer', default: 903, defaultValue: 904 } } };
  for (const [path, value] of [
    ['$.spec.defaults.location', 901], ['$.spec.paramDefaults.location', 902],
    ['$.spec.params.location.default', 903], ['$.spec.params.location.defaultValue', 904]
  ]) {
    const resolved = resolveTemplateParameters(spec);
    assert.deepEqual(resolved.values, { location: value });
    assert.equal(resolved.origins.location, path);
    assert.equal(resolved.candidates.filter((item) => item.effective).length, 1);
    assert.ok(resolved.candidates.filter((item) => !item.effective).every((item) => item.shadowedBy === path));
    assert.deepEqual(applyTemplateParamDefaults(spec, {}), resolved.values);
    if (spec.defaults) delete spec.defaults;
    else if (spec.paramDefaults) delete spec.paramDefaults;
    else delete spec.params.location.default;
  }
});

test('null, empty and explicit runtime values keep existing semantics', () => {
  const cases = [
    [{ defaults: { p: null }, paramDefaults: { p: 0 }, params: { p: { default: 2 } } }, {}, { p: 0 }],
    [{ defaults: { p: '' }, params: { p: { default: 2 } } }, {}, { p: '' }],
    [{ params: { p: { default: null, defaultValue: 2 } } }, {}, { p: null }],
    [{ params: { p: { default: false } } }, { p: '' }, { p: false }],
    [{ params: { p: { default: 1 } } }, { p: null }, { p: 1 }],
    [{ params: { p: { default: 1 } } }, { p: 2 }, { p: 2 }],
    [{}, { p: '' }, { p: '' }],
    [{ classNameFallback: 'Asset', params: { className: { default: 'Other' } } }, {}, { className: 'Asset' }],
    [{ defaults: { className: 'First' }, classNameFallback: 'Asset' }, {}, { className: 'First' }],
    [{ params: { p: { defaultValue: [1, 2] } } }, {}, { p: [1, 2] }]
  ];
  for (const [spec, params, expected] of cases) {
    const before = structuredClone({ spec, params });
    const resolved = resolveTemplateParameters(spec, params);
    assert.deepEqual(resolved.values, expected);
    assert.deepEqual(applyTemplateParamDefaults(spec, params), expected);
    assert.deepEqual({ spec, params }, before);
  }
});

test('resolver is self-contained in the browser and keeps reference metadata out of values', () => {
  const spec = { params: { location: { type: 'integer', referenceType: 'card', targetClass: 'Location', defaultValue: 902 } } };
  const browser = vm.runInNewContext(`(${resolveTemplateParameters.toString()})(${JSON.stringify(spec)})`);
  assert.deepEqual(JSON.parse(JSON.stringify(browser)), resolveTemplateParameters(spec));
  assert.deepEqual(browser.values.location, 902);
  assert.equal(browser.candidates[0].path, '$.spec.params.location.defaultValue');
});

test('parameter names cannot modify object prototypes', () => {
  const spec = JSON.parse('{"defaults":{"__proto__":5,"constructor":6}}');
  const result = resolveTemplateParameters(spec);
  assert.equal(Object.getPrototypeOf(result.values), Object.prototype);
  assert.equal(Object.hasOwn(result.values, '__proto__'), true);
  assert.equal(result.values.constructor, 6);
});
