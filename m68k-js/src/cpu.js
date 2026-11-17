import { MemoryBus } from "./memory.js";
import { EffectiveAddress, EA } from "./ea.js";
import { Registers, u8, u16, u32, sx8, sx16, sx32, maskFor, signFor, bitsFromSize, sizeFromBits } from "./registers.js";
import { mainCycles, subCycles, exceptionCycles, interruptCycles, subIrqLevels, handlerSignatures, shift8, shift16, shift32 } from "./tables.js";
import { M68K_REG, M68K_IRQ, M68K_INT_ACK_AUTOVECTOR, M68K_INT_ACK_SPURIOUS, STOP_LEVEL, EXCEPTION } from "./constants.js";

export { EXCEPTION };

const CYCLE_TABLE = mainCycles;
const STOP = STOP_LEVEL.STOP;
const HALT = STOP_LEVEL.HALT;
const WAIT = STOP_LEVEL.WAIT;

export class M68K {
  constructor(options = {}) {
    this.bus = options.bus ?? new MemoryBus();
    this.r = new Registers();
    this.ea = new EffectiveAddress(this);
    this.mul = options.mul ?? 7;
    this.cycles = 0;
    this.cycleEnd = 0;
    this.refreshCycles = 0;
    this.intLevel = 0;
    this.stopped = 0;
    this.irqLatency = false;
    this.instruction = 0;
    this.callbacks = {
      intAck: null,
      resetInstruction: null,
      tas: null,
      setFunctionCode: null,
    };
    this.options = {
      prefetch: options.prefetch ?? false,
      addressError: options.addressError ?? true,
      trace: options.trace ?? false,
      tasCallback: options.tasCallback ?? false,
      subCpu: options.subCpu ?? false,
    };
  }

  read8(address) { return this.bus.read8(address); }
  read16(address) { return this.bus.read16(address); }
  read32(address) { return this.bus.read32(address); }
  write8(address, value) { this.bus.write8(address, value); }
  write16(address, value) { this.bus.write16(address, value); }
  write32(address, value) { this.bus.write32(address, value); }

  fetch8() {
    const address = this.r.pc;
    this.r.pc = u32(this.r.pc + 1);
    return this.bus.readImmediate8(address);
  }

  fetch16() {
    const address = this.r.pc;
    this.r.pc = u32(this.r.pc + 2);
    const value = this.bus.readImmediate16(address);
    if (this.options.prefetch) {
      this.prefAddr = this.r.pc;
      this.prefData = this.bus.readImmediate16(this.r.pc);
    }
    return value;
  }

  fetch32() {
    const address = this.r.pc;
    this.r.pc = u32(this.r.pc + 4);
    return this.bus.readImmediate32(address);
  }

  reset() {
    this.stopped = 0;
    // Musashi's reset leaves the CCR with Z set: the core stores the
    // inverted Z flag in `not_z_flag`, which is zero-initialised, and the
    // public SR exposes `!not_z_flag` on bit 2. The resulting reset SR is
    // therefore 0x2704 (supervisor + interrupt mask 7 + Z).
    this.r.sr = 0x2704;
    this.r.setSupervisorWithoutStackSwap(true);
    this.intLevel = 0;
    this.irqLatency = false;
    const ssp = this.bus.readImmediate32(0);
    const pc = this.bus.readImmediate32(4);
    // Musashi reads the initial vectors from the 24-bit 68000 address space.
    this.r.pc = pc & 0x00ffffff;
    // Musashi loads the initial supervisor stack pointer straight into the
    // active stack pointer (A7); sp[4] is left untouched.
    this.r.a[7] = ssp;
    this.r.sp.fill(0);
    this.cycles += exceptionCycles[EXCEPTION.RESET] * this.mul;
    this.refreshCycles = Math.floor(this.cycles / (128 * 7)) * (128 * 7) + 128 * 7;
  }

  /** STOP #sr: update SR and wait for an interrupt. */
  stop(value) {
    this.setSR(value);
    this.stopped = STOP;
    this.stopPc = this.r.pc;
  }

  getReg(reg) {
    const r = this.r;
    if (reg >= M68K_REG.D0 && reg <= M68K_REG.D7) return r.d[reg - M68K_REG.D0] >>> 0;
    if (reg >= M68K_REG.A0 && reg <= M68K_REG.A6) return r.a[reg - M68K_REG.A0] >>> 0;
    if (reg === M68K_REG.A7) return r.a7 >>> 0;
    switch (reg) {
      case M68K_REG.PC: return r.pc >>> 0;
      case M68K_REG.SR: return r.sr >>> 0;
      case M68K_REG.SP: return r.a7 >>> 0;
      case M68K_REG.USP: return r.usp >>> 0;
      case M68K_REG.ISP: return r.isp >>> 0;
      case M68K_REG.IR: return r.ir & 0xffff;
      default: return 0;
    }
  }

  setReg(reg, value) {
    const r = this.r;
    if (reg >= M68K_REG.D0 && reg <= M68K_REG.D7) { r.d[reg - M68K_REG.D0] = u32(value); return; }
    if (reg >= M68K_REG.A0 && reg <= M68K_REG.A6) { r.a[reg - M68K_REG.A0] = u32(value); return; }
    if (reg === M68K_REG.A7) { r.a7 = u32(value); return; }
    switch (reg) {
      case M68K_REG.PC: r.pc = u32(value); break;
      case M68K_REG.SR: this.setSR(value); break;
      case M68K_REG.SP: r.a[7] = u32(value); break;
      case M68K_REG.USP: r.usp = u32(value); break;
      case M68K_REG.ISP: r.isp = u32(value); break;
      case M68K_REG.IR: r.ir = u16(value); break;
    }
  }

  /**
   * Set the status register, mirroring Musashi's `m68ki_set_sr()`:
   *
   *   FLAG_T1      = BIT_F(value)      // trace, bit 15
   *   FLAG_INT_MASK= value & 0x0700    // interrupt mask, bits 10..8
   *   CCR          = value & 0x001f    // X N Z V C
   *   FLAG_S       = (value >> 13) & 1 // supervisor, public bit 13 (0x2000)
   *
   * The public SR layout is therefore:
   *   T (15) | S (13) | interrupt mask (10..8) | X (4) | N (3) | Z (2) | V (1) | C (0)
   *
   * Changing S swaps the active stack pointer between USP and ISP.
   */
  setSR(value) {
    const r = this.r;
    // The supervisor bit has to be applied before the SR is rewritten,
    // otherwise the stack pointer switch would see the new state already.
    r.setSupervisor((value & 0x2000) !== 0);
    r.sr = (value & 0x8000) | (value & 0x0700) | (value & 0x2000) | (value & 0x1f);
    this.checkInterrupts();
  }

  /** Read SR in the exact layout exposed by Musashi. */
  getSR() { return this.r.sr & 0xffff; }

  setCCR(value) {
    // Musashi stores Z inverted internally; the CCR bit layout remains 1:1.
    const r = this.r;
    r.sr = (r.sr & ~0x1f) | (value & 0x1f);
  }

  setIrq(level) { this.intLevel = (level & 7) << 8; this.checkInterrupts(); }
  updateIrq(mask) { this.intLevel |= (mask & 7) << 8; this.checkInterrupts(); }
  pulseHalt() { this.stopped |= HALT; }
  clearHalt() { this.stopped &= ~HALT; }
  pulseWait(address, writeAccess = false) { this.stopped |= WAIT; this.waitAddress = address >>> 0; this.waitWrite = !!writeAccess; }
  clearWait() { this.stopped &= ~WAIT; }

  condition(condition) {
    const r = this.r;
    switch (condition & 0xf) {
      case 0: return true;
      case 1: return false;
      case 2: return !r.c && !r.z;
      case 3: return !!r.c || !!r.z;
      case 4: return !r.c;
      case 5: return !!r.c;
      case 6: return !r.z;
      case 7: return !!r.z;
      case 8: return !r.v;
      case 9: return !!r.v;
      case 10: return !r.n;
      case 11: return !!r.n;
      case 12: return r.n === r.v;
      case 13: return r.n !== r.v;
      case 14: return !r.z && r.n === r.v;
      default: return !!r.z || r.n !== r.v;
    }
  }

  setFlagsNZ(result, size) {
    const mask = maskFor(size);
    const value = result & mask;
    this.r.z = value === 0 ? 1 : 0;
    this.r.n = value & signFor(size) ? 1 : 0;
  }

  addFlags(a, b, result, size) {
    const mask = maskFor(size);
    const sign = signFor(size);
    const value = result & mask;
    // Carry when the result does not fit in the operand size.
    this.r.c = (result & ~mask) !== 0 ? 1 : 0;
    this.r.x = this.r.c;
    this.r.v = ((a ^ result) & (b ^ result) & sign) ? 1 : 0;
    this.setFlagsNZ(value, size);
  }

  /**
   * Flags for a subtraction.
   *
   * `keepX` mirrors Musashi: SUB/SUBQ/SUBI update X from C, while the
   * compare forms (CMP/CMPI) leave X untouched.
   */
  subFlags(a, b, result, size, keepX = false) {
    const mask = maskFor(size);
    const sign = signFor(size);
    const value = result & mask;
    this.r.c = (a & mask) < (b & mask) ? 1 : 0;
    if (!keepX) this.r.x = this.r.c;
    this.r.v = ((a ^ b) & (a ^ result) & sign) ? 1 : 0;
    this.setFlagsNZ(value, size);
  }

  /**
   * Flags for a logical operation.
   *
   * Musashi's logical instructions (MOVE, ANDI, ORI, EORI, ...) update N/Z,
   * clear V and clear C, but never touch X.
   */
  logicalFlags(result, size) {
    this.setFlagsNZ(result, size);
    this.r.v = 0;
    this.r.c = 0;
  }

  /** MOVE SR,Dn updates only the size-relevant N/Z bits in Musashi. */
  moveSrFlags(value, size) {
    this.setFlagsNZ(value, size);
  }

