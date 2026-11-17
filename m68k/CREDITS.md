# Créditos

Este directorio contiene el núcleo de emulación de CPU Motorola 68000
**Musashi**, extraído del proyecto **Genesis Plus GX**.

## Autoría

- **Núcleo Musashi original:** Karl Stenerud (proyecto MAME).
  - Copyright 1998-2001 Karl Stenerud. Todos los derechos reservados.
  - El núcleo se distribuye según las condiciones indicadas en
    [`readme.txt`](readme.txt).
- **Código original de Genesis Plus:** Charles MacDonald.
- **Mejoras y adaptación de Genesis Plus GX:** Eke-Eke.
- **Procedencia:** [Genesis Plus GX](https://github.com/ekeeke/Genesis-Plus-GX).

## Dependencias incluidas

- `macros.h`: aclaraciones de macros de little-endian y compatibilidad C89,
  Copyright Charles MacDonald / Eke-Eke.
- `debug/cpuhook.h`: interfaz opcional para hooks de CPU,
  Copyright Charles MacDonald / Eke-Eke.

## Licencia

Los avisos y condiciones de redistribución de Genesis Plus GX y de sus
componentes se conservan en [`LICENSE.txt`](LICENSE.txt). Se deben leer y
cumplir junto con las condiciones específicas de Musashi incluidas en
[`readme.txt`](readme.txt).

Este directorio es el núcleo CPU aislado, no un emulador completo. Las
configuraciones heredadas de Sega/Main CPU y Sega CD Sub CPU mantienen
llamadas a callbacks específicos de Genesis Plus GX (`vdp_68k_irq_ack` y
`scd_68k_irq_ack`); para su uso independiente deben sustituirse por
callbacks propios.
