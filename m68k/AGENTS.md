# AGENTS.md

## Scope
- This directory is only the Musashi Motorola 68000 CPU core, not a complete emulator or executable. A host program must provide memory and integrate the API.
- `m68kcpu.c` is the main/Sega CPU; `s68kcpu.c` is the Sega CD Sub CPU. They share headers and core symbols, so compiling both together may require separating or renaming shared symbols as the original Genesis Plus GX setup does.

## Host integration
- Host code must populate each CPU's `memory_map[256]` entries (`m68k` or `s68k`) before reset/execution. The high address byte selects the map entry; entries use `base` for RAM/ROM or optional `read8`/`read16`/`write8`/`write16` callbacks for I/O.
- Immediate and PC-relative fetches read directly from `memory_map[].base`; they do not use the I/O callbacks.
- Call `m68k_init()`/`s68k_init()` and `m68k_pulse_reset()`/`s68k_pulse_reset()` before running a CPU. Reset reads the initial SSP and PC from addresses 0 and 4.
- Run with `m68k_run(cycles)`/`s68k_run(cycles)`. The argument is an absolute target cycle count, not a duration.
- The public API and core state are in `m68k.h`.

## Configuration gotchas
- `m68kconf.h` and `s68kconf.h` are separate build configurations. Both use the same include guard (`M68KCONF__HEADER`) and define the same `OPT_*` constants; do not include both in one translation unit.
- Current configs directly call Genesis Plus GX IRQ handlers: `vdp_68k_irq_ack()` and `scd_68k_irq_ack()`. A standalone host must replace these callbacks or disable interrupt acknowledgement.
- `s68kconf.h` enables address-error exceptions only when `ENABLE_SUB_68K_ADDRESS_ERROR_EXCEPTIONS` is defined.
- `m68kcpu.c` and `s68kcpu.c` define the shared core through different `m68ki_cpu` aliases and use different cycle multipliers (`MUL` 7 and 4). Preserve that per-file setup when changing timing.
- `INLINE` defaults to `static __inline__` in `macros.h`; the host may override it. Disabling inline functions severely reduces emulation speed.
- `LSB_FIRST` changes the byte/word access macros in `macros.h`; direct 16/32-bit memory accesses in `m68kcpu.h` remain host-endian unless handled by the host's mapping design.
- `HOOK_CPU` enables `debug/cpuhook.h` hooks. The header expects the host to define/provide `cpu_hook` and `set_cpu_hook`; it does not define them itself.

## Generated tables
- `m68ki_cycles.h`, `s68ki_cycles.h`, and `m68ki_instruction_jump_table.h` are large generated/static tables. Avoid hand-editing them unless the task is specifically to change the tables.
- `BUILD_TABLES` switches the cycle-table build path; the normal build includes the checked-in cycle headers instead.

## Verification
- There is no build system, test suite, lint configuration, or CI in this directory. Do not invent standard repo commands; verify changes with the consuming host project or a small local compile harness.
- Preserve the Musashi/Genesis Plus GX attribution and licensing notices when adding files or redistributing code; see `readme.txt`, `LICENSE.txt`, and `CREDITS.md`.
