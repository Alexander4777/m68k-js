/* ======================================================================== */
/* ================== m68k-js-testkit :: C reference harness ============== */
/* ======================================================================== */
/*
 *  Differential test harness for the future JavaScript 68k core
 *  (../m68k-js).  This program links the *reference* Musashi C core taken
 *  verbatim from ../m68k and produces a deterministic JSON trace of the CPU
 *  state so that it can be compared byte for byte with the JS
 *  implementation.
 *
 *  Design notes
 *  ------------
 *  * The harness owns a flat 16 MiB address space (0x000000-0xFFFFFF),
 *    mirroring the 24 bit 68000 bus.  The low 64 KiB of it is used as
 *    "RAM" (where the initial SSP/PC live), the rest is loaded from an
 *    image/binary file.
 *  * Memory is exposed to Musashi through the `memory_map[256]` table:
 *    every 64 KiB page points at the matching offset of the flat buffer.
 *  * Execution is deterministic: no IRQs are raised by default (the
 *    harness only drives the IPL pins when asked to), no I/O side effects,
 *    no host time dependency.  `m68k_run()` is called with an *absolute*
 *    target cycle count, so the trace is reproducible bit for bit.
 *  * The JSON dump contains: all D/A registers, PC, SR, the status flags
 *    individually, the master cycle counter, the instruction register, the
 *    prefetch queue and a per-checkpoint history.
 *
 *  Usage
 *  -----
 *      c-harness --rom <file> [--cycles N] [--out <file.json>]
 *                 [--trace-steps N] [--step-cycles N] [--start-pc 0x...]
 *                 [--irq N@CYCLE] [--dump-mem addr:len] [--quiet]
 *
 *  Musashi / Genesis Plus GX attribution: see <musashi>/readme.txt,
 *  <musashi>/LICENSE.txt and <musashi>/CREDITS.md.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <errno.h>

#include "m68k.h"

/* ------------------------------------------------------------------ */
/*  Harness configuration coming from m68kconf_testkit.h               */
/* ------------------------------------------------------------------ */

#ifndef M68KCONF__HEADER
#error "m68kconf_testkit.h must be force-included (-include)"
#endif

#define HARNESS_MEM_SIZE   0x01000000u   /* 16 MiB flat address space */
#define HARNESS_PAGE_SIZE  0x00010000u   /* 64 KiB pages for memory_map[] */
#define HARNESS_MAX_IRQS   16
#define HARNESS_MAX_DUMPS  16

/* ------------------------------------------------------------------ */
/*  Stubs required by the Musashi configuration                         */
/* ------------------------------------------------------------------ */

/* Interrupt acknowledge stub (replaces vdp_68k_irq_ack()). */
int harness_int_ack(int int_level)
{
  /* Autovector the interrupt: 0x18 + level.  The value is ignored by
     Musashi in OPT_SPECIFY_HANDLER mode (the core always autovectors),
     but returning AUTOVECTOR keeps the semantics explicit. */
  (void)int_level;
  return M68K_INT_ACK_AUTOVECTOR;
}

/* Sega CD sub CPU IRQ acknowledge stub (kept for completeness; the Sub CPU
   is not compiled by this harness). */
int scd_68k_irq_ack(int int_level)
{
  (void)int_level;
  return M68K_INT_ACK_AUTOVECTOR;
}

/* Genesis Plus GX VDP IRQ acknowledge stub (kept for completeness). */
int vdp_68k_irq_ack(int int_level)
{
  (void)int_level;
  return M68K_INT_ACK_AUTOVECTOR;
}

/* Unused callback stubs referenced by the configuration header. */
void harness_reset_handler(void) { }
int  harness_tas_handler(void)  { return 1; }
void harness_set_fc_handler(unsigned int fc) { (void)fc; }

/* ------------------------------------------------------------------ */
/*  Global state                                                        */
/* ------------------------------------------------------------------ */

/* Snapshot of the architectural state, used both for the JSON dump and
   for the instruction-by-instruction trace. */
typedef struct {
  unsigned int cycles;
  unsigned int pc;
  unsigned int sr;
  unsigned int ir;
  unsigned int sp;
  unsigned int usp;
  unsigned int isp;
  unsigned int pref_addr;
  unsigned int pref_data;
  unsigned int d[8];
  unsigned int a[8];
} harness_state_t;