  push16(value) { this.r.a[7] = u32(this.r.a[7] - 2); this.write16(this.r.a[7], value); }
  push32(value) { this.r.a[7] = u32(this.r.a[7] - 4); this.write32(this.r.a[7], value); }
  pull16() { const value = this.read16(this.r.a[7]); this.r.a[7] = u32(this.r.a[7] + 2); return value; }
  pull32() { const value = this.read32(this.r.a[7]); this.r.a[7] = u32(this.r.a[7] + 4); return value; }

  initException() {
    const sr = this.r.sr;
    this.r.sr &= ~0x8000;
    // Musashi enters supervisor mode through m68ki_set_s_flag(), which
    // swaps the active stack pointer.
    this.r.setSupervisor(true);
    return sr;
  }

  exception(vector, pc = this.r.pc, kind = "normal") {
    const sr = this.initException();
    if (kind === "bus") {
      // Bus error frame: PC, SR, IR, address and the access information.
      this.push32(pc);
      this.push16(sr);
      this.push16(this.r.ir);
      this.push32(this.aerrAddress ?? 0);
      this.push16((this.aerrWrite ? 0 : 0x10) | (this.aerrInstruction ? 0 : 0x08) | (this.aerrFunctionCode ?? 1));
    } else {
      // The 68000 always pushes a three word frame: the return address
      // followed by the status register.
      this.push32(kind === "privilege" || kind === "illegal" ? u32(pc - 2) : pc);
      this.push16(sr);
    }
    this.r.pc = this.read32(vector * 4);
    this.cycles += exceptionCycles[vector] * this.mul;
    this.stopped = 0;
  }

  checkInterrupts() {
    const level = this.intLevel >>> 8;
    if (!level || level <= this.r.interruptMask) return false;
    if (this.stopped & (STOP | WAIT)) return false;
    const vector = EXCEPTION.INTERRUPT_AUTOVECTOR + level;
    const sr = this.initException();
    this.r.interruptMask = level;
    const acknowledged = this.callbacks.intAck?.(level) ?? M68K_INT_ACK_AUTOVECTOR;
    let pc = this.read32(vector * 4);
    if (pc === 0) pc = this.read32(EXCEPTION.UNINITIALIZED_INTERRUPT * 4);
    this.push32(this.r.pc);
    this.push16(sr);
    this.r.pc = pc;
    this.cycles += interruptCycles[Math.floor(this.cycles / this.mul) % 10] * this.mul;
    return true;
  }

  step() {
    const start = this.cycles;
    this.r.ir = this.fetch16();
    this.instruction = this.r.ir;
    this.execute(this.r.ir);
    const table = this.options.subCpu ? subCycles : CYCLE_TABLE;
    this.cycles += table[this.r.ir];
    return this.cycles - start;
  }

  /** Execute one instruction at a fixed absolute cycle target (Musashi semantics). */
  stepTo(targetCycles) {
    const start = this.cycles;
    this.r.ir = this.fetch16();
    this.instruction = this.r.ir;
    this.execute(this.r.ir);
    const table = this.options.subCpu ? subCycles : CYCLE_TABLE;
    const cost = table[this.r.ir];
    this.cycles = Math.min(targetCycles, this.cycles + cost);
    return this.cycles - start;
  }

  execute(opcode) {
    const handler = this.decode(opcode);
    if (!handler) throw new Error(`Unimplemented opcode 0x${opcode.toString(16)}`);
    handler.call(this);
  }

  /**
   * Decode an opcode into an executable handler.
   *
   * The dispatch is driven by the parsed Musashi handler signatures
   * (see tools/generate-handlers.py), so every opcode follows exactly the
   * same effective address and operand rules as the C core.
   */
  decode(opcode) {
    const signature = handlerSignatures[opcode];
    if (!signature) {
      return () => this.exception(EXCEPTION.ILLEGAL_INSTRUCTION, this.r.pc - 2, "illegal");
    }

    const [operation, rawSize, form, eaName] = signature;
    // The Musashi handler names use bit counts (8, 16, 32); the rest of the
    // interpreter works with byte counts (1, 2, 4).
    const size = rawSize === 8 ? 1 : rawSize === 16 ? 2 : rawSize === 32 ? 4 : 0;
    const eaTokens = eaName ? eaName.split(",") : [];
    const ea = eaTokens[0] ?? "";

    switch (operation) {
      case "move": return this.decodeMoveSignature(opcode, size, eaTokens);
      case "movea": return this.decodeMoveaSignature(opcode, size, ea);
      case "moveq": return this.decodeMoveq(opcode);
      case "movep": return this.decodeMovep(opcode, size);
      case "movem": return this.decodeMovem(opcode, size, ea);
      case "ori":
      case "andi":
      case "eori":
      case "subi":
      case "addi":
      case "cmpi":
        return this.decodeImmediate(opcode, operation, size, ea);
      case "add":
      case "sub":
      case "and":
      case "or":
      case "eor":
      case "cmp":
        return this.decodeLogic(opcode, operation, size, form, ea);
      case "adda":
      case "suba":
      case "cmpa":
        return this.decodeAddressArith(opcode, operation, size, form, ea);
      case "addq":
      case "subq":
        return this.decodeQuick(opcode, operation, size, ea);
      case "moveq_": return this.decodeMoveq(opcode);
      case "clr":
      case "neg":
      case "negx":
      case "not":
      case "tst":
        return this.decodeUnary(opcode, operation, size, ea);
      case "bra":
      case "bsr":
        return this.decodeBranch(opcode);
      case "bcc":
      case "bcs":
      case "beq":
      case "bge":
      case "bgt":
      case "bhi":
      case "ble":
      case "bls":
      case "blt":
      case "bmi":
      case "bne":
      case "bpl":
      case "bvc":
      case "bvs":
        return this.decodeBranch(opcode);
      case "dbf":
      case "dbcc":
      case "dbcs":
      case "dbeq":
      case "dbge":
      case "dbgt":
      case "dbhi":
      case "dble":
      case "dbls":
      case "dblt":
      case "dbmi":
      case "dbne":
      case "dbpl":
      case "dbt":
      case "dbvc":
      case "dbvs":
        return this.decodeBranch(opcode);
      case "scc":
      case "scs":
      case "seq":
      case "sf":
      case "sge":
      case "sgt":
      case "shi":
      case "sle":
      case "sls":
      case "slt":
      case "smi":
      case "sne":
      case "spl":
      case "svc":
      case "svs":
        return this.decodeSetCondition(opcode, ea);
      case "asl":
      case "asr":
      case "lsl":
      case "lsr":
      case "rol":
      case "ror":
      case "roxl":
      case "roxr":
        return this.decodeShift(opcode);
      case "btst":
      case "bchg":
      case "bclr":
      case "bset":
        return this.decodeBit(opcode);
      case "abcd":
      case "sbcd":
      case "nbcd":
      case "addx":
      case "subx":
        return this.decodeExtended(opcode, operation, size, ea);
      case "cmpm":
        return this.decodeCmpM(opcode, size, ea);
      case "chk":
        return this.decodeChk(opcode, size, ea);
      case "divu":
      case "divs":
      case "mulu":
      case "muls":
        return this.decodeMultiplyDivide(opcode, operation, size, ea);
      case "swap":
        return this.decodeSwap(opcode);
      case "tas":
        return this.decodeTas(opcode);
      case "ext":
        return this.decodeExt(opcode);
      case "pea":
        return this.decodePea(opcode, ea);
      case "lea":
        return this.decodeLea(opcode, size, ea);
      case "jmp":
        return this.decodeJmp(opcode, ea);
      case "jsr":
        return this.decodeJsr(opcode, ea);
      case "link":
        return this.decodeLink(opcode);
      case "unlk":
        return this.decodeUnlk(opcode);
      case "rts":
        return () => { this.r.pc = this.pull32(); };
      case "rtr":
        return () => { const ccr = this.pull16(); this.setCCR(ccr); this.r.pc = this.pull32(); };
      case "rte":
        return () => { const sr = this.pull16(); this.setSR(sr); this.r.pc = this.pull32(); };
      case "trap":
        return () => this.trap(opcode & 0xf);
      case "trapv":
        return () => { if (this.r.v) this.exception(EXCEPTION.TRAPV, this.r.pc - 2, "illegal"); };
      case "reset":
        return () => { this.reset(); };
      case "stop":
        return this.decodeStop();
      case "nop":
        return () => {};
      case "illegal":
        return () => this.exception(EXCEPTION.ILLEGAL_INSTRUCTION, this.r.pc - 2, "illegal");
      default:
        return () => this.exception(EXCEPTION.ILLEGAL_INSTRUCTION, this.r.pc - 2, "illegal");
    }
  }

  /**
   * MOVE / MOVEA, decoded from the Musashi handler signature.
   *
   * The destination is always encoded in bits 11..9 (register) and 8..6
   * (mode); the source is in bits 5..3 (mode) and 2..0 (register).
   */
  decodeMoveSignature(opcode, size, eaTokens) {
    const dstMode = (opcode >>> 6) & 7;
    const dstReg = (opcode >>> 9) & 7;
    const srcMode = (opcode >>> 3) & 7;
    const srcReg = opcode & 7;
    const ea = eaTokens[0] ?? "";

    // MOVE SR,Dn / MOVE Dn,SR / MOVE Dn,CCR and their EA variants.
    if (ea === "frs" || ea === "tos" || ea === "toc") {
      return this.decodeMoveStatus(opcode);
    }

    return () => {
      const src = this.ea.decode(srcMode, srcReg, size);
      const source = this.readEA(src, size);
      const dst = this.ea.decode(dstMode, dstReg, size);
      this.writeEA(dst, size, source);
      this.logicalFlags(source, size);
    };
  }

