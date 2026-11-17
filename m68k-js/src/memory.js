import { u16, u32 } from "./registers.js";

/** Musashi-compatible 256-page address space. */
export class MemoryBus {
  constructor() {
    this.pages = new Array(256).fill(null);
    this._read8 = null;
    this._read16 = null;
    this._write8 = null;
    this._write16 = null;
  }
  set read8(value) { this._read8 = value; }
  get read8() { return this._read8; }
  set read16(value) { this._read16 = value; }
  get read16() { return this._read16; }
  set write8(value) { this._write8 = value; }
  get write8() { return this._write8; }
  set write16(value) { this._write16 = value; }
  get write16() { return this._write16; }
  map(page, memory = null, offset = 0, callbacks = {}) {
    if (!Number.isInteger(page) || page < 0 || page > 255) throw new RangeError("Page must be an integer between 0 and 255");
    if (memory && !(memory instanceof Uint8Array)) {
      if (memory instanceof ArrayBuffer) memory = new Uint8Array(memory);
      else if (ArrayBuffer.isView(memory)) memory = new Uint8Array(memory.buffer, memory.byteOffset, memory.byteLength);
      else throw new TypeError("Memory must be a Uint8Array or ArrayBuffer");
    }
    this.pages[page] = { memory, offset: offset >>> 0, read8: callbacks.read8 ?? null, read16: callbacks.read16 ?? null, write8: callbacks.write8 ?? null, write16: callbacks.write16 ?? null };
    return this;
  }
  unmap(page) { this.pages[page & 0xff] = null; return this; }
  _map(address) { return this.pages[(address >>> 16) & 0xff]; }
  read8(address) {
    address = u32(address); const page = this._map(address);
    if (page?.read8) return page.read8(address & 0x00ffffff) & 0xff;
    if (page?.memory) return page.memory[(address + page.offset) & 0xffff] & 0xff;
    return this._read8 ? this._read8(address) & 0xff : 0xff;
  }
  read16(address) {
    address = u32(address); const page = this._map(address);
    if (page?.read16) return page.read16(address & 0x00ffffff) & 0xffff;
    if (page?.memory) { const o = address & 0xfffe; return ((page.memory[o] << 8) | page.memory[o + 1]) & 0xffff; }
    return this._read16 ? this._read16(address) & 0xffff : 0xffff;
  }
  read32(address) { return ((this.read16(address) << 16) | this.read16(address + 2)) >>> 0; }
  write8(address, value) {
    address = u32(address); value &= 0xff; const page = this._map(address);
    if (page?.write8) return page.write8(address & 0x00ffffff, value);
    if (page?.memory) { page.memory[(address + page.offset) & 0xffff] = value; return; }
    this._write8?.(address, value);
  }
  write16(address, value) {
    address = u32(address); value &= 0xffff; const page = this._map(address);
    if (page?.write16) return page.write16(address & 0x00ffffff, value);
    if (page?.memory) { const o = (address + page.offset) & 0xfffe; page.memory[o] = value >>> 8; page.memory[o + 1] = value & 0xff; return; }
    this._write16?.(address, value);
  }
  write32(address, value) { this.write16(address, value >>> 16); this.write16(address + 2, value & 0xffff); }
  readImmediate8(address) {
    const page = this._map(address); if (!page?.memory) return this.read8(address);
    return page.memory[address & 0xffff] & 0xff;
  }
  readImmediate16(address) {
    const page = this._map(address); if (!page?.memory) return this.read16(address);
    const o = address & 0xffff; return ((page.memory[o] << 8) | page.memory[o + 1]) & 0xffff;
  }
  readImmediate32(address) { return ((this.readImmediate16(address) << 16) | this.readImmediate16(address + 2)) >>> 0; }
  read(address, size) { return size === 1 ? this.read8(address) : size === 2 ? this.read16(address) : this.read32(address); }
  write(address, size, value) { if (size === 1) this.write8(address, value); else if (size === 2) this.write16(address, value); else this.write32(address, value); }
}
