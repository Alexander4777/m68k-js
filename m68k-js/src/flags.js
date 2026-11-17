export const CCR = Object.freeze({ C: 1, V: 2, Z: 4, N: 8, X: 16 });

export function u8(value) { return value & 0xff; }
export function u16(value) { return value & 0xffff; }
export function u32(value) { return value >>> 0; }
export function sx8(value) { return (value & 0x80) ? (value | 0xffffff00) : (value & 0xff); }
export function sx16(value) { return (value & 0x8000) ? (value | 0xffff0000) : (value & 0xffff); }
export function sx32(value) { return value | 0; }

export function maskFor(size) {
  return size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff;
}

export function signFor(size) {
  return size === 1 ? 0x80 : size === 2 ? 0x8000 : 0x80000000;
}

export function sizeFromBits(bits) {
  return (bits & 3) === 0 ? 1 : (bits & 3) === 1 ? 2 : 4;
}

export function bitsFromSize(size) {
  return size === 1 ? 0 : size === 2 ? 1 : 2;
}