  /**
   * MOVEA: move the source into an address register without touching flags.
   *
   * The word sized form still reads a full 32 bit extension word for the
   * absolute addressing modes, exactly like Musashi's OPER_AL_16().
   */
  decodeMoveaSignature(opcode, size, ea) {
    const dstReg = (opcode >>> 9) & 7;
    const srcMode = (opcode >>> 3) & 7;
    const srcReg = opcode & 7;
    const wordSize = size === 2 ? 2 : 4;
    return () => {
      // Absolute and PC-relative modes always read a 32 bit extension.
      const extensionSize = srcMode === 7 ? 4 : wordSize;
      const src = this.ea.decode(srcMode, srcReg, extensionSize);
      const value = this.readEA(src, extensionSize);
      this.r.a[dstReg] = u32(wordSize === 2
        ? (value & 0xffff)
        : value);
    };
  }

  /**
   * MOVE from SR / to SR / to CCR.
   *
   * For these variants the effective address is encoded in bits 5..3 (mode)
   * and 2..0 (register), while bits 11..9 select the data register used by
   * the "d" form.
   */
  decodeMoveStatus(opcode) {
    const signature = handlerSignatures[opcode];
    const ea = signature[3].split(",")[0];
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;

    if (ea === "frs") {
      // MOVE SR,<ea>: the source is the status register.
      return () => {
        const dst = this.ea.decode(mode, reg, 2);
        this.writeEA(dst, 2, this.getSR() & 0xffff);
      };
    }

    if (ea === "toc") {
      // MOVE <ea>,CCR: only the condition codes are loaded.
      return () => {
        const src = this.ea.decode(mode, reg, 2);
        this.setCCR(this.readEA(src, 2) & 0xffff);
      };
    }

    // MOVE <ea>,SR
    return () => {
      const src = this.ea.decode(mode, reg, 2);
      const value = this.readEA(src, 2);
      if (!this.r.supervisor) {
        this.exception(EXCEPTION.PRIVILEGE_VIOLATION, this.r.pc - 2, "privilege");
        return;
      }
      this.setSR(value & 0xffff);
    };
  }

  /** MOVEQ #imm,Dn */
  decodeMoveq(opcode) {
    const reg = (opcode >>> 9) & 7;
    const value = sx8(opcode & 0xff);
    return () => {
      this.r.d[reg] = u32(value);
      this.setFlagsNZ(value, 4);
      this.r.v = 0;
      this.r.c = 0;
    };
  }

  /** MOVEP: memory transfers with a 2 byte stride. */
  decodeMovep(opcode, size) {
    const dataReg = (opcode >>> 9) & 7;
    const addrReg = opcode & 7;
    const direction = (opcode & 0x0100) !== 0;
    const address = this.r.a[addrReg];
    return () => {
      let offset = 0;
      if (direction) {
        // MOVE <ea>,D<n>: memory -> register
        for (let i = 0; i < size; i++) {
          const value = this.read8(u32(address + offset));
          const shift = 8 * (size - 1 - i);
          this.r.d[dataReg] = u32((this.r.d[dataReg] & ~(0xff << shift)) | (value << shift));
          offset += 2;
        }
      } else {
        // MOVE D<n>,<ea>: register -> memory
        for (let i = 0; i < size; i++) {
          const shift = 8 * (size - 1 - i);
          this.write8(u32(address + offset), (this.r.d[dataReg] >>> shift) & 0xff);
          offset += 2;
        }
      }
    };
  }

  /**
   * MOVEM: move multiple registers to or from memory.
   *
   * The register list is a 16 bit immediate that follows the opcode; the
   * effective address follows it.  The direction is encoded in bit 10 of
   * the opcode (1 = memory to registers).
   */
  decodeMovem(opcode, size, ea) {
    const toRegisters = (opcode & 0x0400) !== 0;
    const wordSize = (opcode & 0x0040) !== 0 ? 2 : 4;
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;

    return () => {
      const list = this.fetch16();
      const target = this.ea.decode(mode, reg, wordSize);
      const registers = [];
      for (let i = 0; i < 16; i++) if (list & (1 << i)) registers.push(i);

      const isPredecrement = mode === 4;
      const isPostincrement = mode === 3;

      if (toRegisters) {
        // Memory -> registers.
        let address = this.addressEA(target);
        for (const index of registers) {
          const value = wordSize === 2 ? this.read16(address) : this.read32(address);
          if (index < 8) {
            this.r.d[index] = u32(wordSize === 2
              ? (this.r.d[index] & 0xffff0000) | (value & 0xffff)
              : value);
          } else {
            this.r.a[index - 8] = u32(wordSize === 2 ? value & 0xffff : value);
          }
          address = u32(address + wordSize);
        }
        if (isPostincrement) this.r.a[reg] = u32(address);
        return;
      }

      // Registers -> memory.
      let address = this.addressEA(target);
      if (isPredecrement) address = u32(address - registers.length * wordSize);
      for (const index of registers) {
        const value = index < 8 ? this.r.d[index] : this.r.a[index - 8];
        if (wordSize === 2) this.write16(address, value & 0xffff);
        else this.write32(address, value);
        address = u32(address + wordSize);
      }
      if (isPredecrement) this.r.a[reg] = address;
      if (isPostincrement) this.r.a[reg] = address;
    };
  }

  /**
   * ORI / ANDI / EORI / SUBI / ADDI / CMPI.
   *
   * The immediate is only present when the destination is not a data or
   * address register, which is exactly what the Musashi signature encodes.
   */
  decodeImmediate(opcode, operation, size, ea) {
    const isCompare = operation === "cmpi";
    const isStatus = ea === "tos" || ea === "toc";

    if (isStatus) {
      return this.decodeStatusImmediate(opcode, operation);
    }

    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;

    return () => {
      const immediate = size === 1 ? u8(this.fetch16()) : size === 2 ? this.fetch16() : this.fetch32();
      const target = this.ea.decode(mode, reg, size);
      const old = this.readEA(target, size);

      switch (operation) {
        case "ori": {
          const result = old | immediate;
          this.writeEA(target, size, result);
          this.logicalFlags(result, size);
          return;
        }
        case "andi": {
          const result = old & immediate;
          this.writeEA(target, size, result);
          this.logicalFlags(result, size);
          return;
        }
        case "eori": {
          const result = old ^ immediate;
          this.writeEA(target, size, result);
          this.logicalFlags(result, size);
          return;
        }
        case "subi": {
          const result = old - immediate;
          this.writeEA(target, size, result);
          this.subFlags(old, immediate, result, size);
          return;
        }
        case "addi": {
          const result = old + immediate;
          this.writeEA(target, size, result);
          this.addFlags(old, immediate, result, size);
          return;
        }
        case "cmpi": {
          const result = old - immediate;
          this.subFlags(old, immediate, result, size, true);
          return;
        }
        default:
          throw new Error(`Unsupported immediate operation '${operation}'`);
      }
    };
  }

  /** ORI/ANDI/EORI to SR or CCR. */
  decodeStatusImmediate(opcode, operation) {
    const signature = handlerSignatures[opcode];
    const ea = signature[3].split(",")[0];
    return () => {
      const immediate = this.fetch16();
      if (ea === "toc") {
        this.setCCR((this.getSR() & 0x1f) & immediate);
        return;
      }
      if (!this.r.supervisor) {
        this.exception(EXCEPTION.PRIVILEGE_VIOLATION, this.r.pc - 4, "privilege");
        return;
      }
      // Musashi applies the immediate to the whole SR and then decodes it
      // again through m68ki_set_sr() (T, interrupt mask, CCR and S).
      if (operation === "ori") this.setSR(this.getSR() | immediate);
      else if (operation === "andi") this.setSR(this.getSR() & immediate);
      else this.setSR(this.getSR() ^ immediate);
    };
  }

  /**
   * ADD / SUB / AND / OR / EOR / CMP between a data register and an EA.
   *
   * ``er`` means the effective address is the destination, ``re`` means the
   * data register is.  In both cases the data register is encoded in bits
   * 11..9 and the EA in bits 5..3 (mode) and 2..0 (register).
   */
  decodeLogic(opcode, operation, size, form, ea) {
    // The data register that takes part in the operation is encoded in
    // bits 11..9 (Musashi's DX), the effective address in bits 5..3 (mode)
    // and 2..0 (register).
    const eaMode = (opcode >>> 3) & 7;
    const eaReg = opcode & 7;
    const dx = (opcode >>> 9) & 7;
    const isMemoryForm = eaMode > 1;

    // "er": the data register is the destination, the EA is the source.
    // "re": the effective address is the destination, the register the source.
    const toRegister = form === "re";

    return () => {
      if (toRegister) {
        // <ea> = DX OP <ea>
        const target = this.ea.decode(eaMode, eaReg, size);
        const source = this.readEA(target, size);
        const dn = this.readEA({ type: EA.DN, reg: dx }, size);

        switch (operation) {
          case "cmp": {
            const result = source - dn;
            this.subFlags(source, dn, result, size, true);
            return;
          }
          case "and": {
            const result = source & dn;
            this.writeEA(target, size, result);
            this.logicalFlags(result, size);
            return;
          }
          case "or": {
            const result = source | dn;
            this.writeEA(target, size, result);
            this.logicalFlags(result, size);
            return;
          }
          case "eor": {
            const result = source ^ dn;
            this.writeEA(target, size, result);
            this.logicalFlags(result, size);
            return;
          }
          case "sub": {
            const result = source - dn;
            this.writeEA(target, size, result);
            this.subFlags(source, dn, result, size);
            return;
          }
          case "add": {
            const result = source + dn;
            this.writeEA(target, size, result);
            this.addFlags(source, dn, result, size);
            return;
          }
          default:
            throw new Error(`Unsupported operation '${operation}'`);
        }
      }

      // DX = DX OP <ea>
      const dn = this.readEA({ type: EA.DN, reg: dx }, size);
      let source;
      if (eaMode === 0) {
        // The EA is the data register in bits 2..0.
        source = this.readEA({ type: EA.DN, reg: eaReg }, size);
      } else if (eaMode === 1) {
        // The EA is the address register in bits 2..0.
        source = this.readEA({ type: EA.AN, reg: eaReg }, size);
      } else {
        const target = this.ea.decode(eaMode, eaReg, size);
        source = this.readEA(target, size);
      }

      switch (operation) {
        case "cmp": {
          const result = dn - source;
          this.subFlags(dn, source, result, size, true);
          return;
        }
        case "and": {
          const result = dn & source;
          this.writeEA({ type: EA.DN, reg: dx }, size, result);
          this.logicalFlags(result, size);
          return;
        }
        case "or": {
          const result = dn | source;
          this.writeEA({ type: EA.DN, reg: dx }, size, result);
          this.logicalFlags(result, size);
          return;
        }
        case "eor": {
          const result = dn ^ source;
          this.writeEA({ type: EA.DN, reg: dx }, size, result);
          this.logicalFlags(result, size);
          return;
        }
        case "sub": {
          const result = dn - source;
          this.writeEA({ type: EA.DN, reg: dx }, size, result);
          this.subFlags(dn, source, result, size);
          return;
        }
        case "add": {
          const result = dn + source;
          this.writeEA({ type: EA.DN, reg: dx }, size, result);
          this.addFlags(dn, source, result, size);
          return;
        }
        default:
          throw new Error(`Unsupported operation '${operation}'`);
      }
    };
  }

