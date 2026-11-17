import { M68K, MemoryBus, M68K_REG } from "../src/index.js";

const ram = new Uint8Array(0x10000);
const bus = new MemoryBus().map(0, ram);
const cpu = new M68K({ bus });

// Initial SSP = 0x00001000, initial PC = 0x00000800.
ram[0] = 0x00; ram[1] = 0x00; ram[2] = 0x10; ram[3] = 0x00;
ram[4] = 0x00; ram[5] = 0x00; ram[6] = 0x08; ram[7] = 0x00;

// MOVEQ #-1,D0
ram[0x800] = 0x70;
ram[0x801] = 0xff;

cpu.reset();
cpu.step();

console.log({
  pc: `0x${cpu.getReg(M68K_REG.PC).toString(16)}`,
  d0: `0x${cpu.getReg(M68K_REG.D0).toString(16)}`,
  sr: `0x${cpu.getReg(M68K_REG.SR).toString(16)}`,
});
