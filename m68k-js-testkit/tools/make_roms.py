#!/usr/bin/env python3
"""
m68k-js-testkit :: ROM generator
===============================

Builds the tiny Motorola 68000 test programs used by the differential
harness.  Everything is emitted by hand-assembled machine code (no
assembler dependency), so the ROMs are byte-exact and reproducible on any
machine.

Each ROM is a flat 16 bit big-endian image:

    offset 0x00 : initial supervisor stack pointer (long)
    offset 0x04 : initial program counter     (long)
    offset 0x08 : code / data

The programs are designed to exercise the instruction families that are
easiest to get wrong in a JS re-implementation: arithmetic flags, shifts,
BCD, div/mul, moves, bit operations, branches, exceptions and traps.

Usage:
    scripts/make-roms.sh          # wrapper used by `make roms`
    tools/make_roms.py [outdir]
"""

import os
import struct
import sys

# --------------------------------------------------------------------------
#  Minimal Motorola 68000 assembler
# --------------------------------------------------------------------------

REGS_D = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"]
REGS_A = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"]
SR = 0x2700


class Asm:
    """Tiny 68k assembler: only what the test ROMs need."""

    def __init__(self, org=0x000008, stack=0x00FF0000):
        self.org = org
        self.stack = stack
        self.buf = bytearray()
        self.labels = {}
        self.fixups = []          # (offset, size, label, kind)
        self.vectors = {}         # exception vector number -> label
        self.pc = org

    # -- raw emission -------------------------------------------------
    def emit(self, *data):
        for d in data:
            self.buf.append(d & 0xFF)
        self.pc += len(data)
        return self

    def w(self, v):
        self.emit((v >> 8) & 0xFF, v & 0xFF)
        return self

    def l(self, v):
        self.emit((v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF)
        return self

    def label(self, name):
        if name in self.labels:
            raise ValueError("duplicate label %s" % name)
        self.labels[name] = self.pc
        return self

    # -- helpers ------------------------------------------------------
    @staticmethod
    def _reg(name):
        name = name.lower()
        if name in REGS_D:
            return REGS_D.index(name)
        if name in REGS_A:
            return 8 + REGS_A.index(name)
        raise ValueError("bad register %r" % name)

    @staticmethod
    def _cond(name):
        conds = {
            "t": 0, "f": 1, "hi": 2, "ls": 3, "cc": 4, "cs": 5, "ne": 6,
            "eq": 7, "vc": 8, "vs": 9, "pl": 10, "mi": 11, "ge": 12,
            "lt": 13, "gt": 14, "le": 15,
        }
        return conds[name.lower()]

    # -- instructions -------------------------------------------------
    def nop(self):
        return self.w(0x4E71)

    def rts(self):
        return self.w(0x4E75)

    def moveq(self, value, reg):
        """MOVEQ #imm,Dn.

        NOTE: Musashi decodes MOVEQ as
            0x7000 | (Dn << 9) | (imm & 0xFF)
        with bit 8 of the opcode forced to 0 (opcode mask 0xf100), so
        the immediate must fit in -128..127.  The register is *not* in
        bits 2-0 as on a real 68000 - it is in bits 11-9.
        """
        r = self._reg(reg)
        assert 0 <= r <= 7
        v = value & 0xFF
        assert not (v & 0x100)
        return self.w(0x7000 | ((r & 7) << 9) | v)

    @staticmethod
    def _move(size, dmode, dreg, smode, sreg):
        """MOVE encoding: 00 | size | dstmode dstreg | 001 | srcmode srcreg"""
        return (size << 12) | (dmode << 9) | (dreg << 6) | 0b001 | \
               (smode << 3) | sreg

    # MOVE.<size> #imm,(xxx).L / (xxx).W
    #   dst mode 7 = absolute, reg 1 = long / reg 0 = word
    #   src mode 7 = immediate
    def move_l_imm_to_abs(self, value, addr):
        """MOVE.L #imm,(xxx).L"""
        self.w(0x23FC)
        self.l(value)
        self.l(addr)
        return self

    def move_w_imm_to_abs(self, value, addr):
        """MOVE.W #imm,(xxx).W"""
        self.w(0x31FC)
        self.w(value)
        self.l(addr)
        return self

    def move_b_imm_to_abs(self, value, addr):
        """MOVE.B #imm,(xxx).W"""
        self.w(0x11FC)
        self.emit(value & 0xFF)
        self.l(addr)
        return self

    def move_l_abs_to_reg(self, addr, reg):
        """MOVE.L (xxx).L,Dn"""
        r = self._reg(reg)
        self.w(0x2039 | ((r & 7) << 9))
        self.l(addr)
        return self

    def move_w_abs_to_reg(self, addr, reg):
        """MOVE.W (xxx).W,Dn"""
        r = self._reg(reg)
        self.w(0x3039 | ((r & 7) << 9))
        self.l(addr)
        return self

    def move_l_reg_to_abs(self, reg, addr):
        """MOVE.L Dn,(xxx).L"""
        r = self._reg(reg)
        self.w(0x23C0 | (r & 7))
        self.l(addr)
        return self

    def move_w_reg_to_abs(self, reg, addr):
        """MOVE.W Dn,(xxx).W"""
        r = self._reg(reg)
        self.w(0x33C0 | (r & 7))
        self.l(addr)
        return self

    def move_b_reg_to_abs(self, reg, addr):
        """MOVE.B Dn,(xxx).W"""
        r = self._reg(reg)
        self.w(0x13C0 | (r & 7))
        self.l(addr)
        return self

    def addq(self, size, imm, reg):
        """ADDQ #imm,<reg>  size: 'b'|'w'|'l'"""
        sz = {"b": 0, "w": 1, "l": 2}[size]
        r = self._reg(reg)
        op = (0x5000 | (sz << 6) | ((imm & 7) << 9) | (r & 7))
        return self.w(op)

    # Immediate ALU operations.
    #
    # Encoding: 0000 ooo0 ss ee mmmrrr
    #   ooo  : operation (000 = ORI/ANDI/SUBI/EORI, 001 = ADDI/CMPI)
    #   ss   : size (00 = byte, 01 = word, 10 = long)
    #   ee   : 11 for the Dn form
    #   mmmrrr : the destination register (bits 2-0).  Bits 11-9 are a
    #            fixed "opreg" field and MUST NOT contain the register
    #            number - Musashi decodes them with the mask 0xfff8.
    def _alu_imm(self, op, size, imm, reg):
        sz = {"b": 0, "w": 1, "l": 2}[size]
        r = self._reg(reg)
        assert r <= 7, "the immediate ALU operations only support Dn"
        opbase = {"ori": 0x0000, "andi": 0x0200, "subi": 0x0400,
                  "eori": 0x0A00, "addi": 0x0600, "cmpi": 0x0C00}[op]
        # bits 8-6 = 000 (data register mode), bits 2-0 = the register
        self.w(opbase | (sz << 6) | (r & 7))
        if sz == 2:
            self.l(imm)
        elif sz == 1:
            self.w(imm)
        else:
            self.emit(imm & 0xFF)
        return self

    def addi(self, size, imm, reg):
        """ADDI #imm,Dn"""
        return self._alu_imm("addi", size, imm, reg)

    def subi(self, size, imm, reg):
        """SUBI #imm,Dn"""
        return self._alu_imm("subi", size, imm, reg)

    def cmpi(self, size, imm, reg):
        """CMPI #imm,Dn"""
        return self._alu_imm("cmpi", size, imm, reg)

    def andi(self, size, imm, reg):
        """ANDI #imm,Dn"""
        return self._alu_imm("andi", size, imm, reg)

    def ori(self, size, imm, reg):
        """ORI #imm,Dn"""
        return self._alu_imm("ori", size, imm, reg)

    def eori(self, size, imm, reg):
        """EORI #imm,Dn"""
        return self._alu_imm("eori", size, imm, reg)

    def add(self, size, src_reg, dst_reg):
        sz = {"b": 0, "w": 1, "l": 2}[size]
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        op = (0xD000 | (sz << 6) | (s << 9) | d)
        return self.w(op)

    def sub(self, size, src_reg, dst_reg):
        sz = {"b": 0, "w": 1, "l": 2}[size]
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        op = (0x9000 | (sz << 6) | (s << 9) | d)
        return self.w(op)

    def cmp(self, size, src_reg, dst_reg):
        sz = {"b": 0, "w": 1, "l": 2}[size]
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        op = (0xB000 | (sz << 6) | (s << 9) | d)
        return self.w(op)

    def and_(self, size, src_reg, dst_reg):
        sz = {"b": 0, "w": 1, "l": 2}[size]
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        op = (0xC000 | (sz << 6) | (s << 9) | d)
        return self.w(op)

    def or_(self, size, src_reg, dst_reg):
        sz = {"b": 0, "w": 1, "l": 2}[size]
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        op = (0x8000 | (sz << 6) | (s << 9) | d)
        return self.w(op)

    def eor(self, size, src_reg, dst_reg):
        sz = {"b": 0, "w": 1, "l": 2}[size]
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        op = (0xB400 | (sz << 6) | (s << 9) | d)
        return self.w(op)

    def adda(self, size, src_reg, dst_reg):
        """ADDA.<sz> src,dst

        Encoding: 1101 xxx1 11 mmmrrr where bit 8 selects the size
        (0 = word, 1 = long) and bit 3 selects the *destination* mode
        (0 = Dn, 1 = An).  The source register is in bits 11-9 and the
        destination register in bits 2-0.
        """
        sz = {"w": 0, "l": 1}[size]
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        dmode = 1 if d >= 8 else 0
        return self.w(0xD0C0 | (sz << 8) | ((s & 7) << 9) | (dmode << 3) | (d & 7))

    def suba(self, size, src_reg, dst_reg):
        """SUBA.<sz> src,dst (see adda() for the encoding)"""
        sz = {"w": 0, "l": 1}[size]
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        dmode = 1 if d >= 8 else 0
        return self.w(0x90C0 | (sz << 8) | ((s & 7) << 9) | (dmode << 3) | (d & 7))

    def cmpa(self, size, src_reg, dst_reg):
        """CMPA.<sz> src,dst (see adda() for the encoding)"""
        sz = {"w": 0, "l": 1}[size]
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        dmode = 1 if d >= 8 else 0
        return self.w(0xB0C0 | (sz << 8) | ((s & 7) << 9) | (dmode << 3) | (d & 7))

    # -- shifts / rotates ---------------------------------------------
    # Musashi layout (differs from the classic 68000 manual):
    #
    #   1110 | size(2) | count(3) | dir(1) | op(2) | reg(3)
    #     size  : bits 13-12 -> 00 = byte, 01 = word, 10 = long
    #     count : bits 11-9  -> 1..8 (or the register number for the
    #                          "shift by register" form, see below)
    #     dir   : bit 8      -> 0 = right, 1 = left
    #     op    : bits 4-3   -> 00 = arithmetic, 01 = logical,
    #                          10 = rotate through extend, 11 = rotate
    #     reg   : bits 2-0   -> data register
    #
    # The "shift by register" form is selected with bit 5 and puts the
    # *source* register in bits 11-9 and the data register in bits 2-0.
    def _shift(self, op, left, count, reg, size):
        sz = {"b": 0, "w": 1, "l": 2}[size]
        r = self._reg(reg)
        o = (0xE000 | (sz << 6) | ((count & 7) << 9) |
             ((1 if left else 0) << 8) | (op << 3) | (r & 7))
        return self.w(o)

    def asl(self, size, count, reg):
        return self._shift(0, True, count, reg, size)

    def asr(self, size, count, reg):
        return self._shift(0, False, count, reg, size)

    def lsl(self, size, count, reg):
        return self._shift(1, True, count, reg, size)

    def lsr(self, size, count, reg):
        return self._shift(1, False, count, reg, size)

    def roxl(self, size, count, reg):
        return self._shift(2, True, count, reg, size)

    def roxr(self, size, count, reg):
        return self._shift(2, False, count, reg, size)

    def rol(self, size, count, reg):
        return self._shift(3, True, count, reg, size)

    def ror(self, size, count, reg):
        return self._shift(3, False, count, reg, size)

    def lsl_reg(self, size, srcreg, reg):
        """LSL.<sz> Dx,Dy  (count taken from Dx)"""
        sz = {"b": 0, "w": 1, "l": 2}[size]
        r = self._reg(reg)
        s = self._reg(srcreg)
        return self.w(0xE000 | (sz << 6) | (1 << 5) | (1 << 8) | (1 << 3) |
                      ((s & 7) << 9) | (r & 7))

    def asr_reg(self, size, srcreg, reg):
        """ASR.<sz> Dx,Dy  (count taken from Dx)"""
        sz = {"b": 0, "w": 1, "l": 2}[size]
        r = self._reg(reg)
        s = self._reg(srcreg)
        return self.w(0xE000 | (sz << 6) | (1 << 5) | (0 << 8) | (0 << 3) |
                      ((s & 7) << 9) | (r & 7))

    def swap(self, reg):
        """SWAP Dn (opcode 0x4840 | Dn, register in bits 2-0)"""
        r = self._reg(reg)
        return self.w(0x4840 | (r & 7))

    def neg(self, size, reg):
        """NEG.<sz> Dn (opcode 0x4400 | (sz << 6) | (Dn << 9))"""
        sz = {"b": 0, "w": 1, "l": 2}[size]
        r = self._reg(reg)
        return self.w(0x4400 | ((r & 7) << 9) | (sz << 6))

    def not_(self, size, reg):
        """NOT.<sz> Dn (opcode 0x4600 | (sz << 6) | (Dn << 9))"""
        sz = {"b": 0, "w": 1, "l": 2}[size]
        r = self._reg(reg)
        return self.w(0x4600 | ((r & 7) << 9) | (sz << 6))

    def clr(self, size, reg):
        """CLR.<sz> Dn (opcode 0x4200 | (sz << 6) | (Dn << 9))"""
        sz = {"b": 0, "w": 1, "l": 2}[size]
        r = self._reg(reg)
        return self.w(0x4200 | ((r & 7) << 9) | (sz << 6))

    def tst(self, size, reg):
        """TST.<sz> Dn (opcode 0x4A00 | (sz << 6) | (Dn << 9))"""
        sz = {"b": 0, "w": 1, "l": 2}[size]
        r = self._reg(reg)
        return self.w(0x4A00 | ((r & 7) << 9) | (sz << 6))

    def ext(self, size, reg):
        """EXT.W Dn (0x4880) / EXT.L Dn (0x48C0), register in bits 11-9"""
        r = self._reg(reg)
        if size == "w":
            return self.w(0x4880 | ((r & 7) << 9))
        return self.w(0x48C0 | ((r & 7) << 9))

    def abcd(self, src, dst):
        s = self._reg(src)
        d = self._reg(dst)
        return self.w(0xC100 | (s << 9) | d)

    def sbcd(self, src, dst):
        s = self._reg(src)
        d = self._reg(dst)
        return self.w(0x8100 | (s << 9) | d)

    def nbcd(self, reg):
        r = self._reg(reg)
        return self.w(0x4800 | r)

    def mulu(self, src, dst):
        s = self._reg(src)
        d = self._reg(dst)
        return self.w(0xC0C0 | (s << 9) | d)

    def muls(self, src, dst):
        s = self._reg(src)
        d = self._reg(dst)
        return self.w(0xC1C0 | (s << 9) | d)

    def divu(self, src, dst):
        s = self._reg(src)
        d = self._reg(dst)
        return self.w(0x80C0 | (s << 9) | d)

    def divs(self, src, dst):
        s = self._reg(src)
        d = self._reg(dst)
        return self.w(0x81C0 | (s << 9) | d)

    # Static bit operations: BSET/BCLR/BCHG/BTST #n,<Dn>
    # The bit number is encoded in an extension word that follows the
    # opcode (Musashi reads it with OPER_I_8()).
    def btst(self, bit, reg):
        r = self._reg(reg)
        self.w(0x0800 | (r & 7))
        self.w(bit & 0xFF)
        return self

    def bset(self, bit, reg):
        r = self._reg(reg)
        self.w(0x08C0 | (r & 7))
        self.w(bit & 0xFF)
        return self

    def bclr(self, bit, reg):
        r = self._reg(reg)
        self.w(0x0880 | (r & 7))
        self.w(bit & 0xFF)
        return self

    def bchg(self, bit, reg):
        r = self._reg(reg)
        self.w(0x0840 | (r & 7))
        self.w(bit & 0xFF)
        return self

    def lea(self, addr, reg):
        r = self._reg(reg)
        self.w(0x41F9 | (r << 9))
        self._abs_ref(addr)
        return self

    def pea(self, addr):
        self.w(0x4879)
        self._abs_ref(addr)
        return self

    def jsr(self, addr):
        self.w(0x4EB9)
        self._abs_ref(addr)
        return self

    def jmp(self, addr):
        self.w(0x4EF9)
        self._abs_ref(addr)
        return self

    def _abs_ref(self, value):
        """Emit an absolute long address; resolve a label if needed."""
        if isinstance(value, str):
            self.fixups.append((len(self.buf), 4, value, "abs"))
            self.l(0)
        else:
            self.l(value)
        return self

    def trap(self, vector):
        return self.w(0x4E40 | (vector & 0xF))

    def illegal(self):
        return self.w(0x4AFC)

    def stop(self, sr):
        self.w(0x4E72)
        self.w(sr)
        return self

    def rte(self):
        return self.w(0x4E73)

    def nop_pending(self):
        return self

    def bra(self, label):
        """BRA.L (16 bit displacement)"""
        self.w(0x6000)
        self.fixups.append((len(self.buf), 2, label, "w"))
        self.emit(0, 0)
        return self

    def bsr(self, label):
        """BSR.L (16 bit displacement)"""
        self.w(0x6100)
        self.fixups.append((len(self.buf), 2, label, "w"))
        self.emit(0, 0)
        return self

    def bcc(self, cond, label):
        """Bcc.L (16 bit displacement).

        NOTE: the low byte of the opcode selects the branch size:
        0x00 -> 16 bit displacement, 0xNN (NN != 0) -> 8 bit displacement.
        """
        self.w(0x6000 | (self._cond(cond) << 8))
        self.fixups.append((len(self.buf), 2, label, "w"))
        self.emit(0, 0)
        return self

    def bcc_b(self, cond, label):
        """Bcc.S (8 bit displacement)."""
        self.w(0x6000 | (self._cond(cond) << 8))
        self.fixups.append((len(self.buf), 1, label, "b"))
        self.emit(0)
        return self

    def dbra(self, reg, label):
        """DBRA Dn,<label> (16 bit displacement)"""
        r = self._reg(reg)
        self.w(0x51C8 | r)
        self.fixups.append((len(self.buf), 2, label, "w"))
        self.emit(0, 0)
        return self

    def move_to_sr(self, reg):
        """MOVE Dn,SR  (opcode 0x46C0 | Dn, register in bits 2-0)"""
        r = self._reg(reg)
        return self.w(0x46C0 | (r & 7))

    def move_from_sr(self, reg):
        """MOVE SR,Dn  (opcode 0x40C0 | Dn, register in bits 2-0)"""
        r = self._reg(reg)
        return self.w(0x40C0 | (r & 7))

    def move_to_ccr(self, reg):
        """MOVE Dn,CCR  (opcode 0x44C0 | Dn, register in bits 2-0)"""
        r = self._reg(reg)
        return self.w(0x44C0 | (r & 7))

    def move_from_ccr(self, reg):
        """MOVE CCR,Dn -- NOTE: Musashi treats 0x42C0 as an illegal
        instruction, so this must not be used in the test ROMs."""
        raise NotImplementedError("MOVE from CCR is not implemented by Musashi")

    def andi_sr(self, imm):
        self.w(0x027C)
        self.w(imm)
        return self

    def ori_sr(self, imm):
        self.w(0x007C)
        self.w(imm)
        return self

    def eori_sr(self, imm):
        self.w(0x0A7C)
        self.w(imm)
        return self

    def movem_to_mem(self, mask, addr):
        """MOVEM <reglist>,<abs>.l"""
        self.w(0x48F9)
        self.w(mask)
        self.l(addr)
        return self

    def movem_from_mem(self, mask, addr):
        """MOVEM <abs>.l,<reglist>"""
        self.w(0x4CF9)
        self.w(mask)
        self.l(addr)
        return self

    def link(self, reg, disp):
        """LINK An,#disp (opcode 0x4E50 | An, register in bits 2-0)"""
        r = self._reg(reg)
        self.w(0x4E50 | (r & 7))
        self.w(disp & 0xFFFF)
        return self

    def unlk(self, reg):
        """UNLK An (opcode 0x4E58 | An, register in bits 2-0)"""
        r = self._reg(reg)
        return self.w(0x4E58 | (r & 7))

    def move_usp(self, reg):  # MOVE An,USP
        r = self._reg(reg)
        return self.w(0x4E68 | r)

    def movea(self, size, src_reg, dst_reg):
        sz = {"w": 1, "l": 2}[size]
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        return self.w(0x0000 | (sz << 6) | (s << 9) | d)

    def lea_ind(self, src_reg, dst_reg):
        """LEA (An),An -> 0x41F8|src<<9|dst"""
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        return self.w(0x41F8 | (s << 9) | (d & 7))

    def move_ind_post(self, size, src_reg, dst_reg):
        """MOVE (An)+,Dn"""
        sz = {"b": 0, "w": 1, "l": 2}[size]
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        return self.w(0x0018 | (sz << 6) | (s << 9) | (d & 7))

    def move_ind_pre(self, size, src_reg, dst_reg):
        """MOVE -(An),Dn"""
        sz = {"b": 0, "w": 1, "l": 2}[size]
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        return self.w(0x0010 | (sz << 6) | (s << 9) | (d & 7))

    def move_ind_disp(self, size, src_reg, dst_reg, disp):
        """MOVE (d16,An),Dn"""
        sz = {"b": 0, "w": 1, "l": 2}[size]
        s = self._reg(src_reg)
        d = self._reg(dst_reg)
        self.w(0x0010 | (sz << 6) | (s << 9) | (d & 7))
        return self

    # -- finalisation -------------------------------------------------
    def resolve(self):
        """Resolve branch displacements and absolute label references.

        The branch displacement is relative to the address of the
        *extension word* plus 2 (i.e. the address of the instruction
        following the branch).  `off` is the offset of the extension
        word inside the code buffer, whose absolute address is
        self.org + off.
        """
        for off, size, label, kind in self.fixups:
            if label not in self.labels:
                raise ValueError("undefined label %s" % label)
            target = self.labels[label]
            if kind == "abs":
                self.buf[off] = (target >> 24) & 0xFF
                self.buf[off + 1] = (target >> 16) & 0xFF
                self.buf[off + 2] = (target >> 8) & 0xFF
                self.buf[off + 3] = target & 0xFF
                continue
            base = self.org + off + 2
            disp = target - base
            if kind == "b":
                if not (-128 <= disp <= 127):
                    raise ValueError("branch out of range to %s" % label)
                self.buf[off] = disp & 0xFF
            else:
                if not (-32768 <= disp <= 32767):
                    raise ValueError("branch out of range to %s" % label)
                self.buf[off] = (disp >> 8) & 0xFF
                self.buf[off + 1] = disp & 0xFF
        return self

    def image(self):
        self.resolve()
        head = struct.pack(">II", self.stack, self.org)
        return head + bytes(self.buf)

    # -- exception vectors --------------------------------------------
    def set_vector(self, vector, label):
        """Install `label` as the handler of exception `vector`.

        The vector table lives at address 0x0000 (vector n at n*4), which
        overlaps the reset vector area for vectors 0 and 1 only.
        """
        self.vectors[vector] = label
        return self

    def build_image(self):
        """Build the final image, including the exception vector table."""
        self.resolve()

        # The vector table occupies the first 0x400 bytes; the code
        # starts at self.org (>= 0x400 for ROMs that use vectors).
        size = max(self.org, 0x400)
        img = bytearray(size)
        img[0:8] = struct.pack(">II", self.stack, self.org)

        # Exception vectors (n * 4).
        for vec, label in self.vectors.items():
            addr = self.labels[label]
            img[vec * 4:vec * 4 + 4] = struct.pack(">I", addr)

        img[self.org:self.org + len(self.buf)] = self.buf
        return bytes(img)


# --------------------------------------------------------------------------
#  ROM programs
# --------------------------------------------------------------------------

DATA_BASE = 0x000F0000     # scratch data area (absolute long addressing)
STACK_TOP = 0x00FF0000


def rom_minimal():
    """The smallest possible program: write a value and stop."""
    a = Asm(org=0x000008, stack=STACK_TOP)
    a.move_l_imm_to_abs(0xC0DE0000, DATA_BASE)
    a.move_l_imm_to_abs(0x0000002A, DATA_BASE + 4)
    a.stop(SR)
    a.label("end")
    a.bra("end")
    return a.image()


def rom_arith():
    """Arithmetic / flag torture test."""
    a = Asm(org=0x000008, stack=STACK_TOP)

    # D0 = 0x12345678
    a.move_l_imm_to_abs(0x12345678, DATA_BASE)
    a.move_l_abs_to_reg(DATA_BASE, "d0")
    # D1 = 0x00000005
    a.move_l_imm_to_abs(0x00000005, DATA_BASE + 4)
    a.move_l_abs_to_reg(DATA_BASE + 4, "d1")

    a.add("l", "d1", "d0")        # D0 = 0x1234567D
    a.sub("l", "d1", "d0")        # D0 = 0x12345678
    a.addq("l", 3, "d0")          # D0 = 0x1234567B
    a.subi("l", 0x1234567B, "d0")  # D0 = 0
    a.addi("l", 0xFFFFFFFF, "d0")  # D0 = 0xFFFFFFFF  (overflow)
    a.andi("l", 0x0000FFFF, "d0")  # D0 = 0x0000FFFF
    a.ori("l", 0x12340000, "d0")   # D0 = 0x1234FFFF
    a.eori("l", 0xFFFFFFFF, "d0")  # D0 = 0xEDCB0000
    a.not_("l", "d0")
    a.neg("l", "d0")
    a.tst("l", "d0")
    a.clr("l", "d1")
    a.ext("w", "d1")              # byte -> word
    a.ext("l", "d1")              # word -> long

    # word / byte arithmetic
    a.moveq(0x7F, "d2")
    a.addq("w", 1, "d2")          # 0x0080 -> overflow
    a.addq("b", 1, "d2")          # 0x81
    a.addi("b", 0x7F, "d2")       # 0x00 -> carry

    # comparisons
    a.moveq(0x10, "d3")
    a.cmpi("l", 0x10, "d3")       # Z set
    a.cmp("l", "d3", "d2")
    a.cmpa("l", "a0", "a1")

    # store the results
    a.move_l_reg_to_abs("d0", DATA_BASE + 0x10)
    a.move_l_reg_to_abs("d1", DATA_BASE + 0x14)
    a.move_l_reg_to_abs("d2", DATA_BASE + 0x18)
    a.move_l_reg_to_abs("d3", DATA_BASE + 0x1C)

    a.stop(SR)
    a.label("end")
    a.bra("end")
    return a.image()


def rom_shifts():
    """Shift / rotate / swap."""
    a = Asm(org=0x000008, stack=STACK_TOP)

    a.move_l_imm_to_abs(0x80000001, DATA_BASE)
    a.move_l_abs_to_reg(DATA_BASE, "d0")
    a.lsl("l", 1, "d0")
    a.asr("l", 1, "d0")
    a.lsr("l", 1, "d0")
    a.roxl("l", 1, "d0")
    a.rol("l", 1, "d0")
    a.ror("l", 1, "d0")
    a.swap("d0")

    a.move_l_imm_to_abs(0x0000FFFF, DATA_BASE + 4)
    a.move_l_abs_to_reg(DATA_BASE + 4, "d1")
    a.lsl("w", 4, "d1")
    a.asr("w", 2, "d1")
    a.lsr("w", 1, "d1")
    a.roxr("w", 1, "d1")
    a.swap("d1")

    a.move_l_imm_to_abs(0x12345678, DATA_BASE + 8)
    a.move_l_abs_to_reg(DATA_BASE + 8, "d2")
    a.lsl("l", 8, "d2")
    a.asr("l", 8, "d2")
    a.lsr("l", 3, "d2")
    a.roxl("l", 2, "d2")

    a.move_l_imm_to_abs(0x00000081, DATA_BASE + 12)
    a.move_l_abs_to_reg(DATA_BASE + 12, "d3")
    a.asl("b", 1, "d3")
    a.asr("b", 1, "d3")
    a.lsr("b", 1, "d3")
    a.rol("b", 1, "d3")

    # shift by register
    a.moveq(0x04, "d4")
    a.move_l_imm_to_abs(0x0000FFFF, DATA_BASE + 16)
    a.move_l_abs_to_reg(DATA_BASE + 16, "d5")
    a.lsl_reg("l", "d4", "d5")
    a.asr_reg("l", "d4", "d5")

    a.move_l_reg_to_abs("d0", DATA_BASE + 0x10)
    a.move_l_reg_to_abs("d1", DATA_BASE + 0x14)
    a.move_l_reg_to_abs("d2", DATA_BASE + 0x18)
    a.move_l_reg_to_abs("d3", DATA_BASE + 0x1C)
    a.move_l_reg_to_abs("d5", DATA_BASE + 0x20)

    a.stop(SR)
    a.label("end")
    a.bra("end")
    return a.image()


def rom_multdiv():
    """Multiply / divide including signed and overflow cases."""
    a = Asm(org=0x000008, stack=STACK_TOP)

    a.move_l_imm_to_abs(0x00010000, DATA_BASE)
    a.move_l_abs_to_reg(DATA_BASE, "d0")
    a.move_l_imm_to_abs(0x00000010, DATA_BASE + 4)
    a.move_l_abs_to_reg(DATA_BASE + 4, "d1")

    a.mulu("d1", "d0")            # 0x0000_0000_0010_0000 -> overflow
    a.move_l_reg_to_abs("d0", DATA_BASE + 0x10)
    a.move_l_reg_to_abs("d1", DATA_BASE + 0x14)

    a.move_l_imm_to_abs(0x00010000, DATA_BASE + 8)
    a.move_l_abs_to_reg(DATA_BASE + 8, "d2")
    a.move_l_imm_to_abs(0x00000010, DATA_BASE + 12)
    a.move_l_abs_to_reg(DATA_BASE + 12, "d3")
    a.muls("d3", "d2")
    a.move_l_reg_to_abs("d2", DATA_BASE + 0x18)

    a.move_l_imm_to_abs(0x00000064, DATA_BASE + 16)
    a.move_l_abs_to_reg(DATA_BASE + 16, "d4")
    a.move_l_imm_to_abs(0x00000007, DATA_BASE + 20)
    a.move_l_abs_to_reg(DATA_BASE + 20, "d5")
    a.divu("d5", "d4")
    a.move_l_reg_to_abs("d4", DATA_BASE + 0x1C)
    a.move_l_reg_to_abs("d5", DATA_BASE + 0x20)

    a.move_l_imm_to_abs(0xFFFFFF9C, DATA_BASE + 24)   # -100
    a.move_l_abs_to_reg(DATA_BASE + 24, "d6")
    a.move_l_imm_to_abs(0x00000007, DATA_BASE + 28)
    a.move_l_abs_to_reg(DATA_BASE + 28, "d7")
    a.divs("d7", "d6")
    a.move_l_reg_to_abs("d6", DATA_BASE + 0x24)
    a.move_l_reg_to_abs("d7", DATA_BASE + 0x28)

    a.stop(SR)
    a.label("end")
    a.bra("end")
    return a.image()


def rom_bcd():
    """BCD arithmetic (ABCD / SBCD / NBCD)."""
    a = Asm(org=0x000008, stack=STACK_TOP)

    a.move_l_imm_to_abs(0x00000099, DATA_BASE)
    a.move_l_abs_to_reg(DATA_BASE, "d0")
    a.move_l_imm_to_abs(0x00000001, DATA_BASE + 4)
    a.move_l_abs_to_reg(DATA_BASE + 4, "d1")

    a.abcd("d1", "d0")            # 0x99 + 0x01 = 0x00 with carry
    a.move_l_reg_to_abs("d0", DATA_BASE + 0x10)
    a.move_from_sr("d2")
    a.move_l_reg_to_abs("d2", DATA_BASE + 0x14)

    a.move_l_imm_to_abs(0x00000123, DATA_BASE + 8)
    a.move_l_abs_to_reg(DATA_BASE + 8, "d3")
    a.nbcd("d3")                  # 0x23 -> 0x22
    a.move_l_reg_to_abs("d3", DATA_BASE + 0x18)

    a.move_l_imm_to_abs(0x00000050, DATA_BASE + 12)
    a.move_l_abs_to_reg(DATA_BASE + 12, "d4")
    a.move_l_imm_to_abs(0x00000025, DATA_BASE + 16)
    a.move_l_abs_to_reg(DATA_BASE + 16, "d5")
    a.sbcd("d5", "d4")            # 0x50 - 0x25 = 0x25
    a.move_l_reg_to_abs("d4", DATA_BASE + 0x1C)

    a.stop(SR)
    a.label("end")
    a.bra("end")
    return a.image()


def rom_bits():
    """Bit operations (BTST / BSET / BCLR / BCHG)."""
    a = Asm(org=0x000008, stack=STACK_TOP)

    a.move_l_imm_to_abs(0x00000000, DATA_BASE)
    a.move_l_abs_to_reg(DATA_BASE, "d0")

    a.bset(5, "d0")
    a.bset(31, "d0")
    a.bclr(0, "d0")
    a.bchg(7, "d0")
    a.btst(31, "d0")
    a.move_l_reg_to_abs("d0", DATA_BASE + 0x10)

    a.move_l_imm_to_abs(0xFFFFFFFF, DATA_BASE + 4)
    a.move_l_abs_to_reg(DATA_BASE + 4, "d1")
    a.btst(7, "d1")
    a.bclr(7, "d1")
    a.bchg(0, "d1")
    a.move_l_reg_to_abs("d1", DATA_BASE + 0x14)

    a.stop(SR)
    a.label("end")
    a.bra("end")
    return a.image()


def rom_branches():
    """Conditional branches and loops."""
    a = Asm(org=0x000008, stack=STACK_TOP)

    a.moveq(0x00, "d0")
    a.label("loop")
    a.addq("l", 1, "d0")
    a.cmpi("l", 10, "d0")
    a.bcc("lt", "loop")

    a.moveq(0x00, "d1")
    a.label("loop2")
    a.addq("l", 1, "d1")
    a.cmpi("l", 5, "d1")
    a.bcc("ne", "loop2")

    # Bcc with a displacement that is taken and one that is not
    a.moveq(0x55, "d2")
    a.bcc("eq", "skip1")
    a.moveq(0xAA, "d3")
    a.label("skip1")
    a.bcc("ne", "skip2")
    a.moveq(0xBB, "d4")
    a.label("skip2")

    # DBRA
    a.moveq(0x05, "d5")
    a.label("dbloop")
    a.dbra("d5", "dbloop")

    # BSR / RTS
    a.bsr("sub")
    a.move_l_reg_to_abs("d0", DATA_BASE + 0x10)
    a.move_l_reg_to_abs("d1", DATA_BASE + 0x14)
    a.move_l_reg_to_abs("d2", DATA_BASE + 0x18)
    a.move_l_reg_to_abs("d3", DATA_BASE + 0x1C)
    a.move_l_reg_to_abs("d4", DATA_BASE + 0x20)
    a.move_l_reg_to_abs("d5", DATA_BASE + 0x24)

    a.stop(SR)
    a.label("end")
    a.bra("end")

    a.label("sub")
    a.link("a6", 0)
    a.moveq(0x77, "d0")
    a.unlk("a6")
    a.rts()
    return a.image()


def rom_exceptions():
    """TRAP and illegal instruction handling.

    The exception vector table lives at address 0x0000.  The code starts
    at 0x000400 so that it does not overlap the table.
    """
    a = Asm(org=0x000400, stack=STACK_TOP)

    a.moveq(0x11, "d0")
    a.moveq(0x22, "d1")
    a.moveq(0x33, "d2")

    a.trap(0)                     # TRAP #0 -> vector 32
    a.move_l_reg_to_abs("d3", DATA_BASE + 0x10)
    a.stop(SR)

    a.label("end")
    a.bra("end")

    # TRAP #0 handler (vector 32)
    a.label("trap_handler")
    a.move_l_reg_to_abs("d0", DATA_BASE + 0x14)
    a.move_l_reg_to_abs("d1", DATA_BASE + 0x18)
    a.rte()

    # ILLEGAL instruction handler (vector 4)
    a.label("illegal_handler")
    a.move_l_reg_to_abs("d2", DATA_BASE + 0x1C)
    a.rte()

    a.set_vector(32, "trap_handler")
    a.set_vector(4, "illegal_handler")
    return a.build_image()


def rom_loops():
    """A long running loop: useful to compare large cycle counts."""
    a = Asm(org=0x000008, stack=STACK_TOP)

    a.moveq(0x00, "d0")
    a.moveq(0x00, "d1")
    a.label("outer")
    a.moveq(0x00, "d2")
    a.label("inner")
    a.addq("l", 1, "d2")
    a.cmpi("l", 64, "d2")
    a.bcc("lt", "inner")
    a.addq("l", 1, "d1")
    a.cmpi("l", 64, "d1")
    a.bcc("lt", "outer")

    a.move_l_reg_to_abs("d0", DATA_BASE + 0x10)
    a.move_l_reg_to_abs("d1", DATA_BASE + 0x14)
    a.move_l_reg_to_abs("d2", DATA_BASE + 0x18)

    a.stop(SR)
    a.label("end")
    a.bra("end")
    return a.image()


def rom_stack():
    """Stack manipulation: LINK/UNLK, MOVEM, JSR/RTS, PEA."""
    a = Asm(org=0x000008, stack=STACK_TOP)

    a.move_l_imm_to_abs(0x00000000, DATA_BASE + 0x30)
    a.move_l_imm_to_abs(0x11111111, DATA_BASE + 0x34)
    a.move_l_imm_to_abs(0x22222222, DATA_BASE + 0x38)
    a.move_l_imm_to_abs(0x33333333, DATA_BASE + 0x3C)

    # MOVEM d0-d3,(abs).l
    a.moveq(0x01, "d0")
    a.moveq(0x02, "d1")
    a.moveq(0x03, "d2")
    a.moveq(0x04, "d3")
    a.movem_to_mem(0x000F, DATA_BASE + 0x30)

    # MOVEM (abs).l,d0-d3
    a.movem_from_mem(0x000F, DATA_BASE + 0x30)

    # JSR / RTS with LINK
    a.jsr("sub")
    a.move_l_reg_to_abs("d0", DATA_BASE + 0x40)
    a.move_l_reg_to_abs("d1", DATA_BASE + 0x44)
    a.move_l_reg_to_abs("d2", DATA_BASE + 0x48)
    a.move_l_reg_to_abs("d3", DATA_BASE + 0x4C)

    a.stop(SR)
    a.label("end")
    a.bra("end")

    a.label("sub")
    a.link("a6", 0)
    a.moveq(0x09, "d0")
    a.unlk("a6")
    a.rts()
    return a.image()


def rom_supervisor():
    """Supervisor mode: MOVE to/from SR, ANDI/ORI/EORI to SR."""
    a = Asm(org=0x000008, stack=STACK_TOP)

    # Read the SR as it comes out of the reset (supervisor, mask 7).
    a.move_from_sr("d0")
    a.move_l_reg_to_abs("d0", DATA_BASE + 0x10)

    # Clear the interrupt mask (ANDI #$FF00,SR).
    a.andi_sr(0xFF00)
    a.move_from_sr("d1")
    a.move_l_reg_to_abs("d1", DATA_BASE + 0x14)

    # Set the interrupt mask back to 7 (ORI #$0700,SR).
    a.ori_sr(0x0700)
    a.move_from_sr("d2")
    a.move_l_reg_to_abs("d2", DATA_BASE + 0x18)

    # Toggle the trace flag (EORI #$0800,SR) - stays in supervisor mode.
    a.eori_sr(0x0800)
    a.move_from_sr("d3")
    a.move_l_reg_to_abs("d3", DATA_BASE + 0x1C)

    # Toggle the trace flag back.
    a.eori_sr(0x0800)
    a.move_from_sr("d4")
    a.move_l_reg_to_abs("d4", DATA_BASE + 0x20)

    # MOVE #imm,SR sets the whole status register (privileged).
    a.moveq(0x00, "d5")
    a.move_to_sr("d5")
    a.move_from_sr("d6")
    a.move_l_reg_to_abs("d6", DATA_BASE + 0x24)

    a.stop(SR)
    a.label("end")
    a.bra("end")
    return a.image()


ROMS = {
    "minimal": rom_minimal,
    "arith": rom_arith,
    "shifts": rom_shifts,
    "multdiv": rom_multdiv,
    "bcd": rom_bcd,
    "bits": rom_bits,
    "branches": rom_branches,
    "exceptions": rom_exceptions,
    "loops": rom_loops,
    "stack": rom_stack,
    "supervisor": rom_supervisor,
}


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(here), "tests", "roms")
    os.makedirs(outdir, exist_ok=True)

    for name, fn in sorted(ROMS.items()):
        data = fn()
        path = os.path.join(outdir, name + ".bin")
        with open(path, "wb") as f:
            f.write(data)
        print("wrote %s (%d bytes)" % (path, len(data)))


if __name__ == "__main__":
    main()