  /** ADDA / SUBA / CMPA. */
  decodeAddressArith(opcode, operation, size, form, ea) {
    const eaMode = (opcode >>> 3) & 7;
    const eaReg = opcode & 7;
    const reg = (opcode >>> 9) & 7;
    const wordSize = size === 2 ? 2 : 4;
    const toRegister = form === "re";

    return () => {
      const target = this.ea.decode(eaMode, eaReg, wordSize);
      const source = this.readEA(target, wordSize);
      const an = this.r.a[reg];

      if (operation === "cmpa") {
        const result = an - source;
        this.subFlags(an, source, result, 4, true);
        return;
      }

      const result = operation === "add" ? an + source : an - source;
      this.r.a[reg] = u32(result);
      if (wordSize === 4) {
        if (operation === "add") this.addFlags(an, source, result, 4);
        else this.subFlags(an, source, result, 4);
      } else {
        // Word sized address arithmetic only updates the lower 16 bits.
        const sign = (an ^ result) & 0x8000;
        this.r.c = operation === "add" ? ((an & 0xffff) + (source & 0xffff)) > 0xffff ? 1 : 0
                                      : ((an & 0xffff) < (source & 0xffff)) ? 1 : 0;
        this.r.x = this.r.c;
        this.r.v = sign ? 1 : 0;
      }
    };
  }

  /** ADDQ / SUBQ: add a small immediate to an EA. */
  decodeQuick(opcode, operation, size, ea) {
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    // Musashi derives the immediate from the register field in bits 11..9:
    // (((IR >> 9) - 1) & 7) + 1, so an encoded zero means "add 8".
    const data = (((opcode >>> 9) & 7) - 1 & 7) + 1;
    const isAdd = operation === "addq";

    return () => {
      if (mode === 1) {
        const old = this.r.a[reg];
        const result = u32(isAdd ? old + data : old - data);
        this.r.a[reg] = result;
        if (size === 4) {
          if (isAdd) this.addFlags(old, data, result, 4);
          else this.subFlags(old, data, result, 4);
        } else {
          const mask = maskFor(size);
          this.r.c = isAdd
            ? ((old & mask) + data) > mask ? 1 : 0
            : ((old & mask) < data) ? 1 : 0;
          this.r.x = this.r.c;
          this.r.v = 0;
          this.setFlagsNZ(result, size);
        }
        return;
      }

      const target = this.ea.decode(mode, reg, size);
      const old = this.readEA(target, size);
      const result = isAdd ? old + data : old - data;
      this.writeEA(target, size, result);
      if (size === 4) {
        if (isAdd) this.addFlags(old, data, result, 4);
        else this.subFlags(old, data, result, 4);
      } else {
        this.subFlags(old, data, result, size);
      }
    };
  }

  /** CLR / NEG / NEGX / NOT / TST. */
  decodeUnary(opcode, operation, size, ea) {
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    return () => {
      const target = this.ea.decode(mode, reg, size);
      switch (operation) {
        case "clr": {
          this.writeEA(target, size, 0);
          this.setFlagsNZ(0, size);
          this.r.v = 0;
          this.r.c = 0;
          return;
        }
        case "neg": {
          const old = this.readEA(target, size);
          const result = (0 - old) & maskFor(size);
          this.writeEA(target, size, result);
          this.subFlags(0, old, result, size);
          return;
        }
        case "negx": {
          const old = this.readEA(target, size);
          const result = (0 - old - this.r.x) & maskFor(size);
          this.writeEA(target, size, result);
          this.subFlags(0, old, result, size);
          return;
        }
        case "not": {
          const old = this.readEA(target, size);
          const result = ~old & maskFor(size);
          this.writeEA(target, size, result);
          this.setFlagsNZ(result, size);
          this.r.v = 0;
          this.r.c = 0;
          return;
        }
        case "tst": {
          const old = this.readEA(target, size);
          this.setFlagsNZ(old, size);
          this.r.v = 0;
          this.r.c = 0;
          return;
        }
        default:
          throw new Error(`Unsupported unary operation '${operation}'`);
      }
    };
  }

  /** Scc: set a byte to 0xff or 0x00 depending on the condition. */
  decodeSetCondition(opcode, ea) {
    const condition = (opcode >>> 8) & 0xf;
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    return () => {
      const target = this.ea.decode(mode, reg, 1);
      this.writeEA(target, 1, this.condition(condition) ? 0xff : 0x00);
    };
  }

  /** STOP #sr */
  decodeStop() {
    return () => {
      const value = this.fetch16();
      if (!this.r.supervisor) {
        this.exception(EXCEPTION.PRIVILEGE_VIOLATION, this.r.pc - 4, "privilege");
        return;
      }
      this.stopped |= STOP;
      this.setSR(value);
      this.stopPc = this.r.pc;
      if (this.stopped && this.cycleEnd) this.cycles = this.cycleEnd - 4 * this.mul;
    };
  }

  /**
   * ABCD / SBCD / NBCD / ADDX / SUBX.
   *
   * The "rr" form works on two register pairs with pre-decremented address
   * registers, the "mm" form on two memory operands.  In both cases the
   * destination register is encoded in bits 11..9 (DX) and the source
   * register in bits 2..0 (DY).
   */
  decodeExtended(opcode, operation, size, ea) {
    const eaMode = (opcode >>> 3) & 7;
    const eaReg = opcode & 7;
    const dx = (opcode >>> 9) & 7;
    const dy = opcode & 7;
    const isRegisterPair = ea === "rr";

    return () => {
      if (operation === "nbcd") {
        const mode = (opcode >>> 3) & 7;
        const reg = opcode & 7;
        const target = this.ea.decode(mode, reg, 1);
        const old = this.readEA(target, 1);
        const result = this.bcdNegate(old);
        this.writeEA(target, 1, result);
        return;
      }

      if (operation === "abcd" || operation === "sbcd") {
        let source;
        let destination;

        if (isRegisterPair) {
          // The register form works directly on two data registers.
          source = this.r.d[dy] & 0xff;
          destination = this.r.d[dx] & 0xff;
        } else {
          // Memory form: the source and destination are addressed by the
          // two register pairs.
          const sourceAddress = u32(this.r.a[dy] + sx16(this.fetch16()));
          const destinationAddress = u32(this.r.a[dx] + sx16(this.fetch16()));
          source = this.read8(sourceAddress);
          destination = this.read8(destinationAddress);
          this.r.a[dy] = u32(this.r.a[dy] + 2);
          this.r.a[dx] = u32(this.r.a[dx] + 2);
        }

        const result = operation === "abcd"
          ? this.bcdAdd(destination, source)
          : this.bcdSub(destination, source);

        if (isRegisterPair) {
          this.r.d[dx] = u32((this.r.d[dx] & 0xffffff00) | (result & 0xff));
        } else {
          this.write8(u32(this.r.a[dx] - 2), result & 0xff);
        }
        // The carry and extend flags were computed by the BCD helpers.
        return;
      }

      // ADDX / SUBX
      let source;
      let destination;

      if (isRegisterPair) {
        source = this.readEA({ type: EA.DN, reg: dy }, size);
        destination = this.readEA({ type: EA.DN, reg: dx }, size);
      } else {
        const sourceAddress = u32(this.r.a[dy] + sx16(this.fetch16()));
        const destinationAddress = u32(this.r.a[dx] + sx16(this.fetch16()));
        source = this.readEA({ type: -1, address: sourceAddress }, size);
        destination = this.readEA({ type: -1, address: destinationAddress }, size);
        const step = size === 1 ? 1 : size === 2 ? 2 : 4;
        this.r.a[dy] = u32(this.r.a[dy] + step);
        this.r.a[dx] = u32(this.r.a[dx] + step);
      }

      const result = operation === "addx"
        ? destination + source + this.r.x
        : destination - source - this.r.x;

      if (isRegisterPair) {
        this.writeEA({ type: EA.DN, reg: dx }, size, result);
      } else {
        this.writeEA({ type: -1, address: u32(this.r.a[dx] - (size === 1 ? 1 : size === 2 ? 2 : 4)) }, size, result);
      }

      if (operation === "addx") this.addFlags(destination, source, result, size);
      else this.subFlags(destination, source, result, size);
      this.r.x = this.r.c;
    };
  }

  /** CMPM: compare two memory blocks. */
  decodeCmpM(opcode, size, ea) {
    const srcReg = opcode & 7;
    const dstReg = (opcode >>> 9) & 7;
    const step = size === 1 ? 1 : size === 2 ? 2 : 4;
    return () => {
      const src = this.r.a[srcReg];
      const dst = this.r.a[dstReg];
      const source = this.readEA({ type: -1, address: src }, size);
      const target = this.readEA({ type: -1, address: dst }, size);
      const result = target - source;
      this.subFlags(target, source, result, size, true);
      this.r.a[srcReg] = u32(src + step);
      this.r.a[dstReg] = u32(dst + step);
    };
  }

