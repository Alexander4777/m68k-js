#!/usr/bin/env python3
"""
m68k-js-testkit :: test runner
==============================

Runs the differential test suite:

  1. builds (if needed) the C reference harness;
  2. regenerates the test ROMs and validates their encodings;
  3. runs the C harness for every test case and stores the JSON dumps;
  4. runs the JavaScript implementation (if it is available) and stores
     its JSON dumps;
  5. compares both sets of dumps.

The JavaScript side is optional: as long as ../m68k-js does not exist
(or does not expose the expected entry point) the runner only produces
the *reference* dumps, which are the golden files the JS port has to
reproduce.

Usage:
    tools/run_tests.py [options]

Options:
    --js PATH        path to the JS implementation (default ../m68k-js)
    --js-command CMD command that runs the JS harness (may contain {dump}
                     which is replaced by the output path)
    --no-js          only produce the reference dumps
    --filter NAME    only run the cases whose name contains NAME
    --out DIR        where the dumps are written (default out/dumps)
    --update         overwrite the golden reference dumps
    --keep           keep the dumps of a failing run
    --verbose        print the details of every case
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TESTKIT = os.path.dirname(HERE)

sys.path.insert(0, HERE)
from make_cases import CASES  # noqa: E402


def log(msg, verbose=False):
    if verbose:
        print(msg)


def run(cmd, verbose=False):
    if verbose:
        print("  $ " + " ".join(cmd))
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return p.returncode, p.stdout.decode("utf-8", "replace"), \
        p.stderr.decode("utf-8", "replace")


def harness_args(case, rom_path, dump_path):
    args = [
        os.path.join(TESTKIT, "out", "c-harness"),
        "--rom", rom_path,
        "--cycles", str(case["cycles"]),
        "--step-cycles", str(case["step_cycles"]),
        "--load-addr", hex(case.get("load_addr", 0)),
        "--out", dump_path,
        "--quiet",
    ]
    for irq in case.get("irq", []):
        args += ["--irq", irq]
    for rng in case.get("dump_mem", []):
        args += ["--dump-mem", rng]
    return args


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--js", default=os.path.join(TESTKIT, "..", "m68k-js"))
    ap.add_argument("--js-command", default=None)
    ap.add_argument("--no-js", action="store_true")
    ap.add_argument("--filter", default=None)
    ap.add_argument("--out", default=os.path.join(TESTKIT, "out", "dumps"))
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    outdir = args.out
    os.makedirs(outdir, exist_ok=True)
    golden_dir = os.path.join(TESTKIT, "tests", "golden")
    os.makedirs(golden_dir, exist_ok=True)

    # ------------------------------------------------------------------
    #  1. build the C harness
    # ------------------------------------------------------------------
    harness = os.path.join(TESTKIT, "out", "c-harness")
    if not os.path.exists(harness):
        print("run_tests: building the C reference harness ...")
        rc, out, err = run(["make", "-C", TESTKIT])
        if rc != 0:
            print(err)
            return 2

    # ------------------------------------------------------------------
    #  2. regenerate + validate the ROMs
    # ------------------------------------------------------------------
    print("run_tests: generating the test ROMs ...")
    rc, out, err = run([sys.executable, os.path.join(HERE, "make_roms.py")])
    if rc != 0:
        print(out + err)
        return 2

    print("run_tests: validating the ROM encodings ...")
    rc, out, err = run([sys.executable, os.path.join(HERE,
                                                    "validate_opcodes.py")])
    if out.strip():
        print(out.strip())
    if err.strip():
        print(err.strip())
    if rc != 0:
        print("run_tests: the ROM encodings are broken")
        return 2

    # ------------------------------------------------------------------
    #  3. locate the JS implementation
    # ------------------------------------------------------------------
    js_cmd = None
    if not args.no_js:
        if args.js_command:
            js_cmd = args.js_command
        else:
            # The JS port is expected to expose a harness with the same
            # command line interface as the C one.  A few conventional
            # locations are probed.
            candidates = [
                os.path.join(args.js, "tools", "js-harness.js"),
                os.path.join(args.js, "js-harness.js"),
                os.path.join(args.js, "tools", "harness.js"),
                os.path.join(args.js, "harness.js"),
                os.path.join(args.js, "bin", "js-harness.js"),
            ]
            for c in candidates:
                if os.path.isfile(c):
                    js_cmd = "node " + c
                    break

    if js_cmd:
        print("run_tests: JavaScript harness: %s" % js_cmd)
    else:
        print("run_tests: no JavaScript harness found - reference dumps only")

    # ------------------------------------------------------------------
    #  4. run the cases
    # ------------------------------------------------------------------
    cases = CASES
    if args.filter:
        cases = [c for c in cases if args.filter in c["name"]]

    failures = []
    for case in cases:
        name = case["name"]
        rom = os.path.join(TESTKIT, "tests", "roms", case["rom"])
        c_dump = os.path.join(outdir, name + ".c.json")
        js_dump = os.path.join(outdir, name + ".js.json")
        golden = os.path.join(golden_dir, name + ".json")

        cmd = harness_args(case, rom, c_dump)
        rc, out, err = run(cmd, args.verbose)
        if rc != 0:
            print("  %-18s C harness FAILED: %s" % (name, err.strip()))
            failures.append(name)
            continue
        log("  %-18s C  -> %s" % (name, c_dump), args.verbose)

        # The golden file is the C dump of the first (reference) run.
        if args.update or not os.path.exists(golden):
            shutil.copyfile(c_dump, golden)

        if not js_cmd:
            continue

        jcmd = js_cmd.replace("{dump}", js_dump)
        jcmd = jcmd.replace("{rom}", rom)
        jcmd = jcmd.replace("{cycles}", str(case["cycles"]))
        jcmd = jcmd.replace("{step_cycles}", str(case["step_cycles"]))
        jcmd = jcmd.replace("{load_addr}", hex(case.get("load_addr", 0)))
        rc, out, err = run(jcmd.split(), args.verbose)
        if rc != 0:
            print("  %-18s JS harness FAILED: %s" % (name, err.strip()))
            failures.append(name)
            continue

        rc, out, err = run([sys.executable,
                             os.path.join(HERE, "compare_dumps.py"),
                             c_dump, js_dump])
        if rc != 0:
            print("  %-18s MISMATCH" % name)
            print(out.strip())
            failures.append(name)
        else:
            log("  %-18s OK" % name, args.verbose)

    # ------------------------------------------------------------------
    #  5. verdict
    # ------------------------------------------------------------------
    print("")
    if failures:
        print("run_tests: FAILED (%d): %s" % (len(failures),
                                              ", ".join(failures)))
        return 1

    print("run_tests: all %d case(s) passed" % len(cases))
    print("run_tests: reference dumps in %s" % golden_dir)
    if not js_cmd:
        print("run_tests: (no JS harness - the dumps are the golden files "
              "the JS port must reproduce)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
