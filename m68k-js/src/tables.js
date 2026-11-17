import { readFileSync } from "node:fs";

export const handlerNames = JSON.parse(
  readFileSync(new URL("./opcodes.json", import.meta.url), "utf8"),
);

/**
 * Parsed handler signatures: [operation, size, form, ea] per opcode.
 *
 * The signatures are generated from Musashi's own instruction jump table
 * (see tools/generate-handlers.py) so that the decoder follows the C core
 * instead of guessing from the raw opcode bits.
 */
export const handlerSignatures = JSON.parse(
  readFileSync(new URL("./handlers.json", import.meta.url), "utf8"),
);

function loadCycleTable(url) {
  const source = readFileSync(url, "utf8");
  const body = source.slice(source.indexOf("{") + 1, source.lastIndexOf("}"));
  const values = body.match(/\d+\s*\*\s*\d+/g) ?? [];
  if (values.length !== 65536) {
    throw new Error(`Invalid Musashi cycle table: expected 65536 entries, got ${values.length}`);
  }
  // Musashi stores the table as "<base> * MUL" (e.g. "8*7"). The CPU
  // multiplies the resulting master-cycle cost by its own MUL factor, so
  // the table must keep the already-scaled master-cycle value here.
  return Uint16Array.from(values, (entry) => {
    const [base, multiplier] = entry.split("*").map((part) => Number.parseInt(part, 10));
    return base * multiplier;
  });
}

export const mainCycles = loadCycleTable(new URL("../../m68k/m68ki_cycles.h", import.meta.url));
export const subCycles = loadCycleTable(new URL("../../m68k/s68ki_cycles.h", import.meta.url));

export const shift8 = Uint8Array.from({ length: 65 }, (_, count) => count === 0 ? 0 : (0xff << (8 - count)) & 0xff);
export const shift16 = Uint16Array.from({ length: 65 }, (_, count) => count === 0 ? 0 : (0xffff << (16 - count)) & 0xffff);
export const shift32 = Uint32Array.from({ length: 65 }, (_, count) => count === 0 ? 0 : (0xffffffff << (32 - count)) >>> 0);

export const exceptionCycles = Uint16Array.from({ length: 256 }, (_, vector) => {
  if (vector === 0) return 40;
  if (vector === 2 || vector === 3) return 50;
  if ([4, 7, 8, 9, 10, 11].includes(vector)) return 34;
  if (vector === 5 || vector === 6) return 38;
  if (vector === 15 || (vector >= 24 && vector <= 31)) return 44;
  if (vector >= 32 && vector <= 47) return 34;
  return 4;
});

export const interruptCycles = Uint16Array.from([50, 59, 58, 57, 56, 55, 54, 53, 52, 51]);
export const subIrqLevels = Uint8Array.from([
  0, 1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
]);
