import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeRowIdentity, runtimeRowValue, setRuntimeRowSemantics, inheritRuntimeRowSemantics,
  mergeRuntimeRowSemantics, deriveRuntimeRowSemantics, setRuntimeRowValue } from '../../scripts/runtime-row-semantics.mjs';

test('typed identities and raw values are not enumerable or serialized', () => {
  const row = { Class: 'Item', _id: 1, Category: 'Same' };
  setRuntimeRowSemantics(row, ['card', 'Item', 1], { ...row, Category: 10 });
  assert.equal(runtimeRowValue(row, 'Category'), 10);
  assert.equal(row.Category, 'Same');
  assert.deepEqual(Object.keys(row), ['Class', '_id', 'Category']);
  assert.equal(JSON.stringify(row), '{"Class":"Item","_id":1,"Category":"Same"}');
  const text = { ...row, _id: '1' };
  setRuntimeRowSemantics(text, ['card', 'Item', '1']);
  assert.notEqual(runtimeRowIdentity(text), runtimeRowIdentity(row));
});

test('copies keep identity and raw fields; joined rows keep both sides including nested pairs', () => {
  const left = { Class: 'A', _id: 1, Category: 'Same' };
  setRuntimeRowSemantics(left, ['card', 'A', 1], { ...left, Category: 10 });
  const copy = inheritRuntimeRowSemantics({ ...left }, left);
  assert.equal(runtimeRowIdentity(copy), runtimeRowIdentity(left));
  assert.equal(runtimeRowValue(copy, 'Category'), 10);
  const make = (id) => {
    const right = { Class: 'B', _id: id, Category: 'Same' };
    setRuntimeRowSemantics(right, ['card', 'B', id], { ...right, Category: id + 10 });
    return mergeRuntimeRowSemantics({ ...left, right_Id: id, right_Category: 'Same' }, copy, right,
      Object.keys(copy), [{ source: '_id', target: 'right_Id' }, { source: 'Category', target: 'right_Category' }]);
  };
  assert.notEqual(runtimeRowIdentity(make(1)), runtimeRowIdentity(make(2)));
  assert.equal(runtimeRowValue(make(2), 'right_Category'), 12);
  assert.equal(runtimeRowIdentity(make(2)), runtimeRowIdentity(make(2)));
});

test('derived occurrences differ while added projections preserve record identity', () => {
  const row = { Class: 'A', _id: 1 };
  const identity = runtimeRowIdentity(row);
  setRuntimeRowValue(row, 'owner.Category', 30);
  assert.equal(runtimeRowIdentity(row), identity);
  assert.equal(runtimeRowValue(row, 'owner.Category'), 30);
  const first = deriveRuntimeRowSemantics({ ...row, Owner: 'A' }, row, 'owner:1', { Owner: 10 });
  const second = deriveRuntimeRowSemantics({ ...row, Owner: 'A' }, row, 'owner:2', { Owner: 20 });
  assert.notEqual(runtimeRowIdentity(first), runtimeRowIdentity(second));
  assert.equal(runtimeRowValue(first, 'Owner'), 10);
});

test('anonymous rows use order-independent object fingerprints, not Code or row index', () => {
  assert.equal(runtimeRowIdentity({ Code: 'x', Value: 1 }), runtimeRowIdentity({ Value: 1, Code: 'x' }));
  assert.notEqual(runtimeRowIdentity({ Code: 'x', Value: 1 }), runtimeRowIdentity({ Code: 'x', Value: 2 }));
});

test('nested pair identities are bounded and include every participant', () => {
  let row = { Class: 'Item', _id: 1 };
  for (let i = 2; i <= 32; i++) {
    row = mergeRuntimeRowSemantics({ ...row }, row, { Class: 'Item', _id: i }, Object.keys(row), []);
    assert.equal(runtimeRowIdentity(row).length, 64);
  }
  const different = mergeRuntimeRowSemantics({ ...row }, row, { Class: 'Item', _id: 100 }, Object.keys(row), []);
  assert.notEqual(runtimeRowIdentity(row), runtimeRowIdentity(different));
});
