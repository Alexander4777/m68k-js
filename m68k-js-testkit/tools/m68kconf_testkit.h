/* ======================================================================== */
/* ==================== TESTKIT HOST CPU CONFIGURATION ===================== */
/* ======================================================================== */
/*
 *  Standalone Musashi configuration for the differential test harness.
 *
 *  It is a *host* config: it is NOT installed into the Musashi source tree.
 *  The harness compiles the reference core with `-include` so that this file
 *  shadows the stock `m68kconf.h` of the Musashi distribution:
 *
 *      gcc ... -include tools/m68kconf_testkit.h <musashi>/m68kcpu.c
 *
 *  Differences with the stock Genesis Plus GX config:
 *
 *    * M68K_INT_ACK_CALLBACK points at the harness' own stub
 *      (`harness_int_ack`) instead of `vdp_68k_irq_ack()`, so the core can
 *      be linked without any Genesis Plus GX symbols.
 *    * `scd_68k_irq_ack()` is *not* referenced at all: the Sub CPU
 *      (s68kcpu.c) is never compiled by this harness, so the Sega CD stub
 *      is not needed.  A stub is still provided in `c-harness.c` for hosts
 *      that do want to link the Sub CPU.
 *    * The bus refresh mechanism of the Mega Drive is disabled conceptually:
 *      `m68k.refresh_cycles` is only re-armed by the core itself, but the
 *      harness keeps the cycle accounting identical between C and JS by
 *      always using the *same* MUL factor (7) and by disabling
 *      M68K_OVERCLOCK_SHIFT.
 *
 *  Musashi / Genesis Plus GX attribution and licensing notices are preserved
 *  in the Musashi sources; see <musashi>/readme.txt, LICENSE.txt, CREDITS.md.
 */

#ifndef M68KCONF__HEADER
#define M68KCONF__HEADER

/* --------------------------------------------------------------------- */
/*  Host callbacks required by this configuration.                        */
/*  They are implemented by the host program (see tools/c-harness.c).     */
/* --------------------------------------------------------------------- */
#ifdef __cplusplus
extern "C" {
#endif

int  harness_int_ack(int int_level);
void harness_reset_handler(void);
int  harness_tas_handler(void);
void harness_set_fc_handler(unsigned int fc);

#ifdef __cplusplus
}
#endif

/* Configuration switches. */
#define OPT_OFF             0
#define OPT_ON              1
#define OPT_SPECIFY_HANDLER 2

/* MOVE.L with predecrement destination writes high word first. */
#define M68K_SIMULATE_PD_WRITES     OPT_OFF

/* Interrupt acknowledge: use the harness stub (declared in c-harness.c). */
#define M68K_EMULATE_INT_ACK        OPT_SPECIFY_HANDLER
#define M68K_INT_ACK_CALLBACK(A)    harness_int_ack(A)

/* RESET instruction: no host callback needed. */
#define M68K_EMULATE_RESET          OPT_OFF
#define M68K_RESET_CALLBACK()       harness_reset_handler()

/* TAS instruction: no host callback needed. */
#define M68K_TAS_HAS_CALLBACK       OPT_OFF
#define M68K_TAS_CALLBACK()         harness_tas_handler()

/* Function codes are not emulated (68000 semantics). */
#define M68K_EMULATE_FC             OPT_OFF
#define M68K_SET_FC_CALLBACK(A)     harness_set_fc_handler(A)

/* Trace exceptions are not emulated. */
#define M68K_EMULATE_TRACE          OPT_OFF

/* Prefetch queue emulation is ON in Musashi; keep it ON so the reference
 * matches the Genesis Plus GX behaviour the future JS port must replicate. */
#define M68K_EMULATE_PREFETCH       OPT_ON

/* Address error exceptions are emulated. */
#define M68K_EMULATE_ADDRESS_ERROR  OPT_ON

/* Address error check on instruction fetch is OFF (as in Genesis Plus GX). */
#define M68K_CHECK_PC_ADDRESS_ERROR OPT_OFF

/* 64 bit integer operations are not used. */
#define M68K_USE_64_BIT  OPT_OFF

/* --------------------------------------------------------------------- */
/*  Endianness.                                                           */
/*                                                                       */
/*  Musashi accesses 16/32 bit data with raw host-endian casts           */
/*  (`*(uint16 *)`) and 8 bit data through the READ_BYTE()/WRITE_BYTE()  */
/*  macros of macros.h.  To have a single, coherent big-endian 68k view  */
/*  on a little-endian host we must:                                      */
/*                                                                       */
/*    1. define LSB_FIRST  -> READ_BYTE() becomes base[addr ^ 1]         */
/*    2. store the memory image byte-swapped (see byteswap_image() in    */
/*       tools/c-harness.c) so that the raw uint16/uint32 casts see     */
/*       the correct big-endian values.                                   */
/*                                                                       */
/*  This is exactly what Genesis Plus GX does on little-endian hosts     */
/*  (see <gpgx>/core/loadrom.c: "Byteswap ROM to optimize 16-bit       */
/*  access").  The JS reference implementation is byte-exact big-endian */
/*  and therefore needs NO such transformation: the harness always      */
/*  un-swaps the memory before dumping it.                               */
/* --------------------------------------------------------------------- */
#ifndef LSB_FIRST
#if defined(__BYTE_ORDER__) && defined(__ORDER_LITTLE_ENDIAN__) && \
    (__BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__)
#define LSB_FIRST 1
#endif
#endif

/* ======================================================================== */
/* ============================== END OF FILE ============================== */
/* ======================================================================== */

#endif /* M68KCONF__HEADER */
