import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { M68K, MemoryBus } from '../src/index.js';

const testkit = new URL('../../m68k-js-testkit/', import.meta.url);
const harness = new URL('out/c-harness', testkit);

// The reference harness must match the current Musashi sources; a stale
// binary silently produces bogus differential results.
if (!existsSync(harness)) {
  const build = spawnSync('make', ['-C', testkit.pathname, 'all'], { encoding: 'utf8' });
  assert.equal(build.status, 0, `failed to build the C reference harness:\n${build.stderr}`);
}

function runReference(rom, cycles = 100) {
  const out = `/tmp/opencode/m68k-js-reference-${rom}.json`;
  const result = spawnSync(
    harness.pathname,
    ['--rom', new URL(`tests/roms/${rom}.bin`, testkit).pathname, '--cycles', String(cycles), '--out', out, '--quiet'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(out, 'utf8'));
}

function load(rom) {
  const bytes = readFileSync(new URL(`tests/roms/${rom}.bin`, testkit));
  const bus = new MemoryBus();
  for (let page = 0; page < 256; page++) bus.map(page, new Uint8Array(0x10000));
  for (let i = 0; i < bytes.length; i++) bus.pages[0].memory[i] = bytes[i];
  return { cpu: new M68K({ bus }), bus };
}

function compareState(cpu, state) {
  assert.equal(cpu.r.pc >>> 0, parseInt(state.pc, 16), 'pc');
  assert.equal(cpu.r.sr & 0xffff, parseInt(state.sr, 16), 'sr');
  for (let i = 0; i < 8; i++) {
    assert.equal(cpu.r.d[i] >>> 0, parseInt(state.d[i], 16), `d${i}`);
    assert.equal(cpu.r.a[i] >>> 0, parseInt(state.a[i], 16), `a${i}`);
  }
  assert.equal(cpu.r.n, state.flags.n, 'N');
  assert.equal(cpu.r.z, state.flags.z, 'Z');
  assert.equal(cpu.r.v, state.flags.v, 'V');
  assert.equal(cpu.r.c, state.flags.c, 'C');
  assert.equal(cpu.r.x, state.flags.x, 'X');
}

for (const rom of ['minimal', 'arith', 'shifts', 'multdiv', 'bcd', 'bits', 'branches', 'exceptions', 'loops', 'stack', 'supervisor']) {
  test(`${rom} ROM matches Musashi architectural state`, () => {
    const ref = runReference(rom);
    const { cpu } = load(rom);
    cpu.reset();
    // The C harness uses an absolute cycle target that includes the reset cost.
    cpu.run(ref.abs_final_cycles);
    compareState(cpu, ref.final);
  });
}
