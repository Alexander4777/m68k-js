import test from 'node:test';
import assert from 'node:assert/strict';
import { M68K, MemoryBus } from '../src/index.js';

// Build a CPU whose reset vectors point at `code` (loaded at 0x0008).
function setup(code) {
  const ram = new Uint8Array(0x10000);
  const bus = new MemoryBus().map(0, ram);
  ram[0] = 0x00; ram[1] = 0x00; ram[2] = 0x20; ram[3] = 0x00; // SSP = 0x2000
  ram[4] = 0x00; ram[5] = 0x00; ram[6] = 0x00; ram[7] = 0x08; // PC  = 0x0008
  code.forEach((byte, i) => { ram[8 + i] = byte; });
  const cpu = new M68K({ bus });
  cpu.reset();
  return { cpu, ram };
}

test('reset leaves the Musashi CCR with Z set (SR = 0x2704)', () => {
  const { cpu } = setup([0x4e, 0x71]);
  assert.equal(cpu.getSR(), 0x2704);
  assert.equal(cpu.r.z, 1);
  assert.equal(cpu.r.n, 0);
  assert.equal(cpu.r.supervisor, true);
});

test('setSR decodes the supervisor bit from bit 13 (0x2000)', () => {
  const { cpu } = setup([0x4e, 0x71]);
  // Verified against the C core: set 0x0000 -> 0x0000, 0x0800 -> 0x0000,
  // 0x2000 -> 0x2000, 0x2700 -> 0x2700, 0x2f00 -> 0x2700.
  cpu.setSR(0x0000);
  assert.equal(cpu.getSR(), 0x0000);
  assert.equal(cpu.r.supervisor, false);

  cpu.setSR(0x0800);
  assert.equal(cpu.getSR(), 0x0000);

  cpu.setSR(0x2000);
  assert.equal(cpu.getSR(), 0x2000);
  assert.equal(cpu.r.supervisor, true);

  cpu.setSR(0x2700);
  assert.equal(cpu.getSR(), 0x2700);

  cpu.setSR(0x2f00);
  assert.equal(cpu.getSR(), 0x2700);
});

test('MOVE SR,Dn copies the full public status register', () => {
  // MOVE SR,D0 (0x40C0)
  const { cpu } = setup([0x40, 0xc0]);
  cpu.step();
  assert.equal(cpu.r.d[0], 0x2704);
});

test('MOVE Dn,SR loads the status register (privileged)', () => {
  // MOVEQ #0,D0 ; MOVE D0,SR (0x46C0)
  const { cpu } = setup([0x70, 0x00, 0x46, 0xc0]);
  cpu.step();
  assert.equal(cpu.r.d[0], 0);
  cpu.step();
  assert.equal(cpu.getSR(), 0x0000);
  assert.equal(cpu.r.supervisor, false);
});

test('MOVE Dn,CCR only loads the condition codes', () => {
  // MOVEQ #$1F,D0 ; MOVE D0,CCR (0x44C0)
  const { cpu } = setup([0x70, 0x1f, 0x44, 0xc0]);
  cpu.step();
  const before = cpu.getSR();
  cpu.step();
  assert.equal(cpu.getSR() & 0x1f, 0x1f);
  // The supervisor bit and interrupt mask must be untouched.
  assert.equal(cpu.getSR() & 0xff00, before & 0xff00);
});

test('ANDI/ORI/EORI to SR apply the immediate to the whole SR', () => {
  // Values verified against the Musashi C core through the test harness.
  //
  //   ANDI #$FF00,SR -> 0x2700
  //   ORI  #$FF00,SR -> 0xA704 (the immediate also sets the trace bit)
  //   EORI #$FF00,SR -> 0x8004 (the immediate clears S and the mask)
  //   ORI  #$0700,SR -> 0x2704
  //   EORI #$0800,SR -> 0x2704
  const { cpu } = setup([0x02, 0x7c, 0xff, 0x00]);
  cpu.step();
  assert.equal(cpu.getSR(), 0x2700);

  const { cpu: cpu2 } = setup([0x00, 0x7c, 0xff, 0x00]);
  cpu2.step();
  assert.equal(cpu2.getSR(), 0xa704);
  assert.equal(cpu2.r.supervisor, true);

  const { cpu: cpu3 } = setup([0x0a, 0x7c, 0xff, 0x00]);
  cpu3.step();
  assert.equal(cpu3.getSR(), 0x8004);
  assert.equal(cpu3.r.supervisor, false);

  const { cpu: cpu4 } = setup([0x00, 0x7c, 0x07, 0x00]);
  cpu4.step();
  assert.equal(cpu4.getSR(), 0x2704);
  assert.equal(cpu4.r.supervisor, true);

  const { cpu: cpu5 } = setup([0x0a, 0x7c, 0x08, 0x00]);
  cpu5.step();
  assert.equal(cpu5.getSR(), 0x2704);
  assert.equal(cpu5.r.supervisor, true);
});

test('CMPI updates N/Z/V/C but leaves X untouched', () => {
  // MOVEQ #0,D0 ; CMPI.L #$10,D0 (0x0C80) : borrow -> C=1, X must stay 0.
  const { cpu } = setup([0x70, 0x00, 0x0c, 0x80, 0x00, 0x00, 0x00, 0x10]);
  cpu.step();
  assert.equal(cpu.r.x, 0);
  cpu.step();
  assert.equal(cpu.r.c, 1);
  assert.equal(cpu.r.n, 1);
  assert.equal(cpu.r.z, 0);
  assert.equal(cpu.r.x, 0, 'CMPI must not update X');
});
