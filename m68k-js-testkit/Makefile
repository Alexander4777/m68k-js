# ========================================================================
#  m68k-js-testkit :: build configuration
# ========================================================================
#
#  Builds the C reference harness by linking the *unmodified* Musashi
#  core from ../m68k.  The Musashi tree is read-only and must NOT be
#  patched: instead we force-include tools/m68kconf_testkit.h, which
#  shadows the stock m68kconf.h and points the interrupt-ack callback
#  at our own stub.
#
#  Override the Musashi location with:  make MUSASHI_DIR=/path/to/m68k
#

TESTKIT_DIR := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
MUSASHI_DIR ?= $(TESTKIT_DIR)/../m68k

CC       ?= gcc
BUILD    ?= $(TESTKIT_DIR)/build
OUT      ?= $(TESTKIT_DIR)/out
TOOLS    := $(TESTKIT_DIR)/tools

HARNESS  := $(OUT)/c-harness

# Force-included host config: it shadows the Musashi stock m68kconf.h.
HOST_CONFIG := $(TOOLS)/m68kconf_testkit.h

CFLAGS ?= -O2 -g -std=gnu99 -Wall -Wextra -Wno-unused-parameter
CFLAGS += -I"$(MUSASHI_DIR)" -I"$(TOOLS)" -include "$(HOST_CONFIG)"

# The Musashi sources are third party: do not fail the build on their
# warnings.
CFLAGS_CORE := -O2 -g -std=gnu99 -w -I"$(MUSASHI_DIR)" -I"$(TOOLS)" \
               -include "$(HOST_CONFIG)"

CORE_SRC := $(MUSASHI_DIR)/m68kcpu.c
CORE_OBJ := $(BUILD)/m68kcpu.o

LDFLAGS ?=

.PHONY: all clean test roms help
.DEFAULT_GOAL := all

all: $(HARNESS)

help:
	@echo "targets:"
	@echo "  all      build the C reference harness (default)"
	@echo "  test     build + run the full differential test suite"
	@echo "  roms     regenerate the test ROMs"
	@echo "  clean    remove build artefacts"
	@echo ""
	@echo "variables:"
	@echo "  MUSASHI_DIR=$(MUSASHI_DIR)"
	@echo "  CC=$(CC)"

$(BUILD) $(OUT):
	@mkdir -p $@

$(CORE_OBJ): $(CORE_SRC) $(HOST_CONFIG) | $(BUILD)
	$(CC) $(CORE_CFLAGS) -c -o $@ $(CORE_SRC)

$(HARNESS): $(TOOLS)/c-harness.c $(CORE_OBJ) | $(OUT)
	$(CC) $(CFLAGS) -o $@ $(TOOLS)/c-harness.c $(CORE_OBJ) $(LDFLAGS)

roms:
	@$(TESTKIT_DIR)/scripts/make-roms.sh

test: $(HARNESS)
	@$(TESTKIT_DIR)/scripts/run-tests.sh

clean:
	rm -rf $(BUILD) $(OUT)
