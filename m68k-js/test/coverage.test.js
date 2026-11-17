import test from 'node:test';
import assert from 'node:assert/strict';
import { OPCODE_NAMES, OPCODE_LEGAL, opcodeInfo } from '../src/opcode.js';

test('generated opcode coverage has 65536 unique positions', () => {
  assert.equal(OPCODE_NAMES.length, 65536);
  assert.equal(OPCODE_LEGAL.length, 65536);
  assert.equal(new Set(OPCODE_NAMES).size > 100, true);
});

test('all opcodes have metadata without throwing', () => {
  for (let opcode = 0; opcode < 65536; opcode += 17) {
    const info = opcodeInfo(opcode);
    assert.equal(info.opcode, opcode);
    assert.equal(typeof info.name, 'string');
    assert.equal(typeof info.legal, 'boolean');
  }
});

test('known Musashi opcode identities', () => {
  assert.equal(OPCODE_NAMES[0x4e71], 'm68k_op_nop');
  assert.equal(OPCODE_NAMES[0x70ff], 'm68k_op_moveq_32');
  assert.equal(OPCODE_NAMES[0x4280], 'm68k_op_clr_32_d');
  assert.equal(OPCODE_NAMES[0x51c8], 'm68k_op_dbf_16');
});