static uint8_t *g_mem;                 /* flat 16 MiB address space */
static unsigned int g_cycle_target;    /* absolute cycle target */
static unsigned int g_trace_steps;     /* number of trace checkpoints */
static unsigned int g_step_cycles;     /* cycles between checkpoints */
static unsigned int g_start_pc;        /* optional PC override */
static int g_have_start_pc;
static int g_quiet;

/* When enabled, the harness records the architectural state after every
   single instruction instead of using cycle based checkpoints.  This is
   used for the instruction-by-instruction differential comparison. */
static int g_trace_instructions;
static harness_state_t *g_instruction_states;
static unsigned int g_instruction_count;
static unsigned int g_instruction_capacity;

typedef struct {
  unsigned int level;
  unsigned int cycle;   /* absolute master cycle at which the IPL lines rise */
} irq_event_t;

static irq_event_t g_irqs[HARNESS_MAX_IRQS];
static unsigned int g_irq_count;

/* Master cycles consumed by the reset sequence.  The user visible cycle
   budget ("--cycles N") is relative to the end of the reset. */
static unsigned int g_reset_cycles;

typedef struct {
  unsigned int addr;
  unsigned int len;
} mem_dump_t;

static mem_dump_t g_dumps[HARNESS_MAX_DUMPS];
static unsigned int g_dump_count;

/* ------------------------------------------------------------------ */
/*  Small helpers                                                       */
/* ------------------------------------------------------------------ */

static void die(const char *fmt, ...)
{
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "c-harness: ");
  vfprintf(stderr, fmt, ap);
  fprintf(stderr, "\n");
  va_end(ap);
  exit(2);
}

static unsigned int parse_uint(const char *s)
{
  char *end = NULL;
  unsigned long v;

  errno = 0;
  v = strtoul(s, &end, 0);
  if (errno != 0 || end == s || (end && *end != '\0'))
    die("invalid number: %s", s);
  return (unsigned int)v;
}

/* ------------------------------------------------------------------ */
/*  Memory setup                                                        */
/* ------------------------------------------------------------------ */

/* The 68k is big-endian but Musashi accesses 16/32 bit words with raw
   host-endian casts.  On a little-endian host the image must therefore
   be stored byte-swapped (see LSB_FIRST in m68kconf_testkit.h), exactly
   like Genesis Plus GX does with the Mega Drive ROMs.

   The JS reference implementation works on plain big-endian bytes, so
   every access to the harness memory goes through these two helpers to
   keep the *logical* 68k view consistent. */
static int g_host_is_le(void)
{
  const uint16_t probe = 0x0102;
  return (*(const uint8_t *)&probe) == 0x02;
}

/* Convert a big-endian image into the host representation. */
static void byteswap_image(uint8_t *data, unsigned int len)
{
  unsigned int i;
  if (!g_host_is_le()) return;
  for (i = 0; i + 1 < len; i += 2)
  {
    uint8_t t = data[i];
    data[i] = data[i + 1];
    data[i + 1] = t;
  }
}

/* Read one byte of the *logical* 68k address space.

   With LSB_FIRST the core sees the logical byte at `addr` as
   g_mem[addr ^ 1]: the two bytes of every host word are stored in the
   opposite order, so the logical byte is the "other" byte of the
   aligned pair. */
static uint8_t mem_get8(unsigned int addr)
{
  if (g_host_is_le())
    return g_mem[addr ^ 1u];
  return g_mem[addr];
}

/* Read a big-endian 16 bit value from the logical 68k address space. */
static uint16_t mem_get16(unsigned int addr)
{
  uint16_t v;
  if (g_host_is_le())
    v = (uint16_t)(g_mem[addr & ~1u] | (g_mem[(addr & ~1u) ^ 1u] << 8));
  else
    v = (uint16_t)((g_mem[addr] << 8) | g_mem[addr + 1]);
  return v;
}

/* Read a big-endian 32 bit value from the logical 68k address space. */
static uint32_t mem_get32(unsigned int addr)
{
  uint32_t v;
  if (g_host_is_le())
    v = ((uint32_t)mem_get16(addr) << 16) | mem_get16(addr + 2);
  else
    v = ((uint32_t)g_mem[addr] << 24) | ((uint32_t)g_mem[addr + 1] << 16) |
        ((uint32_t)g_mem[addr + 2] << 8) | (uint32_t)g_mem[addr + 3];
  return v;
}

