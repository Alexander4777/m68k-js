import test from "node:test";
import assert from "node:assert/strict";
import { M68K, MemoryBus, M68K_REG } from "../src/index.js";

function setup(words, pc = 0x800) {
  const ram = new Uint8Array(0x10000);
  const bus = new MemoryBus().map(0, ram);
  const cpu = new M68K({ bus });
  ram[0] = 0; ram[1] = 0; ram[2] = 0x10; ram[3] = 0;
  ram[4] = 0; ram[5] = 0; ram[6] = pc >>> 8; ram[7] = pc & 0xff;
  words.forEach((word, index) => {
    ram[pc + index * 2] = word >>> 8;
    ram[pc + index * 2 + 1] = word & 0xff;
  });
  cpu.reset();
  return { cpu, ram };
}

test("MOVEQ # -1,D0", () => {
  const { cpu } = setup([0x70ff]);
  cpu.step();
  assert.equal(cpu.getReg(M68K_REG.D0), 0xffffffff);
  assert.equal(cpu.getReg(M68K_REG.SR) & 0x08, 0x08);
});

test("MOVE.L D0,D1", () => {
  const { cpu } = setup([0x2001]);
  cpu.setReg(M68K_REG.D1, 0x12345678);
  cpu.step();
  assert.equal(cpu.getReg(M68K_REG.D0), 0x12345678);
});

test("ADDQ.L #1,D0", () => {
  const { cpu } = setup([0x5280]);
  cpu.setReg(M68K_REG.D0, 0x10);
  cpu.step();
  assert.equal(cpu.getReg(M68K_REG.D0), 0x11);
});

test("LEA (A0),A1", () => {
  // LEA (A0),A1 is 0x43D0: the destination is An in bits 2..0 and the
  // base register of the EA is in bits 11..9.
  const { cpu } = setup([0x43d0]);
  cpu.setReg(M68K_REG.A0, 0x1234);
  cpu.step();
  assert.equal(cpu.getReg(M68K_REG.A1), 0x1234);
});

test("CLR.L D0", () => {
  const { cpu } = setup([0x4280]);
  cpu.setReg(M68K_REG.D0, 0xffffffff);
  cpu.step();
  assert.equal(cpu.getReg(M68K_REG.D0), 0);
  assert.equal(cpu.getReg(M68K_REG.SR) & 0x04, 0x04);
});

test("DBRA D0 works", () => {
  const { cpu } = setup([0x51c8, 0xfffe]);
  cpu.setReg(M68K_REG.D0, 2);
  cpu.step();
  assert.equal(cpu.getReg(M68K_REG.D0), 1);
  assert.equal(cpu.getReg(M68K_REG.PC), 0x802);
});
