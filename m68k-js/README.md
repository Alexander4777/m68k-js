# m68k-js

Motorola 68000 CPU emulator written as an ESM JavaScript library. It is based
on the Musashi v3.32 CPU core in [`../m68k`](../m68k).

## Features

- CPU state and Musashi-compatible register API.
- 256-page memory bus with big-endian access and I/O callbacks.
- Effective-address handling for all 68000 addressing modes.
- Instruction decoder and executor.
- Cycle accounting using Musashi's generated opcode tables.
- Exception and interrupt handling.
- Serializable snapshots.
- Opcode metadata for all 65,536 encodings.

The status register follows the exact public layout used by Musashi:

```
T (15) | S (13) | interrupt mask (10..8) | X (4) | N (3) | Z (2) | V (1) | C (0)
```

So the supervisor bit is `0x2000`, and a freshly reset core reports
`SR = 0x2704` (supervisor + interrupt mask 7 + Z set).

## Install

```sh
npm install
```

The package uses ESM and requires Node.js 18 or newer.

## Usage

```js
import { M68K, MemoryBus, M68K_REG } from "@emu68k/m68k";

const ram = new Uint8Array(0x20000);
const bus = new MemoryBus().map(0, ram);
const cpu = new M68K({ bus });

// Initial supervisor stack pointer and program counter (big endian).
ram[0] = 0x00; ram[1] = 0x10; ram[2] = 0x00; ram[3] = 0x00;
ram[4] = 0x00; ram[5] = 0x00; ram[6] = 0x08; ram[7] = 0x00;

// MOVEQ #-1,D0
ram[0x800] = 0x70; ram[0x801] = 0xff;

cpu.reset();
cpu.step();

console.log(cpu.getReg(M68K_REG.D0).toString(16)); // ffffffff
```

`MemoryBus.map(page, bytes, offset, callbacks)` maps a 64 KiB page. The high
byte of the 24-bit address selects the page. Pages can also provide `read8`,
`read16`, `write8`, and `write16` callbacks for I/O.

## API

- `new M68K({ bus, mul, prefetch, addressError, subCpu })`
- `cpu.reset()`
- `cpu.step()` — executes one instruction.
- `cpu.run(absoluteTargetCycles)` — runs to an **absolute** cycle target, the
  same semantics as Musashi's `m68k_run()`. The reset itself costs 280 master
  cycles on a 68000, and that cost is included in the counter.
- `cpu.runFor(cycles)` — runs for a duration relative to the current counter.
- `cpu.setIrq(level)`, `cpu.updateIrq(mask)`, `cpu.pulseHalt()`,
  `cpu.clearHalt()`
- `cpu.getReg(M68K_REG.PC)`, `cpu.setReg(M68K_REG.D0, value)`
- `cpu.getSR()`, `cpu.setSR(value)`
- `cpu.snapshot()`, `cpu.restore(state)`
- `opcodeInfo(opcode)` — Musashi handler name and legal/illegal status.

## Memory bus contract

`MemoryBus` mimics Musashi's `memory_map[256]`: the high byte of the address
selects one of 256 pages of 64 KiB. A page may provide plain RAM (`base`) or
`read8` / `read16` / `write8` / `write16` callbacks for I/O.

As in Musashi, **immediate and PC-relative fetches read directly from the
mapped memory and bypass the I/O callbacks**. Those fetches are implemented by
`MemoryBus.readImmediate16()` / `readImmediate32()`.

## Verification

```sh
npm test
```

The suite runs 44 tests, including 11 differential ROMs compared against the
original Musashi C core:

- a final-state comparison (PC, SR, D0..D7, A0..A7 and the condition codes),
- and an **instruction-by-instruction** comparison that checks the same
  architectural state after every single instruction.

The neighboring [`../m68k-js-testkit`](../m68k-js-testkit) directory contains
the C harness that builds the unmodified Musashi sources for that comparison;
it is compiled automatically if it is missing.

## How the decoder works

The opcode semantics are not guessed from the raw opcode bits. The Musashi
instruction jump table encodes the complete meaning of every opcode in its
handler names (`m68k_op_add_32_er_d` is a long ADD whose effective address is
the destination and whose EA is a data register, and so on). The
`tools/generate-handlers.py` script parses those names into
`src/handlers.json`, and the decoder dispatches on the resulting signature:

```js
[operation, size, form, ea]   // e.g. ["add", 32, "er", "d"]
```

Regenerate the table after changing the Musashi sources:

```sh
python3 tools/generate-handlers.py
```

## License and attribution

This package is a derivative of Musashi v3.32 by Karl Stenerud and Genesis
Plus GX by Charles MacDonald / Eke-Eke. See [`NOTICE.md`](NOTICE.md) and
[`LICENSE.txt`](LICENSE.txt). The Musashi license permits non-commercial use
with attribution; commercial use requires the appropriate license.