static void mem_setup(void)
{
  unsigned int i;

  g_mem = (uint8_t *)calloc(1, HARNESS_MEM_SIZE);
  if (!g_mem) die("out of memory (%u bytes)", HARNESS_MEM_SIZE);

  for (i = 0; i < 256; i++)
  {
    m68k.memory_map[i].base    = g_mem + (i * HARNESS_PAGE_SIZE);
    m68k.memory_map[i].read8   = NULL;
    m68k.memory_map[i].read16  = NULL;
    m68k.memory_map[i].write8  = NULL;
    m68k.memory_map[i].write16 = NULL;
  }
}

static int load_file(const char *path, unsigned int offset, unsigned int max_len)
{
  FILE *f;
  long size;
  size_t got;

  f = fopen(path, "rb");
  if (!f) die("cannot open '%s': %s", path, strerror(errno));

  fseek(f, 0, SEEK_END);
  size = ftell(f);
  fseek(f, 0, SEEK_SET);

  if (size < 0) die("cannot size '%s'", path);
  if ((unsigned long)offset + (unsigned long)size > HARNESS_MEM_SIZE)
    die("'%s' (%ld bytes) does not fit at offset 0x%X in a 16 MiB space", path, size, offset);

  if (max_len && (unsigned long)size > (unsigned long)max_len)
  {
    fprintf(stderr, "c-harness: warning: '%s' is %ld bytes, truncated to %u\n",
            path, size, max_len);
    size = (long)max_len;
  }

  got = fread(g_mem + offset, 1, (size_t)size, f);
  fclose(f);
  if (got != (size_t)size) die("short read on '%s'", path);

  /* Convert to the host representation expected by Musashi. */
  byteswap_image(g_mem + offset, (unsigned int)size);

  return (int)size;
}

/* ------------------------------------------------------------------ */
/*  JSON output                                                         */
/* ------------------------------------------------------------------ */

static void json_reg(FILE *out, const char *name, unsigned int value)
{
  fprintf(out, "\"%s\": \"0x%08X\",", name, value);
}



static void capture_state(harness_state_t *s, unsigned int cycles)
{
  int i;

  s->cycles = cycles;
  s->pc  = m68k_get_reg(M68K_REG_PC);
  s->sr  = m68k_get_reg(M68K_REG_SR) & 0xffff;
  s->ir  = m68k_get_reg(M68K_REG_IR) & 0xffff;
  s->sp  = m68k_get_reg(M68K_REG_SP);
  s->usp = m68k_get_reg(M68K_REG_USP);
  s->isp = m68k_get_reg(M68K_REG_ISP);
  s->pref_addr = m68k_get_reg(M68K_REG_PREF_ADDR);
  s->pref_data = m68k_get_reg(M68K_REG_PREF_DATA);
  for (i = 0; i < 8; i++)
  {
    s->d[i] = m68k_get_reg((m68k_register_t)(M68K_REG_D0 + i));
    s->a[i] = m68k_get_reg((m68k_register_t)(M68K_REG_A0 + i));
  }
}

static void dump_snapshot(FILE *out, unsigned int index,
                           const harness_state_t *s)
{
  int i;

  fprintf(out, "    {\n");
  fprintf(out, "      \"index\": %u,\n", index);
  fprintf(out, "      \"cycles\": %u,\n", s->cycles - g_reset_cycles);
  fprintf(out, "      \"abs_cycles\": %u,\n", s->cycles);
  fprintf(out, "      \"pc\": \"0x%08X\",\n", s->pc);
  fprintf(out, "      \"sr\": \"0x%04X\",\n", s->sr);
  fprintf(out, "      \"ir\": \"0x%04X\",\n", s->ir);
  fprintf(out, "      \"sp\": \"0x%08X\",\n", s->sp);
  fprintf(out, "      \"usp\": \"0x%08X\",\n", s->usp);
  fprintf(out, "      \"isp\": \"0x%08X\",\n", s->isp);
  fprintf(out, "      \"pref_addr\": \"0x%08X\",\n", s->pref_addr);
  fprintf(out, "      \"pref_data\": \"0x%08X\",\n", s->pref_data);

  /* Individual status register flags, so the JS side can be checked
     without having to know the exact SR bit layout. */
  {
    unsigned int sr = s->sr;
    fprintf(out, "      \"flags\": {\n");
    fprintf(out, "        \"t\": %u,\n", (sr >> 15) & 1);
    fprintf(out, "        \"s\": %u,\n", (sr >> 13) & 1);
    fprintf(out, "        \"i\": %u,\n", (sr >> 8) & 7);
    fprintf(out, "        \"x\": %u,\n", (sr >> 4) & 1);
    fprintf(out, "        \"n\": %u,\n", (sr >> 3) & 1);
    fprintf(out, "        \"z\": %u,\n", (sr >> 2) & 1);
    fprintf(out, "        \"v\": %u,\n", (sr >> 1) & 1);
    fprintf(out, "        \"c\": %u\n", (sr >> 0) & 1);
    fprintf(out, "      },\n");
  }

  fprintf(out, "      \"d\": [");
  for (i = 0; i < 8; i++)
    fprintf(out, "%s\"0x%08X\"", i ? ", " : " ", s->d[i]);
  fprintf(out, "],\n");

  fprintf(out, "      \"a\": [");
  for (i = 0; i < 8; i++)
    fprintf(out, "%s\"0x%08X\"", i ? ", " : " ", s->a[i]);
  fprintf(out, "]\n");
  fprintf(out, "    }");
}

