import { u8, u16, u32, sx8, sx16 } from "./registers.js";

export const EA = Object.freeze({
  DN: 0, AN: 1, AI: 2, PI: 3, PD: 4, DI: 5, IX: 6,
  AW: 7, AL: 8, PCDI: 9, PCIX: 10, IMM: 11,
});

export const EA_MODE = Object.freeze({
  DN: 0, AN: 1, AI: 2, PI: 3, PD: 4, DI: 5, IX: 6,
  AW: 7, AL: 8, PCDI: 9, PCIX: 10, IMM: 11,
});

// The 68000 effective-address mode is always three bits. Special
// destination modes (absolute, PC-relative and immediate) are selected by
// mode 7 plus a register field.

export class EffectiveAddress {
  constructor(cpu) { this.cpu = cpu; }

  decode(mode, reg, size) {
    const cpu = this.cpu;
    const r = cpu.r;
    switch (mode) {
      case EA.DN: return { type: EA.DN, reg };
      case EA.AN: return { type: EA.AN, reg, address: u32(r.a[reg]) };
      case EA.AI: return { type: EA.AI, reg, address: u32(r.a[reg]) };
      case EA.PI: return { type: EA.PI, reg, address: this.postincrement(size, reg) };
      case EA.PD: return { type: EA.PD, reg, address: this.predecrement(size, reg) };
      case EA.DI: return { type: EA.DI, reg, address: u32(r.a[reg] + sx16(cpu.fetch16())) };
      case EA.IX: return { type: EA.IX, reg, address: this.index(r.a[reg]) };
      case 7:
        switch (reg) {
          case 0: return { type: EA.AW, address: u32(sx16(cpu.fetch16())) };
          case 1: return { type: EA.AL, address: cpu.fetch32() };
          case 2: {
            const base = r.pc;
            return { type: EA.PCDI, address: u32(base + sx16(cpu.fetch16())) };
          }
          case 3: return { type: EA.PCIX, address: this.index(r.pc) };
          case 4: return { type: EA.IMM, value: size === 1 ? u8(cpu.fetch16()) : size === 2 ? cpu.fetch16() : cpu.fetch32() };
          default: throw new Error(`Invalid effective address mode 7/${reg}`);
        }
      case EA.PCDI: {
        const base = r.pc;
        return { type: EA.PCDI, address: u32(base + sx16(cpu.fetch16())) };
      }
      case EA.PCIX: return { type: EA.PCIX, address: this.index(r.pc) };
      case EA.IMM: return { type: EA.IMM, value: size === 1 ? u8(cpu.fetch16()) : size === 2 ? cpu.fetch16() : cpu.fetch32() };
      default: throw new Error(`Invalid effective address mode ${mode}`);
    }
  }

  predecrement(size, reg) {
    const r = this.cpu.r;
    const step = size === 1 ? 1 : size === 2 ? 2 : 4;
    r.a[reg] = u32(r.a[reg] - step);
    if (reg === 7 && size === 1) r.a[7] = u32(r.a[7] - 1);
    return r.a[reg];
  }

  postincrement(size, reg) {
    const r = this.cpu.r;
    const address = r.a[reg];
    const step = size === 1 ? 1 : size === 2 ? 2 : 4;
    r.a[reg] = u32(address + step);
    if (reg === 7 && size === 1) r.a[7] = u32(r.a[7] + 1);
    return address;
  }

  index(base) {
    const cpu = this.cpu;
    const extension = cpu.fetch16();
    const indexRegister = (extension >>> 12) & 0xf;
    let index = indexRegister < 8 ? cpu.r.d[indexRegister] : cpu.r.a[indexRegister - 8];
    if ((extension & 0x0800) === 0) index = u32(sx16(index));
    const scale = 1 << ((extension >>> 9) & 3);
    return u32(base + index * scale + sx8(extension & 0xff));
  }
}
