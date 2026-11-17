import names from "./opcodes.json" with { type: "json" };

export const OPCODE_NAMES = names;
export const OPCODE_LEGAL = Uint8Array.from(names, (name) => name === "m68k_op_illegal" || name === "m68k_op_1010" || name === "m68k_op_1111" ? 0 : 1);

export function opcodeInfo(opcode) {
  const value = opcode >>> 0;
  const illegal = value === 0x4e72 || value === 0x4e74 || value === 0x4e75;
  return { opcode: value, name: OPCODE_NAMES[value], legal: !illegal && !!OPCODE_LEGAL[value] };
}
