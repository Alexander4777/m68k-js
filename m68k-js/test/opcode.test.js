import test from 'node:test';
import assert from 'node:assert/strict';
import { opcodeInfo, OPCODE_NAMES } from '../src/index.js';

test('opcode table covers all 65536 encodings', () => {
  assert.equal(OPCODE_NAMES.length, 65536);
  assert.equal(opcodeInfo(0x4e71).name, 'm68k_op_nop');
  assert.equal(opcodeInfo(0x4e72).legal, false);
});