  /** CHK: compare a register against a bound and trap on overflow. */
  decodeChk(opcode, size, ea) {
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    const boundReg = (opcode >>> 9) & 7;
    return () => {
      const target = this.ea.decode(mode, reg, 2);
      const bound = this.readEA(target, 2) & 0xffff;
      const value = this.r.d[boundReg];
      const lower = sx16(bound);
      const upper = sx16(value & 0xffff);
      if (value & 0x8000) {
        // Negative: trap when value < lower.
        if ((value | 0xffff0000) < (lower | 0xffff0000)) {
          this.exception(EXCEPTION.CHK, this.r.pc - 2, "illegal");
          return;
        }
        this.r.n = 1;
        return;
      }
      if (value > bound) {
        this.exception(EXCEPTION.CHK, this.r.pc - 2, "illegal");
        return;
      }
      this.r.n = 0;
    };
  }

  /** MULU / MULS / DIVU / DIVS. */
  decodeMultiplyDivide(opcode, operation, size, ea) {
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    const destReg = (opcode >>> 9) & 7;
    return () => {
      const target = this.ea.decode(mode, reg, 2);
      const source = this.readEA(target, 2) & 0xffff;
      const value = this.r.d[destReg] & 0xffff;

      switch (operation) {
        case "mulu": {
          const result = value * source;
          this.r.d[destReg] = u32(result & 0xffffffff);
          this.r.n = (result >>> 15) & 1;
          this.r.z = (result & 0xffff) === 0 ? 1 : 0;
          this.r.v = ((result >>> 15) & 1) ^ ((result >>> 31) & 1);
          this.r.c = 0;
          return;
        }
        case "muls": {
          const signed = sx16(value) * sx16(source);
          const result = signed & 0xffffffff;
          this.r.d[destReg] = u32(result);
          this.r.n = (result >>> 15) & 1;
          this.r.z = (result & 0xffff) === 0 ? 1 : 0;
          this.r.v = ((result >>> 15) & 1) ^ ((result >>> 31) & 1);
          this.r.c = 0;
          return;
        }
        case "divu": {
          if (source === 0) {
            this.exception(EXCEPTION.DIVIDE_BY_ZERO, this.r.pc - 2, "illegal");
            return;
          }
          const quotient = Math.floor(value / source);
          const remainder = value % source;
          if (quotient > 0xffff) {
            this.r.v = 1;
            this.r.n = 0;
            this.r.c = 0;
            this.r.z = 0;
            return;
          }
          this.r.d[destReg] = u32(((remainder & 0xffff) << 16) | (quotient & 0xffff));
          this.r.n = (quotient >>> 15) & 1;
          this.r.z = (quotient & 0xffff) === 0 ? 1 : 0;
          this.r.v = 0;
          this.r.c = 0;
          return;
        }
        case "divs": {
          const signedSource = sx16(source);
          if (signedSource === 0) {
            this.exception(EXCEPTION.DIVIDE_BY_ZERO, this.r.pc - 2, "illegal");
            return;
          }
          const dividend = sx32(this.r.d[destReg]);
          const quotient = Math.trunc(dividend / signedSource);
          const remainder = dividend % signedSource;
          if (quotient > 32767 || quotient < -32768) {
            this.r.v = 1;
            this.r.n = 0;
            this.r.c = 0;
            this.r.z = 0;
            return;
          }
          this.r.d[destReg] = u32(((remainder & 0xffff) << 16) | (quotient & 0xffff));
          this.r.n = (quotient >>> 15) & 1;
          this.r.z = (quotient & 0xffff) === 0 ? 1 : 0;
          this.r.v = 0;
          this.r.c = 0;
          return;
        }
        default:
          throw new Error(`Unsupported operation '${operation}'`);
      }
    };
  }

  /** SWAP Dn */
  decodeSwap(opcode) {
    // Musashi swaps DY, i.e. the data register encoded in bits 2..0.
    const reg = opcode & 7;
    return () => {
      const value = this.r.d[reg];
      const result = u32(((value >>> 16) | (value << 16)) & 0xffffffff);
      this.r.d[reg] = result;
      this.setFlagsNZ(result, 4);
      this.r.v = 0;
      this.r.c = 0;
    };
  }

  /** EXT.W / EXT.L */
  decodeExt(opcode) {
    const long = (opcode & 0x0040) !== 0;
    const reg = opcode & 7;
    return () => {
      if (long) {
        const value = sx16(this.r.d[reg] & 0xffff);
        this.r.d[reg] = u32(value & 0xffffffff);
        this.setFlagsNZ(value, 4);
      } else {
        const value = sx8(this.r.d[reg] & 0xff);
        this.r.d[reg] = u32((this.r.d[reg] & 0xffff0000) | (value & 0xffff));
        this.setFlagsNZ(value, 2);
      }
      this.r.v = 0;
      this.r.c = 0;
    };
  }

  /** PEA <ea> */
  decodePea(opcode, ea) {
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    return () => {
      const target = this.ea.decode(mode, reg, 4);
      this.push32(this.addressEA(target));
    };
  }

  /**
   * LEA <ea>,An
   *
   * The destination register is encoded in bits 2..0 (An) while the base
   * register of the effective address comes from bits 11..9 (AY).
   */
  decodeLea(opcode, size, ea) {
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    // The destination is AX (bits 11..9) and the base register of the
    // effective address is AY (bits 2..0).
    const dstReg = (opcode >>> 9) & 7;
    const baseReg = opcode & 7;
    return () => {
      // The EA of LEA always uses the register encoded in bits 11..9 as
      // its base, so the raw mode/register pair is remapped here.
      let target;
      switch (mode) {
        case 2: target = { type: EA.AI, reg: baseReg, address: this.r.a[baseReg] }; break;
        case 3: target = { type: EA.PI, reg: baseReg, address: this.r.a[baseReg] }; break;
        case 4: target = { type: EA.PD, reg: baseReg, address: this.r.a[baseReg] }; break;
        case 5: {
          const displacement = sx16(this.fetch16());
          target = { type: EA.DI, reg: baseReg, address: u32(this.r.a[baseReg] + displacement) };
          break;
        }
        case 6: {
          const extension = this.fetch16();
          const indexRegister = (extension >>> 12) & 0xf;
          let index = indexRegister < 8 ? this.r.d[indexRegister] : this.r.a[indexRegister - 8];
          if ((extension & 0x0800) === 0) index = u32(sx16(index));
          const scale = 1 << ((extension >>> 9) & 3);
          target = { type: EA.IX, reg: baseReg, address: u32(this.r.a[baseReg] + index * scale + sx8(extension & 0xff)) };
          break;
        }
        case 7: {
          const sub = reg;
          switch (sub) {
            case 0: target = { type: EA.AW, address: u32(sx16(this.fetch16())) }; break;
            case 1: target = { type: EA.AL, address: this.fetch32() }; break;
            case 2: {
              const base = this.r.pc;
              target = { type: EA.PCDI, address: u32(base + sx16(this.fetch16())) };
              break;
            }
            default: target = { type: EA.AL, address: 0 }; break;
          }
          break;
        }
        default: target = this.ea.decode(mode, reg, 4); break;
      }
      this.r.a[dstReg] = this.addressEA(target);
    };
  }

  /** JMP <ea> */
  decodeJmp(opcode, ea) {
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    return () => {
      const target = this.ea.decode(mode, reg, 4);
      this.r.pc = this.addressEA(target);
    };
  }

  /** JSR <ea> */
  decodeJsr(opcode, ea) {
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    return () => {
      const target = this.ea.decode(mode, reg, 4);
      this.push32(this.r.pc);
      this.r.pc = this.addressEA(target);
    };
  }

  /** LINK An,#disp */
  decodeLink(opcode) {
    const reg = opcode & 7;
    return () => {
      const displacement = this.fetch16();
      this.push32(this.r.a[reg]);
      this.r.a[reg] = this.r.a[7];
      this.r.a[7] = u32(this.r.a[7] - displacement);
    };
  }

  /** UNLK An */
  decodeUnlk(opcode) {
    const reg = opcode & 7;
    return () => {
      this.r.a[7] = this.r.a[reg];
      this.r.a[reg] = this.pull32();
    };
  }

  /**
   * ABCD helpers, following Musashi's `m68k_op_abcd_8_rr` exactly.
   *
   * The X flag is added to the low nibble, a carry correction of 6 is
   * applied when the low nibble exceeds 9 and the result is compared
   * against 0x9f to produce the carry.  The Z flag is OR-ed with the
   * result instead of being replaced.
   */
  bcdAdd(dst, src) {
    let res = (src & 0x0f) + (dst & 0x0f) + this.r.x;
    let correction = 0;
    if (res > 9) correction = 6;
    // Musashi's HIGH_NIBBLE() keeps the nibble in place: A & 0xf0.
    res += (src & 0xf0) + (dst & 0xf0);
    this.r.v = ~res & 0xff;
    res += correction;
    this.r.c = res > 0x9f ? 1 : 0;
    this.r.x = this.r.c;
    if (this.r.c) res -= 0xa0;
    this.r.v &= res & 0xff;
    this.r.n = (res & 0x80) ? 1 : 0;
    res &= 0xff;
    // Musashi: FLAG_Z |= res (on the inverted not_z_flag), which means the
    // public Z bit is cleared unless the result is zero.
    if (res !== 0) this.r.z = 0;
    return res;
  }

  /** SBCD helpers, following Musashi's `m68k_op_sbcd_8_rr`. */
  bcdSub(dst, src) {
    // Musashi works with unsigned 32 bit arithmetic, which is what makes
    // the borrow detection work.
    let res = ((dst & 0x0f) - (src & 0x0f) - this.r.x) >>> 0;
    let correction = 0;
    if (res > 0xf) correction = 6;
    // Musashi's HIGH_NIBBLE() keeps the nibble in place: A & 0xf0.
    res = (res + ((dst & 0xf0) - (src & 0xf0))) >>> 0;
    this.r.v = res & 0xff;
    if (res > 0xff) {
      res = (res + 0xa0) >>> 0;
      this.r.c = 1;
      this.r.x = 1;
    } else if (res < correction) {
      this.r.c = 1;
      this.r.x = 1;
    } else {
      this.r.c = 0;
      this.r.x = 0;
    }
    res = (res - correction) & 0xff;
    this.r.v &= ~res & 0xff;
    this.r.n = (res & 0x80) ? 1 : 0;
    // Musashi: FLAG_Z |= res (on the inverted not_z_flag).
    if (res !== 0) this.r.z = 0;
    return res;
  }