static void dump_state(FILE *out, unsigned int index, unsigned int cycles)
{
  harness_state_t s;

  capture_state(&s, cycles);
  dump_snapshot(out, index, &s);
}

/* ------------------------------------------------------------------ */
/*  Argument parsing                                                    */
/* ------------------------------------------------------------------ */

static void usage(void)
{
  fprintf(stderr,
    "usage: c-harness --rom <file> [options]\n"
    "\n"
    "  --rom <file>          image/binary loaded at --load-addr (default 0)\n"
    "  --load-addr <addr>    address where the image is loaded (default 0)\n"
    "  --cycles <n>          absolute master cycle target (default 1000)\n"
    "  --step-cycles <n>     cycles between trace checkpoints (default 100)\n"
    "  --trace-steps <n>     maximum number of checkpoints (default 10)\n"
    "  --trace-instructions  record the state after every instruction\n"
    "  --start-pc <addr>     override the PC after reset\n"
    "  --irq <level>@<cycle> raise IPL lines to <level> at <cycle>\n"
    "  --dump-mem <a>:<len>  append a memory range to the JSON dump\n"
    "  --out <file>          write the JSON dump here (default: stdout)\n"
    "  --quiet               do not print the human readable summary\n"
    "  --help                this message\n");
}

int main(int argc, char **argv)
{
  const char *rom_path = NULL;
  const char *out_path = NULL;
  unsigned int load_addr = 0;
  unsigned int i;
  FILE *out = stdout;
  unsigned int checkpoint_cycles[256];
  unsigned int checkpoint_count = 0;

  g_cycle_target = 1000;
  g_step_cycles  = 100;
  g_trace_steps  = 10;

  for (i = 1; i < (unsigned int)argc; i++)
  {
    const char *a = argv[i];

    if (!strcmp(a, "--rom") && i + 1 < (unsigned int)argc)
      rom_path = argv[++i];
    else if (!strcmp(a, "--out") && i + 1 < (unsigned int)argc)
      out_path = argv[++i];
    else if (!strcmp(a, "--load-addr") && i + 1 < (unsigned int)argc)
      load_addr = parse_uint(argv[++i]);
    else if (!strcmp(a, "--cycles") && i + 1 < (unsigned int)argc)
      g_cycle_target = parse_uint(argv[++i]);
    else if (!strcmp(a, "--step-cycles") && i + 1 < (unsigned int)argc)
      g_step_cycles = parse_uint(argv[++i]);
    else if (!strcmp(a, "--trace-steps") && i + 1 < (unsigned int)argc)
      g_trace_steps = parse_uint(argv[++i]);
    else if (!strcmp(a, "--trace-instructions"))
      g_trace_instructions = 1;
    else if (!strcmp(a, "--start-pc") && i + 1 < (unsigned int)argc)
    {
      g_start_pc = parse_uint(argv[++i]);
      g_have_start_pc = 1;
    }
    else if (!strcmp(a, "--irq") && i + 1 < (unsigned int)argc)
    {
      char *spec = argv[++i];
      char *at = strchr(spec, '@');
      if (!at) die("bad --irq spec '%s' (expected <level>@<cycle>)", spec);
      *at = '\0';
      if (g_irq_count >= HARNESS_MAX_IRQS) die("too many --irq entries");
      g_irqs[g_irq_count].level = parse_uint(spec);
      g_irqs[g_irq_count].cycle = parse_uint(at + 1);
      g_irq_count++;
    }
    else if (!strcmp(a, "--dump-mem") && i + 1 < (unsigned int)argc)
    {
      char *spec = argv[++i];
      char *colon = strchr(spec, ':');
      if (!colon) die("bad --dump-mem spec '%s' (expected <addr>:<len>)", spec);
      *colon = '\0';
      if (g_dump_count >= HARNESS_MAX_DUMPS) die("too many --dump-mem entries");
      g_dumps[g_dump_count].addr = parse_uint(spec);
      g_dumps[g_dump_count].len  = parse_uint(colon + 1);
      g_dump_count++;
    }
    else if (!strcmp(a, "--quiet"))
      g_quiet = 1;
    else if (!strcmp(a, "--help") || !strcmp(a, "-h"))
    {
      usage();
      return 0;
    }
    else
      die("unknown argument '%s' (try --help)", a);
  }

  if (!rom_path) { usage(); die("--rom is required"); }
  if (g_step_cycles == 0) g_step_cycles = 1;
  if (g_cycle_target == 0) g_cycle_target = 1;

  if (g_trace_instructions)
  {
    /* One state per instruction.  The buffer grows on demand so that long
       programs are still traced completely. */
    g_instruction_capacity = 4096;
    g_instruction_states = (harness_state_t *)malloc(
      g_instruction_capacity * sizeof(harness_state_t));
    if (!g_instruction_states) die("out of memory for the instruction trace");
  }

  /* --- memory ---------------------------------------------------- */
  mem_setup();

  /* The initial SSP/PC live at 0x0000/0x0004.  If the image does not
     provide them we install a default stack pointer / entry point so that
     a bare binary can still be executed. */
  {
    uint32_t ssp = 0;
    uint32_t pc  = 0;
    int have_ssp = 0, have_pc = 0;

    if (load_file(rom_path, load_addr, 0) > 0)
    {
      if (load_addr == 0)
      {
        /* Read the reset vector from the *logical* (big-endian) view. */
        ssp = mem_get32(0);
        pc  = mem_get32(4);
        have_ssp = 1;
        have_pc  = 1;
        if (!g_quiet)
          fprintf(stderr,
                  "c-harness: image vector SSP=0x%08X PC=0x%08X\n", ssp, pc);
      }
    }

    if (!have_ssp || !have_pc)
    {
      /* default: stack at 0x00FF0000, entry at the load address */
      uint32_t dsp = 0x00FF0000u;
      uint32_t dpc = load_addr;
      uint8_t vec[8];
      vec[0] = (uint8_t)(dsp >> 24); vec[1] = (uint8_t)(dsp >> 16);
      vec[2] = (uint8_t)(dsp >> 8);  vec[3] = (uint8_t)dsp;
      vec[4] = (uint8_t)(dpc >> 24); vec[5] = (uint8_t)(dpc >> 16);
      vec[6] = (uint8_t)(dpc >> 8);  vec[7] = (uint8_t)dpc;
      byteswap_image(vec, 8);
      memcpy(g_mem, vec, 8);
      if (!g_quiet)
        fprintf(stderr,
                "c-harness: no reset vector in image, using SSP=0x%08X PC=0x%08X\n",
                dsp, dpc);
    }
  }

  /* --- CPU -------------------------------------------------------- */
  m68k_init();
  m68k_pulse_reset();

  /* The reset itself consumes a few master cycles (40 * MUL for the
     68000 reset vector fetch).  The user supplied cycle budget is
     relative to the reset, so the absolute target is shifted by the
     cycles already consumed.  This keeps "--cycles N" meaning "execute N
     cycles of the program" for both the C and the JS harness. */
  {
    unsigned int consumed = (unsigned int)m68k.cycles;
    g_reset_cycles = consumed;
    g_cycle_target += consumed;
    if (!g_quiet)
      fprintf(stderr, "c-harness: reset consumed %u cycles\n", consumed);
  }

  if (g_have_start_pc)
    m68k_set_reg(M68K_REG_PC, g_start_pc);

  /* --- run -------------------------------------------------------- */
  {
    unsigned int next_checkpoint = (unsigned int)(m68k.cycles + (int)g_step_cycles);
    unsigned int irq_index = 0;

    if (g_trace_instructions)
    {
      /* Instruction granularity: m68k_run() executes at least one whole
         instruction per call, so targeting "current cycles + 1" advances
         the core by exactly one instruction. */
      while ((unsigned int)m68k.cycles < g_cycle_target)
      {
        unsigned int before = (unsigned int)m68k.cycles;

        while (irq_index < g_irq_count &&
               g_irqs[irq_index].cycle <= (unsigned int)m68k.cycles)
        {
          m68k_set_irq(g_irqs[irq_index].level);
          irq_index++;
        }

        m68k_run((unsigned int)m68k.cycles + 1);

        /* A stopped core does not execute any further instruction; the
           host is expected to resume it with an interrupt. */
        if (m68k.stopped)
        {
          if (g_instruction_states && g_instruction_count < g_instruction_capacity)
          {
            capture_state(&g_instruction_states[g_instruction_count++],
                          (unsigned int)m68k.cycles);
          }
          break;
        }

        if (g_instruction_states)
        {
          if (g_instruction_count == g_instruction_capacity)
          {
            harness_state_t *bigger;
            g_instruction_capacity *= 2;
            bigger = (harness_state_t *)realloc(
              g_instruction_states,
              g_instruction_capacity * sizeof(harness_state_t));
            if (!bigger) die("out of memory growing the instruction trace");
            g_instruction_states = bigger;
          }
          capture_state(&g_instruction_states[g_instruction_count++],
                        (unsigned int)m68k.cycles);
        }

        if ((unsigned int)m68k.cycles == before)
        {
          /* No progress (the core is stopped): stop tracing. */
          break;
        }
      }
    }
    else
    {
      while ((unsigned int)m68k.cycles < g_cycle_target)
      {
        unsigned int target = g_cycle_target;

        /* Fire pending IRQs whose cycle has been reached. */
        while (irq_index < g_irq_count &&
               g_irqs[irq_index].cycle <= (unsigned int)m68k.cycles)
        {
          m68k_set_irq(g_irqs[irq_index].level);
          irq_index++;
        }

        /* Stop at the next checkpoint so the trace has fine granularity. */
        if (next_checkpoint < target) target = next_checkpoint;

        m68k_run(target);

        if ((unsigned int)m68k.cycles >= next_checkpoint ||
            (unsigned int)m68k.cycles >= g_cycle_target)
        {
          if (checkpoint_count < 256)
            checkpoint_cycles[checkpoint_count++] = (unsigned int)m68k.cycles;
          if (checkpoint_count >= g_trace_steps)
            break;
          next_checkpoint = (unsigned int)m68k.cycles + g_step_cycles;
          if (next_checkpoint > g_cycle_target) next_checkpoint = g_cycle_target;
        }
      }

      if (checkpoint_count == 0 ||
          checkpoint_cycles[checkpoint_count - 1] != (unsigned int)m68k.cycles)
      {
        if (checkpoint_count < 256)
          checkpoint_cycles[checkpoint_count++] = (unsigned int)m68k.cycles;
      }
    }
  }

  /* --- dump ------------------------------------------------------- */
  if (out_path)
  {
    out = fopen(out_path, "wb");
    if (!out) die("cannot write '%s': %s", out_path, strerror(errno));
  }

  fprintf(out, "{\n");
  fprintf(out, "  \"source\": \"c-harness\",\n");
  fprintf(out, "  \"core\": \"musashi\",\n");
  fprintf(out, "  \"rom\": \"%s\",\n", rom_path);
  fprintf(out, "  \"load_addr\": \"0x%08X\",\n", load_addr);
  fprintf(out, "  \"final_cycles\": %u,\n", (unsigned int)m68k.cycles - g_reset_cycles);
  fprintf(out, "  \"abs_final_cycles\": %u,\n", (unsigned int)m68k.cycles);
  fprintf(out, "  \"reset_cycles\": %u,\n", g_reset_cycles);
  fprintf(out, "  \"cycle_target\": %u,\n", g_cycle_target - g_reset_cycles);
  fprintf(out, "  \"step_cycles\": %u,\n", g_step_cycles);
  if (g_trace_instructions)
  {
    fprintf(out, "  \"trace_instructions\": true,\n");
    fprintf(out, "  \"states\": [\n");
    for (i = 0; i < g_instruction_count; i++)
    {
      dump_snapshot(out, i, &g_instruction_states[i]);
      if (i + 1 < g_instruction_count) fprintf(out, ",");
      fprintf(out, "\n");
    }
    fprintf(out, "  ],\n");
    fprintf(out, "  \"final\": ");
    dump_state(out, g_instruction_count ? g_instruction_count - 1 : 0,
               (unsigned int)m68k.cycles);
    fprintf(out, ",\n");
  }
  else
  {
    fprintf(out, "  \"states\": [\n");
    for (i = 0; i < checkpoint_count; i++)
    {
      dump_state(out, i, checkpoint_cycles[i]);
      if (i + 1 < checkpoint_count) fprintf(out, ",");
      fprintf(out, "\n");
    }
    fprintf(out, "  ],\n");
    fprintf(out, "  \"final\": ");
    dump_state(out, checkpoint_count ? checkpoint_count - 1 : 0,
               (unsigned int)m68k.cycles);
    fprintf(out, ",\n");
  }

  /* final registers, in a flat form, for quick diffing */
  fprintf(out, "  \"final_regs\": {\n");
  json_reg(out, "d0", m68k_get_reg(M68K_REG_D0)); fprintf(out, "\n");
  json_reg(out, "d1", m68k_get_reg(M68K_REG_D1)); fprintf(out, "\n");
  json_reg(out, "d2", m68k_get_reg(M68K_REG_D2)); fprintf(out, "\n");
  json_reg(out, "d3", m68k_get_reg(M68K_REG_D3)); fprintf(out, "\n");
  json_reg(out, "d4", m68k_get_reg(M68K_REG_D4)); fprintf(out, "\n");
  json_reg(out, "d5", m68k_get_reg(M68K_REG_D5)); fprintf(out, "\n");
  json_reg(out, "d6", m68k_get_reg(M68K_REG_D6)); fprintf(out, "\n");
  json_reg(out, "d7", m68k_get_reg(M68K_REG_D7)); fprintf(out, "\n");
  json_reg(out, "a0", m68k_get_reg(M68K_REG_A0)); fprintf(out, "\n");
  json_reg(out, "a1", m68k_get_reg(M68K_REG_A1)); fprintf(out, "\n");
  json_reg(out, "a2", m68k_get_reg(M68K_REG_A2)); fprintf(out, "\n");
  json_reg(out, "a3", m68k_get_reg(M68K_REG_A3)); fprintf(out, "\n");
  json_reg(out, "a4", m68k_get_reg(M68K_REG_A4)); fprintf(out, "\n");
  json_reg(out, "a5", m68k_get_reg(M68K_REG_A5)); fprintf(out, "\n");
  json_reg(out, "a6", m68k_get_reg(M68K_REG_A6)); fprintf(out, "\n");
  json_reg(out, "a7", m68k_get_reg(M68K_REG_A7)); fprintf(out, "\n");
  json_reg(out, "pc", m68k_get_reg(M68K_REG_PC)); fprintf(out, "\n");
  json_reg(out, "sr", m68k_get_reg(M68K_REG_SR) & 0xffff); fprintf(out, "\n");
  fprintf(out, "    \"cycles\": %u\n", (unsigned int)m68k.cycles - g_reset_cycles);
  fprintf(out, "  }");

  /* optional memory ranges */
  if (g_dump_count)
  {
    unsigned int d;
    fprintf(out, ",\n  \"memory\": [\n");
    for (d = 0; d < g_dump_count; d++)
    {
      unsigned int a = g_dumps[d].addr;
      unsigned int l = g_dumps[d].len;
      unsigned int k;
      if (a + l > HARNESS_MEM_SIZE) l = HARNESS_MEM_SIZE - a;
      fprintf(out, "    { \"addr\": \"0x%08X\", \"len\": %u, \"bytes\": [", a, l);
      for (k = 0; k < l; k++)
      {
        if (k) fprintf(out, ", ");
        fprintf(out, "%u", mem_get8(a + k));
      }
      fprintf(out, "] }%s\n", (d + 1 < g_dump_count) ? "," : "");
    }
    fprintf(out, "  ]");
  }

  fprintf(out, "\n}\n");

  if (out != stdout) fclose(out);

  if (!g_quiet)
  {
    fprintf(stderr,
            "c-harness: cycles=%u pc=0x%08X sr=0x%04X checkpoints=%u\n",
            (unsigned int)m68k.cycles,
            m68k_get_reg(M68K_REG_PC),
            m68k_get_reg(M68K_REG_SR) & 0xffff,
            checkpoint_count);
  }

  free(g_mem);
  return 0;
}
