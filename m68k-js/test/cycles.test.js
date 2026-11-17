import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mainCycles, subCycles } from '../src/tables.js';

const musashi = new URL('../../m68k/', import.meta.url);

function parseMusashiTable(file) {
  const source = readFileSync(new URL(file, musashi), 'utf8');
  const body = source.slice(source.indexOf('{') + 1, source.lastIndexOf('}'));
  const values = body.match(/\d+\s*\*\s*\d+/g) ?? [];
  assert.equal(values.length, 65536, `${file} should have 65536 entries`);
  return values.map((entry) => {
    const [base, multiplier] = entry.split('*').map((part) => Number.parseInt(part, 10));
    return base * multiplier;
  });
}

test('the main cycle table matches Musashi exactly', () => {
  const expected = parseMusashiTable('m68ki_cycles.h');
  assert.equal(mainCycles.length, 65536);
  for (let opcode = 0; opcode < 65536; opcode++) {
    assert.equal(mainCycles[opcode], expected[opcode], `opcode 0x${opcode.toString(16)}`);
  }
});

test('the sub CPU cycle table matches Musashi exactly', () => {
  const expected = parseMusashiTable('s68ki_cycles.h');
  assert.equal(subCycles.length, 65536);
  for (let opcode = 0; opcode < 65536; opcode++) {
    assert.equal(subCycles[opcode], expected[opcode], `opcode 0x${opcode.toString(16)}`);
  }
});

test('well known opcodes have the expected master cycle cost', () => {
  // Verified against the Musashi C core.
  const cases = {
    0x23c0: 140, // MOVE.L D0,(xxx).L
    0x23fc: 196, // MOVE.L #imm,(xxx).L
    0x40c0: 42,  // MOVE SR,D0
    0x44c0: 84,  // MOVE D0,CCR
    0x46c0: 84,  // MOVE D0,SR
    0x007c: 140, // ORI #imm,SR
    0x7000: 28,  // MOVEQ
    0x6000: 70,  // BRA
  };
  for (const [opcode, cycles] of Object.entries(cases)) {
    assert.equal(mainCycles[Number(opcode)], cycles, `opcode 0x${opcode}`);
  }
});
