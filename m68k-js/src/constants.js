export const M68K_REG = Object.freeze({
  D0: 0, D1: 1, D2: 2, D3: 3, D4: 4, D5: 5, D6: 6, D7: 7,
  A0: 8, A1: 9, A2: 10, A3: 11, A4: 12, A5: 13, A6: 14, A7: 15,
  PC: 16, SR: 17, SP: 18, USP: 19, ISP: 20,
  PREF_ADDR: 21, PREF_DATA: 22, IR: 23,
});

export const M68K_IRQ = Object.freeze({
  NONE: 0, LEVEL_1: 1, LEVEL_2: 2, LEVEL_3: 3,
  LEVEL_4: 4, LEVEL_5: 5, LEVEL_6: 6, LEVEL_7: 7,
});

export const M68K_INT_ACK_AUTOVECTOR = 0xffffffff;
export const M68K_INT_ACK_SPURIOUS = 0xfffffffe;

export const STOP_LEVEL = Object.freeze({
  STOP: 1, HALT: 2, WAIT: 4,
});

export const EXCEPTION = Object.freeze({
  RESET: 0, BUS_ERROR: 2, ADDRESS_ERROR: 3, ILLEGAL_INSTRUCTION: 4,
  ZERO_DIVIDE: 5, CHK: 6, TRAPV: 7, PRIVILEGE_VIOLATION: 8,
  TRACE: 9, LINE_A: 10, LINE_F: 11, UNINITIALIZED_INTERRUPT: 15,
  SPURIOUS_INTERRUPT: 24, INTERRUPT_AUTOVECTOR: 24, TRAP_BASE: 32,
});

export const FUNCTION_CODE = Object.freeze({
  USER_DATA: 1, USER_PROGRAM: 2, SUPERVISOR_DATA: 5,
  SUPERVISOR_PROGRAM: 6, CPU_SPACE: 7,
});
