#!/usr/bin/env python3
"""Generate src/handlers.json from the Musashi instruction jump table.

The Musashi handler names encode the complete semantics of every opcode:

    m68k_op_<operation>_<size>_<form>_<ea>

For example ``m68k_op_add_32_er_d`` is a long ADD where the effective
address is the destination (``er``) and the EA is a data register
(``d``).  Parsing those names gives the JavaScript decoder a table that
mirrors Musashi exactly instead of guessing from the raw opcode bits.

The output is a compact array with one entry per opcode; each entry is
``[operation, size, form, ea]`` or ``null`` for illegal instructions.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MUSASHI = os.path.join(ROOT, os.pardir, "m68k")
JUMP_TABLE = os.path.join(MUSASHI, "m68ki_instruction_jump_table.h")
OUTPUT = os.path.join(ROOT, "src", "handlers.json")

HANDLER_RE = re.compile(
    r"^m68k_op_(?P<op>\w+?)"
    r"(?:_(?P<size>\d+))?"
    r"(?:_(?P<form>er|re|ea))?"
    r"(?:_(?P<ea>d|a|ai|pi|pd|di|ix|aw|al|pcdi|pcix|i|rr|mm|dn|an|p|r|s|frs|tos|toc|fru|tou))?$"
)

# A few operations carry an infix that is not a size or an EA, e.g.
# "move_16_frs" (from SR) or "move_32_tou" (to USP).  They are listed
# explicitly so that the generic pattern below does not mis-split them.
SPECIAL_OPS = {
    "move": {
        "frs": ["move", "frs"],
        "tos": ["move", "tos"],
        "toc": ["move", "toc"],
        "fru": ["move", "fru"],
        "tou": ["move", "tou"],
    },
}

# Operations whose size is implied by the opcode rather than by the name.
SIZELESS = {"moveq", "bra", "bsr", "nop", "reset", "stop", "rte", "rtr", "rts",
             "link", "unlk", "trap", "trapv", "swap", "ext", "movep", "movem",
             "dbcc", "dbf", "dbcs", "dbcc", "dbhi", "dbls", "dbcc", "dbne",
             "dbge", "dblt", "dbgt", "dble", "dbpl", "dbmi", "dbvs", "dbvc",
             "dbt", "dbeq"}

# Operations that carry an immediate operand.
IMMEDIATE = {"ori", "andi", "eori", "subi", "addi", "cmpi"}


EA_TOKENS = {
    "d", "a", "ai", "pi", "pd", "di", "ix", "aw", "al", "pcdi", "pcix", "i",
    "rr", "mm", "dn", "an", "p", "r", "s",
    "frs", "tos", "toc", "fru", "tou",
    # Special A7 variants used by the 68000 for byte sized stack accesses.
    "pi7", "pd7", "ax7", "ay7", "axy7", "a7",
    # Combined operands used by EXG and the ABCD/SBCD/ADDX/SUBX family.
    "dd", "da", "aa",
}
FORM_TOKENS = {"er", "re", "ea"}

# Operations whose name ends with a token that must not be mistaken for an
# EA or a size (e.g. "moveq", "bchg", "negx", "dbcc", "subx", "addx").
KNOWN_OPS = {
    "abcd", "add", "adda", "addi", "addq", "addx", "and", "andi", "asl", "asr",
    "bcc", "bchg", "bclr", "bset", "btst", "bra", "bsr", "bcs", "beq", "bge",
    "bgt", "bhi", "ble", "bls", "blt", "bmi", "bne", "bpl", "bvc", "bvs",
    "chk", "clr", "cmp", "cmpa", "cmpi", "cmpm", "dbcc", "dbcs", "dbeq", "dbf",
    "dbge", "dbgt", "dbhi", "dble", "dbls", "dblt", "dbmi", "dbne", "dbpl",
    "dbt", "dbvc", "dbvs", "divs", "divu", "eor", "eori", "exg", "ext", "jmp",
    "jsr", "lea", "link", "lsl", "lsr", "move", "movea", "movem", "movep",
    "moveq", "muls", "mulu", "nbcd", "neg", "negx", "nop", "not", "or", "ori",
    "pea", "reset", "rol", "ror", "roxl", "roxr", "rte", "rtr", "rts", "sbcd",
    "scc", "scs", "seq", "sf", "sge", "sgt", "shi", "sle", "sls", "slt", "smi",
    "sne", "spl", "st", "stop", "sub", "suba", "subi", "subq", "subx", "svc",
    "svs", "swap", "tas", "trap", "trapv", "tst", "unlk",
}


def parse_handler(name):
    """Split a Musashi handler name into its semantic components."""
    if name == "m68k_op_illegal":
        return None

    tokens = name[len("m68k_op_"):].split("_")

    # Find the longest known operation name at the front.
    op = None
    rest = tokens
    for length in range(len(tokens), 0, -1):
        candidate = "_".join(tokens[:length])
        if candidate in KNOWN_OPS:
            op = candidate
            rest = tokens[length:]
            break

    if op is None:
        # The 1010 / 1111 line-A / line-F emulator traps are not regular
        # instructions.
        if tokens[0] in ("1", "1010", "1111"):
            return None
        raise ValueError("cannot parse handler name %r" % name)

    size = 0
    form = ""
    ea = ""
    ea2 = ""

    index = 0
    if index < len(rest) and rest[index].isdigit():
        size = int(rest[index])
        index += 1
    if index < len(rest) and rest[index] in FORM_TOKENS:
        form = rest[index]
        index += 1
    if index < len(rest) and rest[index] in EA_TOKENS:
        ea = rest[index]
        index += 1
    # A few handlers name two operands, e.g. "btst_32_r_d" (register bit
    # number plus a data register EA) or "abcd_8_mm_ax7".
    if index < len(rest) and rest[index] in EA_TOKENS:
        ea2 = rest[index]
        index += 1

    if index != len(rest):
        raise ValueError("cannot parse handler name %r (leftover %r)" % (name, rest[index:]))

    if ea2:
        return [op, size, form, ea + "," + ea2]

    return [op, size, form, ea]


def main():
    with open(JUMP_TABLE, "r", encoding="utf-8", errors="replace") as handle:
        source = handle.read()

    body = source[source.index("{") + 1:source.rindex("}")]
    names = [token.strip() for token in body.replace("\n", " ").split(",") if token.strip()]
    if len(names) != 65536:
        raise SystemExit("expected 65536 handlers, found %d" % len(names))

    handlers = [parse_handler(name) for name in names]

    with open(OUTPUT, "w", encoding="utf-8") as handle:
        json.dump(handlers, handle, separators=(",", ":"))
        handle.write("\n")

    print("wrote %s (%d opcodes)" % (OUTPUT, len(handlers)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