  /**
   * NBCD, following Musashi's `m68k_op_nbcd_8_d`.
   *
   * The result is the ten's complement of the byte; the carry and extend
   * flags are set when the result is not zero.
   */
  bcdNegate(value) {
    const dst = value & 0xff;
    let res = (-dst - this.r.x) & 0xffffffff;

    if (res) {
      this.r.v = res & 0xff;
      if (((res | dst) & 0x0f) === 0) res = (res & 0xf0) + 6;
      res = (res + 0x9a) & 0xff;
      this.r.v &= ~res & 0xff;
      this.r.c = 1;
      this.r.x = 1;
      this.r.n = (res & 0x80) ? 1 : 0;
      if (res !== 0) this.r.z = 0;
      return res;
    }

    this.r.v = 0;
    this.r.c = 0;
    this.r.x = 0;
    this.r.n = 0;
    this.r.z = 1;
    return 0;
  }

  /**
   * ORI / ANDI / EORI / SUBI / ADDI / CMPI.
   *
   * The immediate is only present when the destination is not a data or
   * address register, which is exactly what the Musashi signature encodes.
   */
  decodeImmediate(opcode, operation, size, ea) {
    const isCompare = operation === "cmpi";
    const isStatus = ea === "tos" || ea === "toc";

    if (isStatus) {
      return this.decodeStatusImmediate(opcode, operation);
    }

    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;

    return () => {
      const immediate = size === 1 ? u8(this.fetch16()) : size === 2 ? this.fetch16() : this.fetch32();
      const target = this.ea.decode(mode, reg, size);
      const old = this.readEA(target, size);

      switch (operation) {
        case "ori": {
          const result = old | immediate;
          this.writeEA(target, size, result);
          this.logicalFlags(result, size);
          return;
        }
        case "andi": {
          const result = old & immediate;
          this.writeEA(target, size, result);
          this.logicalFlags(result, size);
          return;
        }
        case "eori": {
          const result = old ^ immediate;
          this.writeEA(target, size, result);
          this.logicalFlags(result, size);
          return;
        }
        case "subi": {
          const result = old - immediate;
          this.writeEA(target, size, result);
          this.subFlags(old, immediate, result, size);
          return;
        }
        case "addi": {
          const result = old + immediate;
          this.writeEA(target, size, result);
          this.addFlags(old, immediate, result, size);
          return;
        }
        case "cmpi": {
          const result = old - immediate;
          this.subFlags(old, immediate, result, size, true);
          return;
        }
        default:
          throw new Error(`Unsupported immediate operation '${operation}'`);
      }
    };
  }

  /** ORI/ANDI/EORI to SR or CCR. */
  decodeStatusImmediate(opcode, operation) {
    const signature = handlerSignatures[opcode];
    const ea = signature[3].split(",")[0];
    return () => {
      const immediate = this.fetch16();
      if (ea === "toc") {
        this.setCCR((this.getSR() & 0x1f) & immediate);
        return;
      }
      if (!this.r.supervisor) {
        this.exception(EXCEPTION.PRIVILEGE_VIOLATION, this.r.pc - 4, "privilege");
        return;
      }
      // Musashi applies the immediate to the whole SR and then decodes it
      // again through m68ki_set_sr() (T, interrupt mask, CCR and S).
      if (operation === "ori") this.setSR(this.getSR() | immediate);
      else if (operation === "andi") this.setSR(this.getSR() & immediate);
      else this.setSR(this.getSR() ^ immediate);
    };
  }

  /**
   * ADD / SUB / AND / OR / EOR / CMP between a data register and an EA.
   *
   * ``er`` means the effective address is the destination, ``re`` means the
   * data register is.  In both cases the data register is encoded in bits
   * 11..9 and the EA in bits 5..3 (mode) and 2..0 (register).
   */
  decodeLogic(opcode, operation, size, form, ea) {
    // The data register that takes part in the operation is encoded in
    // bits 11..9 (Musashi's DX), the effective address in bits 5..3 (mode)
    // and 2..0 (register).
    const eaMode = (opcode >>> 3) & 7;
    const eaReg = opcode & 7;
    const dx = (opcode >>> 9) & 7;
    const isMemoryForm = eaMode > 1;

    // "er": the data register is the destination, the EA is the source.
    // "re": the effective address is the destination, the register the source.
    const toRegister = form === "re";

    return () => {
      if (toRegister) {
        // <ea> = DX OP <ea>
        const target = this.ea.decode(eaMode, eaReg, size);
        const source = this.readEA(target, size);
        const dn = this.readEA({ type: EA.DN, reg: dx }, size);

        switch (operation) {
          case "cmp": {
            const result = source - dn;
            this.subFlags(source, dn, result, size, true);
            return;
          }
          case "and": {
            const result = source & dn;
            this.writeEA(target, size, result);
            this.logicalFlags(result, size);
            return;
          }
          case "or": {
            const result = source | dn;
            this.writeEA(target, size, result);
            this.logicalFlags(result, size);
            return;
          }
          case "eor": {
            const result = source ^ dn;
            this.writeEA(target, size, result);
            this.logicalFlags(result, size);
            return;
          }
          case "sub": {
            const result = source - dn;
            this.writeEA(target, size, result);
            this.subFlags(source, dn, result, size);
            return;
          }
          case "add": {
            const result = source + dn;
            this.writeEA(target, size, result);
            this.addFlags(source, dn, result, size);
            return;
          }
          default:
            throw new Error(`Unsupported operation '${operation}'`);
        }
      }

      // DX = DX OP <ea>
      const dn = this.readEA({ type: EA.DN, reg: dx }, size);
      let source;
      if (eaMode === 0) {
        // The EA is the data register in bits 2..0.
        source = this.readEA({ type: EA.DN, reg: eaReg }, size);
      } else if (eaMode === 1) {
        // The EA is the address register in bits 2..0.
        source = this.readEA({ type: EA.AN, reg: eaReg }, size);
      } else {
        const target = this.ea.decode(eaMode, eaReg, size);
        source = this.readEA(target, size);
      }

      switch (operation) {
        case "cmp": {
          const result = dn - source;
          this.subFlags(dn, source, result, size, true);
          return;
        }
        case "and": {
          const result = dn & source;
          this.writeEA({ type: EA.DN, reg: dx }, size, result);
          this.logicalFlags(result, size);
          return;
        }
        case "or": {
          const result = dn | source;
          this.writeEA({ type: EA.DN, reg: dx }, size, result);
          this.logicalFlags(result, size);
          return;
        }
        case "eor": {
          const result = dn ^ source;
          this.writeEA({ type: EA.DN, reg: dx }, size, result);
          this.logicalFlags(result, size);
          return;
        }
        case "sub": {
          const result = dn - source;
          this.writeEA({ type: EA.DN, reg: dx }, size, result);
          this.subFlags(dn, source, result, size);
          return;
        }
        case "add": {
          const result = dn + source;
          this.writeEA({ type: EA.DN, reg: dx }, size, result);
          this.addFlags(dn, source, result, size);
          return;
        }
        default:
          throw new Error(`Unsupported operation '${operation}'`);
      }
    };
  }

  /** ADDA / SUBA / CMPA. */
  decodeAddressArith(opcode, operation, size, form, ea) {
    const eaMode = (opcode >>> 3) & 7;
    const eaReg = opcode & 7;
    const reg = (opcode >>> 9) & 7;
    const wordSize = size === 2 ? 2 : 4;
    const toRegister = form === "re";

    return () => {
      const target = this.ea.decode(eaMode, eaReg, wordSize);
      const source = this.readEA(target, wordSize);
      const an = this.r.a[reg];

      if (operation === "cmpa") {
        const result = an - source;
        this.subFlags(an, source, result, 4, true);
        return;
      }

      const result = operation === "add" ? an + source : an - source;
      this.r.a[reg] = u32(result);
      if (wordSize === 4) {
        if (operation === "add") this.addFlags(an, source, result, 4);
        else this.subFlags(an, source, result, 4);
      } else {
        // Word sized address arithmetic only updates the lower 16 bits.
        const sign = (an ^ result) & 0x8000;
        this.r.c = operation === "add" ? ((an & 0xffff) + (source & 0xffff)) > 0xffff ? 1 : 0
                                      : ((an & 0xffff) < (source & 0xffff)) ? 1 : 0;
        this.r.x = this.r.c;
        this.r.v = sign ? 1 : 0;
      }
    };
  }

  /** ADDQ / SUBQ: add a small immediate to an EA. */
  decodeQuick(opcode, operation, size, ea) {
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    // Musashi derives the immediate from the register field in bits 11..9:
    // (((IR >> 9) - 1) & 7) + 1, so an encoded zero means "add 8".
    const data = (((opcode >>> 9) & 7) - 1 & 7) + 1;
    const isAdd = operation === "addq";

    return () => {
      if (mode === 1) {
        const old = this.r.a[reg];
        const result = u32(isAdd ? old + data : old - data);
        this.r.a[reg] = result;
        if (size === 4) {
          if (isAdd) this.addFlags(old, data, result, 4);
          else this.subFlags(old, data, result, 4);
        } else {
          const mask = maskFor(size);
          this.r.c = isAdd
            ? ((old & mask) + data) > mask ? 1 : 0
            : ((old & mask) < data) ? 1 : 0;
          this.r.x = this.r.c;
          this.r.v = 0;
          this.setFlagsNZ(result, size);
        }
        return;
      }

      const target = this.ea.decode(mode, reg, size);
      const old = this.readEA(target, size);
      const result = isAdd ? old + data : old - data;
      this.writeEA(target, size, result);
      if (size === 4) {
        if (isAdd) this.addFlags(old, data, result, 4);
        else this.subFlags(old, data, result, 4);
      } else {
        this.subFlags(old, data, result, size);
      }
    };
  }

