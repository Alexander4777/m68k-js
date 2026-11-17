import { CCR } from "./flags.js";

export { CCR, u8, u16, u32, sx8, sx16, sx32, maskFor, signFor, sizeFromBits, bitsFromSize } from "./flags.js";

/**
 * Musashi public SR layout (verified against the C core):
 *   T (15) | S (13) | interrupt mask (10..8) | X (4) | N (3) | Z (2) | V (1) | C (0)
 *
 * Musashi stores FLAG_S internally as 4 and exposes it as FLAG_S << 11,
 * i.e. 0x2000 (bit 13) in the public SR value. The reset SR is therefore
 * 0x2700 (S + interrupt mask 7).
 */
export const SR_SUPERVISOR = 0x2000;
export const SR_TRACE = 0x8000;
export const SR_MASK = 0xa71f;

export class Registers {
  constructor() {
    this.d = new Uint32Array(8);
    this.a = new Uint32Array(8);
    this.pc = 0;
    this.sr = 0x2700;
    // Mirrors Musashi's `sp[5]` array: sp[0] is the user stack pointer and
    // sp[4] the interrupt (supervisor) stack pointer.  The active stack
    // pointer lives in A7, exactly like Musashi's `dar[15]`.
    this.sp = new Uint32Array(5);
    this.ir = 0;
  }

  // A7 is the active stack pointer.
  get a7() { return this.a[7]; }
  set a7(value) { this.a[7] = value >>> 0; }

  /** The user stack pointer (Musashi's sp[0]). */
  get usp() { return this.sp[0]; }
  set usp(value) { this.sp[0] = value >>> 0; }

  /**
   * The interrupt stack pointer.  Musashi reports the *active* stack pointer
   * while in supervisor mode and sp[4] otherwise.
   */
  get isp() { return this.sr & SR_SUPERVISOR ? this.a[7] : this.sp[4]; }
  set isp(value) { this.sp[4] = value >>> 0; }

  get c() { return this.sr & CCR.C ? 1 : 0; }
  set c(value) { this.sr = value ? this.sr | CCR.C : this.sr & ~CCR.C; }
  get v() { return this.sr & CCR.V ? 1 : 0; }
  set v(value) { this.sr = value ? this.sr | CCR.V : this.sr & ~CCR.V; }
  get z() { return this.sr & CCR.Z ? 1 : 0; }
  set z(value) { this.sr = value ? this.sr | CCR.Z : this.sr & ~CCR.Z; }
  get n() { return this.sr & CCR.N ? 1 : 0; }
  set n(value) { this.sr = value ? this.sr | CCR.N : this.sr & ~CCR.N; }
  get x() { return this.sr & CCR.X ? 1 : 0; }
  set x(value) { this.sr = value ? this.sr | CCR.X : this.sr & ~CCR.X; }

  get supervisor() { return !!(this.sr & SR_SUPERVISOR); }

  /**
   * Change the supervisor flag, mirroring Musashi's `m68ki_set_s_flag()`:
   *
   *   sp[old_s] = A7;      // save the active stack pointer
   *   S = new_s;
   *   A7 = sp[new_s];      // activate the other stack pointer
   *
   * Musashi indexes the array with the raw flag value (0 for user, 4 for
   * supervisor), hence sp[0] and sp[4].
   */
  setSupervisor(value) {
    const was = this.sr & SR_SUPERVISOR;
    const next = value ? SR_SUPERVISOR : 0;
    if (was === next) return;
    // Save the active stack pointer in the slot of the current mode.
    if (was) this.sp[4] = this.a[7]; else this.sp[0] = this.a[7];
    this.sr = (this.sr & ~SR_SUPERVISOR) | next;
    // Activate the stack pointer of the new mode.
    this.a[7] = next ? this.sp[4] : this.sp[0];
  }

  set supervisor(value) { this.setSupervisor(value); }

  /** Set S without touching the stack pointers (used during reset). */
  setSupervisorWithoutStackSwap(value) {
    if (value) this.sr |= SR_SUPERVISOR; else this.sr &= ~SR_SUPERVISOR;
  }

  get interruptMask() { return (this.sr >>> 8) & 7; }
  set interruptMask(value) { this.sr = (this.sr & ~0x0700) | ((value & 7) << 8); }
  setCcr(value) { this.sr = (this.sr & ~0x1f) | (value & 0x1f); }
  getCcr() { return this.sr & 0x1f; }

  snapshot() {
    return {
      d: [...this.d],
      a: [...this.a],
      pc: this.pc >>> 0,
      sr: this.sr >>> 0,
      sp: [...this.sp],
    };
  }

  restore(state) {
    this.d.set(state.d);
    this.a.set(state.a);
    this.pc = state.pc >>> 0;
    this.sr = state.sr >>> 0;
    if (state.sp) this.sp.set(state.sp);
  }
}
