#!/usr/bin/env python3
"""
m68k-js-testkit :: regenerate the opcode expectation table
=========================================================

Walks the test ROMs with the length decoder and the Musashi jump table
and prints a ready to paste `EXPECTED` table for
`tools/validate_opcodes.py`.

The generated entries are the *ground truth* of what Musashi decodes, so
regenerating the table is the way to update it after a ROM change.  The
human readable mnemonic is derived from the Musashi handler name.

Usage:
    tools/gen_expected.py [roms_dir] [musashi_dir]
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TESTKIT = os.path.dirname(HERE)
DEFAULT_MUSASHI = os.path.join(TESTKIT, "..", "m68k")

sys.path.insert(0, HERE)
import validate_opcodes as v  # noqa: E402


def mnemonic(handler):
    """Turn a Musashi handler name into a readable mnemonic."""
    h = handler
    if h.startswith("m68k_op_"):
        h = h[len("m68k_op_"):]
    h = h.replace("_", " ")
    return h.upper()


def main():
    roms_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        TESTKIT, "tests", "roms")
    musashi_dir = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_MUSASHI

    names = v.load_jump_table(musashi_dir)
    if names is None:
        return 2

    opcodes, illegal = v.collect_opcodes(roms_dir, names)

    print("EXPECTED = {")
    for op in sorted(opcodes):
        handler = names[op]
        if handler == "m68k_op_illegal":
            continue
        # The expected substring is the handler name without the common
        # prefix, so that the table stays readable.
        key = handler[len("m68k_op_"):] if handler.startswith("m68k_op_") \
            else handler
        print("    0x%04X: (\"%s\", \"%s\")," % (op, key, mnemonic(handler)))
    print("}")

    if illegal:
        print("")
        print("# WARNING: illegal opcodes executed:")
        for name, pc, op in illegal:
            print("#   0x%04X at %s@%04X" % (op, name, pc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
