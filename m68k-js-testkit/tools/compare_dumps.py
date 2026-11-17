#!/usr/bin/env python3
"""
m68k-js-testkit :: differential dump comparator
================================================

Compares two JSON dumps produced by the C reference harness and by the
JavaScript implementation and reports the differences.

The comparison is *structural*: every field of the state vector is
compared individually so that a mismatch report tells exactly which
register or flag diverged.

Usage:
    tools/compare_dumps.py <reference.json> <candidate.json> [options]

Options:
    --quiet           only print the verdict
    --max-diffs N     stop after N differences (default 20)
    --ignore FIELD    ignore a field (repeatable), e.g. --ignore pref_data
    --verbose         print the full state vector of both dumps

Exit code:
    0  the dumps are equivalent
    1  the dumps differ
    2  an error occurred (missing file, invalid JSON, ...)
"""

import argparse
import json
import sys

# Fields that are compared inside a state object.
REG_FIELDS = ["pc", "sr", "ir", "sp", "usp", "isp", "pref_addr", "pref_data"]
FLAG_FIELDS = ["t", "s", "i", "x", "n", "z", "v", "c"]


def norm_hex(value):
    """Normalise a value to an integer when it looks like a hex string."""
    if isinstance(value, str):
        try:
            return int(value, 16) if value.lower().startswith("0x") else int(value)
        except ValueError:
            return value
    return value


def compare_state(a, b, path, diffs, max_diffs):
    """Compare two state dictionaries, appending the differences."""
    def add(msg):
        diffs.append("%s: %s" % (path, msg))
        return len(diffs) < max_diffs

    for f in REG_FIELDS:
        if f in a and f in b:
            va, vb = norm_hex(a[f]), norm_hex(b[f])
            if va != vb:
                if not add("%s: reference=0x%08X candidate=0x%08X" %
                           (f, va if isinstance(va, int) else 0,
                            vb if isinstance(vb, int) else 0)):
                    return False

    for f in FLAG_FIELDS:
        fa, fb = a.get("flags", {}), b.get("flags", {})
        if f in fa and f in fb:
            if fa[f] != fb[f]:
                if not add("flags.%s: reference=%s candidate=%s" %
                           (f, fa[f], fb[f])):
                    return False

    for i in range(8):
        da = a.get("d", [])
        db = b.get("d", [])
        if i < len(da) and i < len(db):
            va, vb = norm_hex(da[i]), norm_hex(db[i])
            if va != vb:
                if not add("d%d: reference=0x%08X candidate=0x%08X" %
                           (i, va, vb)):
                    return False

    for i in range(8):
        da = a.get("a", [])
        db = b.get("a", [])
        if i < len(da) and i < len(db):
            va, vb = norm_hex(da[i]), norm_hex(db[i])
            if va != vb:
                if not add("a%d: reference=0x%08X candidate=0x%08X" %
                           (i, va, vb)):
                    return False

    if "cycles" in a and "cycles" in b and a["cycles"] != b["cycles"]:
        if not add("cycles: reference=%s candidate=%s" %
                   (a["cycles"], b["cycles"])):
            return False

    return True


def compare(a, b, max_diffs, ignore):
    diffs = []

    sa = a.get("states", [])
    sb = b.get("states", [])

    if len(sa) != len(sb):
        diffs.append("state count: reference=%d candidate=%d" %
                     (len(sa), len(sb)))

    for i in range(min(len(sa), len(sb))):
        if not compare_state(sa[i], sb[i], "state[%d]" % i, diffs, max_diffs):
            break

    # final state
    if "final" in a and "final" in b:
        compare_state(a["final"], b["final"], "final", diffs, max_diffs)

    # final register block
    ra, rb = a.get("final_regs", {}), b.get("final_regs", {})
    for k in sorted(set(ra) | set(rb)):
        if k in ignore:
            continue
        va, vb = norm_hex(ra.get(k)), norm_hex(rb.get(k))
        if va != vb:
            diffs.append("final_regs.%s: reference=0x%X candidate=0x%X" %
                         (k, va if isinstance(va, int) else 0,
                          vb if isinstance(vb, int) else 0))

    # memory dumps
    ma = a.get("memory", [])
    mb = b.get("memory", [])
    if len(ma) != len(mb):
        diffs.append("memory range count: reference=%d candidate=%d" %
                     (len(ma), len(mb)))
    for i in range(min(len(ma), len(mb))):
        if ma[i].get("addr") != mb[i].get("addr"):
            diffs.append("memory[%d].addr: reference=%s candidate=%s" %
                         (i, ma[i].get("addr"), mb[i].get("addr")))
            continue
        ba, bb = ma[i].get("bytes", []), mb[i].get("bytes", [])
        if len(ba) != len(bb):
            diffs.append("memory[%d] length: reference=%d candidate=%d" %
                         (i, len(ba), len(bb)))
            continue
        for off in range(len(ba)):
            if ba[off] != bb[off]:
                diffs.append("memory[%s+%04X]: reference=0x%02X candidate=0x%02X"
                             % (ma[i].get("addr"), off, ba[off], bb[off]))
                if len(diffs) >= max_diffs:
                    break
        if len(diffs) >= max_diffs:
            break

    return diffs


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("reference")
    ap.add_argument("candidate")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--max-diffs", type=int, default=20)
    ap.add_argument("--ignore", action="append", default=[])
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    try:
        with open(args.reference) as f:
            a = json.load(f)
    except (IOError, ValueError) as e:
        print("compare_dumps: cannot read '%s': %s" % (args.reference, e))
        return 2

    try:
        with open(args.candidate) as f:
            b = json.load(f)
    except (IOError, ValueError) as e:
        print("compare_dumps: cannot read '%s': %s" % (args.candidate, e))
        return 2

    if args.verbose:
        print("reference final: %s" % json.dumps(a.get("final", {}), indent=2))
        print("candidate final: %s" % json.dumps(b.get("final", {}), indent=2))

    diffs = compare(a, b, args.max_diffs, set(args.ignore))

    if not diffs:
        if not args.quiet:
            print("compare_dumps: OK - the dumps are equivalent")
        return 0

    print("compare_dumps: FAIL - %d difference(s)" % len(diffs))
    for d in diffs:
        print("  " + d)
    return 1


if __name__ == "__main__":
    sys.exit(main())
