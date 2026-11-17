import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { M68K, MemoryBus } from '../src/index.js';

const testkit = new URL('../../m68k-js-testkit/', import.meta.url);
const harness = new URL('out/c-harness', testkit);

if (!existsSync(harness)) {
  const build = spawnSync('make', ['-C', testkit.pathname, 'all'], { encoding: 'utf8' });
  assert.equal(build.status, 0, `failed to build the C reference harness:\n${build.stderr}`);
}

function runReferenceTrace(rom, cycles) {
  const out = `/tmp/opencode/m68k-js-trace-${rom}.json`;
  const result = spawnSync(
    harness.pathname,
    [
      '--rom', new URL(`tests/roms/${rom}.bin`, testkit).pathname,
      '--cycles', String(cycles),
      '--trace-instructions',
      '--out', out,
      '--quiet',
    ],
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

function compareInstruction(cpu, state, index) {
  const where = `instruction #${index} (C: pc=${state.pc} ir=${state.ir})`;
  assert.equal(cpu.r.pc >>> 0, parseInt(state.pc, 16), `${where}: pc`);
  assert.equal(cpu.r.sr & 0xffff, parseInt(state.sr, 16), `${where}: sr`);
  assert.equal(cpu.r.ir & 0xffff, parseInt(state.ir, 16), `${where}: ir`);
  for (let i = 0; i < 8; i++) {
    assert.equal(cpu.r.d[i] >>> 0, parseInt(state.d[i], 16), `${where}: d${i}`);
    assert.equal(cpu.r.a[i] >>> 0, parseInt(state.a[i], 16), `${where}: a${i}`);
  }
  assert.equal(cpu.r.n, state.flags.n, `${where}: N`);
  assert.equal(cpu.r.z, state.flags.z, `${where}: Z`);
  assert.equal(cpu.r.v, state.flags.v, `${where}: V`);
  assert.equal(cpu.r.c, state.flags.c, `${where}: C`);
  assert.equal(cpu.r.x, state.flags.x, `${where}: X`);
}

// The number of cycles is a program dependent value; these budgets stop
// the programs shortly after they reach their STOP instruction.
const budgets = {
  minimal: 400,
  arith: 4000,
  shifts: 4000,
  multdiv: 4000,
  bcd: 4000,
  bits: 4000,
  branches: 4000,
  exceptions: 4000,
  loops: 4000,
  stack: 4000,
  supervisor: 4000,
};

for (const [rom, cycles] of Object.entries(budgets)) {
  test(`${rom} ROM matches Musashi instruction by instruction`, () => {
    const ref = runReferenceTrace(rom, cycles);
    assert.equal(ref.trace_instructions, true, 'the harness must produce an instruction trace');

    const { cpu } = load(rom);
    cpu.reset();

    const steps = ref.states.length;
    assert.ok(steps > 0, 'the reference trace must not be empty');

    for (let i = 0; i < steps; i++) {
      if (cpu.stopped) {
        // Musashi's m68k_run() returns immediately when the core is stopped,
        // only advancing the cycle counter.  The C harness records one state
        // per such call, so mirror that behaviour here.
        cpu.cycles = ref.states[i].abs_cycles;
      } else {
        cpu.step();
      }
      compareInstruction(cpu, ref.states[i], i);
    }
  });
}