  /** CLR / NEG / NEGX / NOT / TST. */
  decodeUnary(opcode, operation, size, ea) {
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    return () => {
      const target = this.ea.decode(mode, reg, size);
      switch (operation) {
        case "clr": {
          this.writeEA(target, size, 0);
          this.setFlagsNZ(0, size);
          this.r.v = 0;
          this.r.c = 0;
          return;
        }
        case "neg": {
          const old = this.readEA(target, size);
          const result = (0 - old) & maskFor(size);
          this.writeEA(target, size, result);
          this.subFlags(0, old, result, size);
          return;
        }
        case "negx": {
          const old = this.readEA(target, size);
          const result = (0 - old - this.r.x) & maskFor(size);
          this.writeEA(target, size, result);
          this.subFlags(0, old, result, size);
          return;
        }
        case "not": {
          const old = this.readEA(target, size);
          const result = ~old & maskFor(size);
          this.writeEA(target, size, result);
          this.setFlagsNZ(result, size);
          this.r.v = 0;
          this.r.c = 0;
          return;
        }
        case "tst": {
          const old = this.readEA(target, size);
          this.setFlagsNZ(old, size);
          this.r.v = 0;
          this.r.c = 0;
          return;
        }
        default:
          throw new Error(`Unsupported unary operation '${operation}'`);
      }
    };
  }

  /** Scc: set a byte to 0xff or 0x00 depending on the condition. */
  decodeSetCondition(opcode, ea) {
    const condition = (opcode >>> 8) & 0xf;
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    return () => {
      const target = this.ea.decode(mode, reg, 1);
      this.writeEA(target, 1, this.condition(condition) ? 0xff : 0x00);
    };
  }

  /** STOP #sr */
  decodeStop() {
    return () => {
      const value = this.fetch16();
      if (!this.r.supervisor) {
        this.exception(EXCEPTION.PRIVILEGE_VIOLATION, this.r.pc - 4, "privilege");
        return;
      }
      this.stopped |= STOP;
      this.setSR(value);
      this.stopPc = this.r.pc;
      if (this.stopped && this.cycleEnd) this.cycles = this.cycleEnd - 4 * this.mul;
    };
  }

  /**
   * ABCD / SBCD / NBCD / ADDX / SUBX.
   *
   * The "rr" form works on two register pairs with pre-decremented address
   * registers, the "mm" form on two memory operands.  In both cases the
   * destination register is encoded in bits 11..9 (DX) and the source
   * register in bits 2..0 (DY).
   */
  decodeExtended(opcode, operation, size, ea) {
    const eaMode = (opcode >>> 3) & 7;
    const eaReg = opcode & 7;
    const dx = (opcode >>> 9) & 7;
    const dy = opcode & 7;
    const isRegisterPair = ea === "rr";

    return () => {
      if (operation === "nbcd") {
        const mode = (opcode >>> 3) & 7;
        const reg = opcode & 7;
        const target = this.ea.decode(mode, reg, 1);
        const old = this.readEA(target, 1);
        const result = this.bcdNegate(old);
        this.writeEA(target, 1, result);
        return;
      }

      if (operation === "abcd" || operation === "sbcd") {
        let source;
        let destination;

        if (isRegisterPair) {
          // The register form works directly on two data registers.
          source = this.r.d[dy] & 0xff;
          destination = this.r.d[dx] & 0xff;
        } else {
          // Memory form: the source and destination are addressed by the
          // two register pairs.
          const sourceAddress = u32(this.r.a[dy] + sx16(this.fetch16()));
          const destinationAddress = u32(this.r.a[dx] + sx16(this.fetch16()));
          source = this.read8(sourceAddress);
          destination = this.read8(destinationAddress);
          this.r.a[dy] = u32(this.r.a[dy] + 2);
          this.r.a[dx] = u32(this.r.a[dx] + 2);
        }

        const result = operation === "abcd"
          ? this.bcdAdd(destination, source)
          : this.bcdSub(destination, source);

        if (isRegisterPair) {
          this.r.d[dx] = u32((this.r.d[dx] & 0xffffff00) | (result & 0xff));
        } else {
          this.write8(u32(this.r.a[dx] - 2), result & 0xff);
        }
        // The carry and extend flags were computed by the BCD helpers.
        return;
      }

      // ADDX / SUBX
      let source;
      let destination;

      if (isRegisterPair) {
        source = this.readEA({ type: EA.DN, reg: dy }, size);
        destination = this.readEA({ type: EA.DN, reg: dx }, size);
      } else {
        const sourceAddress = u32(this.r.a[dy] + sx16(this.fetch16()));
        const destinationAddress = u32(this.r.a[dx] + sx16(this.fetch16()));
        source = this.readEA({ type: -1, address: sourceAddress }, size);
        destination = this.readEA({ type: -1, address: destinationAddress }, size);
        const step = size === 1 ? 1 : size === 2 ? 2 : 4;
        this.r.a[dy] = u32(this.r.a[dy] + step);
        this.r.a[dx] = u32(this.r.a[dx] + step);
      }

      const result = operation === "addx"
        ? destination + source + this.r.x
        : destination - source - this.r.x;

      if (isRegisterPair) {
        this.writeEA({ type: EA.DN, reg: dx }, size, result);
      } else {
        this.writeEA({ type: -1, address: u32(this.r.a[dx] - (size === 1 ? 1 : size === 2 ? 2 : 4)) }, size, result);
      }

      if (operation === "addx") this.addFlags(destination, source, result, size);
      else this.subFlags(destination, source, result, size);
      this.r.x = this.r.c;
    };
  }

  /** CMPM: compare two memory blocks. */
  decodeCmpM(opcode, size, ea) {
    const srcReg = opcode & 7;
    const dstReg = (opcode >>> 9) & 7;
    const step = size === 1 ? 1 : size === 2 ? 2 : 4;
    return () => {
      const src = this.r.a[srcReg];
      const dst = this.r.a[dstReg];
      const source = this.readEA({ type: -1, address: src }, size);
      const target = this.readEA({ type: -1, address: dst }, size);
      const result = target - source;
      this.subFlags(target, source, result, size, true);
      this.r.a[srcReg] = u32(src + step);
      this.r.a[dstReg] = u32(dst + step);
    };
  }

  /** CHK: compare a register against a bound and trap on overflow. */
  decodeChk(opcode, size, ea) {
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    const boundReg = (opcode >>> 9) & 7;
    return () => {
      const target = this.ea.decode(mode, reg, 2);
      const bound = this.readEA(target, 2) & 0xffff;
      const value = this.r.d[boundReg];
      const lower = sx16(bound);
      const upper = sx16(value & 0xffff);
      if (value & 0x8000) {
        // Negative: trap when value < lower.
        if ((value | 0xffff0000) < (lower | 0xffff0000)) {
          this.exception(EXCEPTION.CHK, this.r.pc - 2, "illegal");
          return;
        }
        this.r.n = 1;
        return;
      }
      if (value > bound) {
        this.exception(EXCEPTION.CHK, this.r.pc - 2, "illegal");
        return;
      }
      this.r.n = 0;
    };
  }

  /** MULU / MULS / DIVU / DIVS. */
  decodeMultiplyDivide(opcode, operation, size, ea) {
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    const destReg = (opcode >>> 9) & 7;
    return () => {
      const target = this.ea.decode(mode, reg, 2);
      const source = this.readEA(target, 2) & 0xffff;
      const value = this.r.d[destReg] & 0xffff;

      switch (operation) {
        case "mulu": {
          const result = value * source;
          this.r.d[destReg] = u32(result & 0xffffffff);
          this.r.n = (result >>> 15) & 1;
          this.r.z = (result & 0xffff) === 0 ? 1 : 0;
          this.r.v = ((result >>> 15) & 1) ^ ((result >>> 31) & 1);
          this.r.c = 0;
          return;
        }
        case "muls": {
          const signed = sx16(value) * sx16(source);
          const result = signed & 0xffffffff;
          this.r.d[destReg] = u32(result);
          this.r.n = (result >>> 15) & 1;
          this.r.z = (result & 0xffff) === 0 ? 1 : 0;
          this.r.v = ((result >>> 15) & 1) ^ ((result >>> 31) & 1);
          this.r.c = 0;
          return;
        }
        case "divu": {
          if (source === 0) {
            this.exception(EXCEPTION.DIVIDE_BY_ZERO, this.r.pc - 2, "illegal");
            return;
          }
          const quotient = Math.floor(value / source);
          const remainder = value % source;
          if (quotient > 0xffff) {
            this.r.v = 1;
            this.r.n = 0;
            this.r.c = 0;
            this.r.z = 0;
            return;
          }
          this.r.d[destReg] = u32(((remainder & 0xffff) << 16) | (quotient & 0xffff));
          this.r.n = (quotient >>> 15) & 1;
          this.r.z = (quotient & 0xffff) === 0 ? 1 : 0;
          this.r.v = 0;
          this.r.c = 0;
          return;
        }
        case "divs": {
          const signedSource = sx16(source);
          if (signedSource === 0) {
            this.exception(EXCEPTION.DIVIDE_BY_ZERO, this.r.pc - 2, "illegal");
            return;
          }
          const dividend = sx32(this.r.d[destReg]);
          const quotient = Math.trunc(dividend / signedSource);
          const remainder = dividend % signedSource;
          if (quotient > 32767 || quotient < -32768) {
            this.r.v = 1;
            this.r.n = 0;
            this.r.c = 0;
            this.r.z = 0;
            return;
          }
          this.r.d[destReg] = u32(((remainder & 0xffff) << 16) | (quotient & 0xffff));
          this.r.n = (quotient >>> 15) & 1;
          this.r.z = (quotient & 0xffff) === 0 ? 1 : 0;
          this.r.v = 0;
          this.r.c = 0;
          return;
        }
        default:
          throw new Error(`Unsupported operation '${operation}'`);
      }
    };
  }


