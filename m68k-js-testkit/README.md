# m68k-js-testkit

Reference harness for differential testing of `../m68k-js` against the
unmodified Musashi C core in `../m68k`.

## Build

```sh
make
```

The harness force-includes `tools/m68kconf_testkit.h`; the read-only Musashi
source is never patched.

## Run one ROM

```sh
./out/c-harness --rom tests/roms/minimal.bin --cycles 100 --out /tmp/minimal.json
```

The JSON trace includes all D/A registers, PC, SR, stack pointers, IR,
prefetch state, cycle counters and per-checkpoint snapshots.

## Compare with JavaScript

The JavaScript implementation must expose the same snapshot fields and accept
a ROM plus an absolute cycle target. A future comparison runner should load
the ROM into the JavaScript page bus, reset, run to the same target and
compare all trace fields exactly.
