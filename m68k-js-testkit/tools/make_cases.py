#!/usr/bin/env python3
"""
m68k-js-testkit :: test case definitions
========================================

Each test case describes one differential scenario:

    name        : unique identifier
    rom         : image file (relative to tests/roms)
    cycles      : master cycle budget for the run
    step_cycles : distance between two trace checkpoints
    load_addr   : where the image is loaded in the 16 MiB address space
    irq         : list of "level@cycle" interrupt requests
    dump_mem    : list of "addr:len" memory ranges to include in the dump

The file is plain JSON so that it can be edited without touching Python.
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TESTKIT = os.path.dirname(HERE)

CASES = [
    {
        "name": "minimal",
        "rom": "minimal.bin",
        "cycles": 2000,
        "step_cycles": 100,
        "load_addr": 0,
        "irq": [],
        "dump_mem": ["0x000F0000:64"],
    },
    {
        "name": "arith",
        "rom": "arith.bin",
        "cycles": 4000,
        "step_cycles": 100,
        "load_addr": 0,
        "irq": [],
        "dump_mem": ["0x000F0000:64"],
    },
    {
        "name": "shifts",
        "rom": "shifts.bin",
        "cycles": 4000,
        "step_cycles": 100,
        "load_addr": 0,
        "irq": [],
        "dump_mem": ["0x000F0000:64"],
    },
    {
        "name": "multdiv",
        "rom": "multdiv.bin",
        "cycles": 4000,
        "step_cycles": 100,
        "load_addr": 0,
        "irq": [],
        "dump_mem": ["0x000F0000:80"],
    },
    {
        "name": "bcd",
        "rom": "bcd.bin",
        "cycles": 4000,
        "step_cycles": 100,
        "load_addr": 0,
        "irq": [],
        "dump_mem": ["0x000F0000:64"],
    },
    {
        "name": "bits",
        "rom": "bits.bin",
        "cycles": 4000,
        "step_cycles": 100,
        "load_addr": 0,
        "irq": [],
        "dump_mem": ["0x000F0000:64"],
    },
    {
        "name": "branches",
        "rom": "branches.bin",
        "cycles": 4000,
        "step_cycles": 100,
        "load_addr": 0,
        "irq": [],
        "dump_mem": ["0x000F0000:64"],
    },
    {
        "name": "exceptions",
        "rom": "exceptions.bin",
        "cycles": 4000,
        "step_cycles": 100,
        "load_addr": 0,
        "irq": [],
        "dump_mem": ["0x000F0000:64"],
    },
    {
        "name": "loops",
        "rom": "loops.bin",
        "cycles": 8000,
        "step_cycles": 250,
        "load_addr": 0,
        "irq": [],
        "dump_mem": ["0x000F0000:64"],
    },
    {
        "name": "stack",
        "rom": "stack.bin",
        "cycles": 4000,
        "step_cycles": 100,
        "load_addr": 0,
        "irq": [],
        "dump_mem": ["0x000F0000:80"],
    },
    {
        "name": "supervisor",
        "rom": "supervisor.bin",
        "cycles": 4000,
        "step_cycles": 100,
        "load_addr": 0,
        "irq": [],
        "dump_mem": ["0x000F0000:64"],
    },
    {
        "name": "interrupt-level6",
        "rom": "loops.bin",
        "cycles": 8000,
        "step_cycles": 250,
        "load_addr": 0,
        "irq": ["6@1000"],
        "dump_mem": ["0x000F0000:64"],
    },
]


def main():
    out = os.path.join(TESTKIT, "tests", "cases.json")
    with open(out, "w") as f:
        json.dump(CASES, f, indent=2)
        f.write("\n")
    print("wrote %s (%d cases)" % (out, len(CASES)))


if __name__ == "__main__":
    main()