  readEA(address, size) {
    const cpu = this;
    const r = cpu.r;
    if (address.type === EA.DN) return size === 1 ? u8(r.d[address.reg]) : size === 2 ? u16(r.d[address.reg]) : u32(r.d[address.reg]);
    if (address.type === EA.AN) return size === 1 ? u8(r.a[address.reg]) : size === 2 ? u16(r.a[address.reg]) : u32(r.a[address.reg]);
    if (address.type === EA.IMM) return address.value;
    return size === 1 ? cpu.read8(address.address) : size === 2 ? cpu.read16(address.address) : cpu.read32(address.address);
  }

  writeEA(address, size, value) {
    const cpu = this;
    const r = cpu.r;
    if (address.type === EA.DN) {
      if (size === 1) r.d[address.reg] = u32((r.d[address.reg] & 0xffffff00) | u8(value));
      else if (size === 2) r.d[address.reg] = u32((r.d[address.reg] & 0xffff0000) | u16(value));
      else r.d[address.reg] = u32(value);
      return;
    }
    if (address.type === EA.AN) {
      if (size === 1) r.a[address.reg] = u32((r.a[address.reg] & 0xffffff00) | u8(value));
      else if (size === 2) r.a[address.reg] = u32((r.a[address.reg] & 0xffff0000) | u16(value));
      else r.a[address.reg] = u32(value);
      return;
    }
    if (size === 1) cpu.write8(address.address, value);
    else if (size === 2) cpu.write16(address.address, value);
    else cpu.write32(address.address, value);
  }

  addressEA(address) {
    if (address.type === EA.DN) return this.r.d[address.reg] >>> 0;
    if (address.type === EA.AN) return this.r.a[address.reg] >>> 0;
    return address.address >>> 0;
  }

  run(targetCycles) {
    if (this.cycles >= targetCycles) return;
    this.checkInterrupts();
    if (this.stopped) { this.cycles = targetCycles; return; }
    this.cycleEnd = targetCycles;
    while (this.cycles < targetCycles) {
      this.checkInterrupts();
      if (this.stopped) { this.cycles = targetCycles; break; }
      this.step();
    }
    this.cycleEnd = 0;
  }

  /** Run for a duration, independent of the reset cycle baseline. */
  runFor(cycles) { this.run(this.cycles + cycles); }

  snapshot() {
    return { r: this.r.snapshot(), cycles: this.cycles, intLevel: this.intLevel, stopped: this.stopped, instruction: this.instruction };
  }

  restore(state) {
    this.r.restore(state.r);
    this.cycles = state.cycles >>> 0;
    this.intLevel = state.intLevel >>> 0;
    this.stopped = state.stopped >>> 0;
    this.instruction = state.instruction >>> 0;
  }

  /**
   * BTST / BCHG / BCLR / BSET.
   *
   * The bit number is either a static 8 bit immediate or comes from a data
   * register (the "dynamic" form).
   */
  decodeBit(opcode) {
    const signature = handlerSignatures[opcode];
    const operation = signature[0];
    const rawSize = signature[1];
    const size = rawSize === 8 ? 1 : rawSize === 16 ? 2 : rawSize === 32 ? 4 : 0;
    const eaTokens = signature[3].split(",");
    const eaName = eaTokens[0];
    const dynamic = eaName === "r";

    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;
    const bitReg = (opcode >>> 9) & 7;

    return () => {
      let bit;
      if (dynamic) {
        const value = this.r.d[bitReg];
        bit = size === 4 ? (value & 0x1f) : (value & 0x07);
      } else {
        bit = this.fetch16() & 0xff;
      }

      const target = this.ea.decode(mode, reg, size);
      const old = this.readEA(target, size);
      const mask = 1 << (bit & (size * 8 - 1));
      this.r.z = old & mask ? 0 : 1;

      if (operation === "btst") return;

      let result = old;
      if (operation === "bchg") result ^= mask;
      else if (operation === "bclr") result &= ~mask;
      else if (operation === "bset") result |= mask;
      this.writeEA(target, size, result);
    };
  }

  /**
   * TAS <ea>: test a byte and set its high bit.
   */
  decodeTas(opcode) {
    const signature = handlerSignatures[opcode];
    const ea = signature[3].split(",")[0];
    const mode = (opcode >>> 3) & 7;
    const reg = opcode & 7;

    return () => {
      if (ea === "d") {
        const value = this.r.d[reg] & 0xff;
        this.setFlagsNZ(value, 1);
        this.r.v = 0;
        this.r.c = 0;
        this.r.d[reg] = u32(this.r.d[reg] | 0x80);
        return;
      }

      const target = this.ea.decode(mode, reg, 1);
      const value = this.readEA(target, 1);
      this.setFlagsNZ(value, 1);
      this.r.v = 0;
      this.r.c = 0;
      this.writeEA(target, 1, (value | 0x80) & 0xff);
      this.callbacks.tas?.(this.addressEA(target));
    };
  }

  /**
   * Branches.
   *
   *   BRA / Bcc  : 8 or 16 bit displacement relative to the address of the
   *                 extension word.
   *   BSR        : pushes the address of the extension word.
   *   DBcc       : decrements the lower word of Dn and branches when the
   *                 result is not 0xffff.
   */
  decodeBranch(opcode) {
    const signature = handlerSignatures[opcode];
    const operation = signature[0];
    const rawSize = signature[1];
    const isByteOffset = rawSize === 8;

    if (operation.startsWith("db")) {
      const reg = opcode & 7;
      return () => {
        const displacement = sx16(this.fetch16());
        const result = (u16(this.r.d[reg]) - 1) & 0xffff;
        this.r.d[reg] = u32((this.r.d[reg] & 0xffff0000) | result);
        if (result !== 0xffff) this.r.pc = u32(this.r.pc + displacement);
      };
    }

    if (operation === "bsr") {
      return () => {
        const displacement = sx16(this.fetch16());
        const target = u32(this.r.pc + displacement);
        this.push32(this.r.pc);
        this.r.pc = target;
      };
    }

    if (operation === "bra") {
      return () => {
        const displacement = isByteOffset ? sx8(this.fetch8()) : sx16(this.fetch16());
        this.r.pc = u32(this.r.pc + displacement);
      };
    }

    const condition = (opcode >>> 8) & 0xf;
    return () => {
      if (isByteOffset) {
        const displacement = sx8(this.fetch8());
        if (this.condition(condition)) this.r.pc = u32(this.r.pc + displacement);
        return;
      }
      const displacement = sx16(this.fetch16());
      if (this.condition(condition)) this.r.pc = u32(this.r.pc - 2 + displacement);
    };
  }

  /**
   * ASL / ASR / LSL / LSR / ROL / ROR / ROXL / ROXR.
   */
  decodeShift(opcode) {
    const signature = handlerSignatures[opcode];
    const operation = signature[0];
    const rawSize = signature[1];
    const size = rawSize === 8 ? 1 : rawSize === 16 ? 2 : rawSize === 32 ? 4 : 0;
    const ea = signature[3];
    const isMemory = ea === "s";

    const left = operation === "asl" || operation === "lsl" || operation === "rol" || operation === "roxl";
    const withExtend = operation === "roxl" || operation === "roxr";
    const rotate = operation === "rol" || operation === "ror" || operation === "roxl" || operation === "roxr";
    const arithmetic = operation === "asl" || operation === "asr";

    const reg = opcode & 7;
    const countReg = (opcode >>> 9) & 7;

    return () => {
      let count;
      const target = { type: EA.DN, reg };

      if (isMemory) {
        // The memory form shifts by (((IR >> 9) - 1) & 7) + 1 steps.
        count = (((opcode >>> 9) & 7) - 1 & 7) + 1;
      } else if ((opcode & 0x0020) !== 0) {
        count = this.r.d[countReg] & 63;
      } else {
        count = this.fetch16() & 63;
      }

      const old = this.readEA(target, size);
      const bits = size * 8;
      const mask = maskFor(size);
      let result = old & mask;
      let carry = 0;

      if (rotate) {
        let x = this.r.x;
        for (let i = 0; i < count; i++) {
          if (left) {
            carry = (result & (1 << (bits - 1))) ? 1 : 0;
            result = ((result << 1) | carry) & mask;
            if (withExtend && x) result = (result | 1) & mask;
          } else {
            carry = result & 1;
            result = ((result >>> 1) | (carry << (bits - 1))) & mask;
            if (withExtend && x) result = (result | (1 << (bits - 1))) & mask;
          }
        }
        this.r.c = carry;
        if (withExtend) this.r.x = carry;
        this.setFlagsNZ(result, size);
        this.r.v = 0;
        this.writeEA(target, size, result);
        return;
      }

      if (left) {
        carry = (result & (1 << (bits - 1))) ? 1 : 0;
        result = (result << count) & mask;
        this.r.c = carry;
        this.r.x = carry;

        if (operation === "asl") {
          // Musashi: src &= shift_table[shift + 1];
          //           V = !(src == 0 || (src == shift_table[shift + 1] && shift < 8))
          const table = size === 1 ? shift8 : size === 2 ? shift16 : shift32;
          const shifted = (old & mask) & table[count + 1];
          const signMask = table[count + 1];
          this.r.v = shifted !== 0 && !(shifted === signMask && count < bits) ? 1 : 0;
        } else {
          this.r.v = 0;
        }
      } else if (arithmetic) {
        carry = result & 1;
        const sign = result & (1 << (bits - 1));
        result = ((result >>> count) | (sign ? (((1 << count) - 1) << (bits - count)) : 0)) & mask;
        this.r.c = carry;
        this.r.x = carry;
      } else {
        carry = result & 1;
        result = (result >>> count) & mask;
        this.r.c = carry;
        this.r.x = carry;
      }

      this.setFlagsNZ(result, size);
      if (operation !== "asl") this.r.v = 0;
      this.writeEA(target, size, result);
    };
  }

  trap(number) { this.exception(EXCEPTION.TRAP_BASE + number, this.r.pc); }
}
