import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonl } from '../../global/dashboard/lib/jsonl.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'cvr-dash-')); }

test('readJsonl skips a broken middle line', () => {
  const d = tmp();
  try {
    const f = join(d, 'a.jsonl');
    writeFileSync(f, '{"a":1}\nnot json\n{"a":3}\n');
    const { records, endByte } = readJsonl(f);
    assert.deepEqual(records, [{ a: 1 }, { a: 3 }]);
    assert.equal(endByte, Buffer.byteLength('{"a":1}\nnot json\n{"a":3}\n'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('readJsonl leaves a partial last line for next read', () => {
  const d = tmp();
  try {
    const f = join(d, 'a.jsonl');
    writeFileSync(f, '{"a":1}\n{"b":');
    const first = readJsonl(f);
    assert.deepEqual(first.records, [{ a: 1 }]);
    assert.equal(first.endByte, Buffer.byteLength('{"a":1}\n'));
    appendFileSync(f, '2}\n');
    const second = readJsonl(f, { fromByte: first.endByte });
    assert.deepEqual(second.records, [{ b: 2 }]);
    assert.equal(second.endByte, Buffer.byteLength('{"a":1}\n{"b":2}\n'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('readJsonl on a missing file returns empty', () => {
  const r = readJsonl(join(tmpdir(), 'cvr-dash-does-not-exist.jsonl'));
  assert.deepEqual(r, { records: [], endByte: 0 });
});
