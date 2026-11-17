# Núcleo Musashi 68k

Núcleo Motorola 68000 aislado, extraído de Genesis Plus GX.

## Contenido

- `m68kcpu.c` / `m68kcpu.h`: implementación y API de la CPU principal.
- `s68kcpu.c`: implementación de la CPU secundaria de Sega CD.
- `m68k.h`: API pública del núcleo.
- `m68kconf.h`: configuración de la CPU principal.
- `s68kconf.h`: configuración de la CPU secundaria.
- `m68kops.h`, `m68ki_cycles.h`, `s68ki_cycles.h` y
  `m68ki_instruction_jump_table.h`: implementación y tablas auxiliares.
- `macros.h`: macros compartidas requeridas por `m68k.h`.
- `debug/cpuhook.h`: soporte opcional de hooks (`HOOK_CPU`).
- `readme.txt`: documentación y licencia originales de Musashi.
- `LICENSE.txt`: licencias de Genesis Plus GX y sus componentes.
- `CREDITS.md`: atribución de autores y procedencia.

## Uso

Este directorio contiene un núcleo CPU, no un emulador completo ni un
ejecutable autónomo. Debe integrarse en un programa anfitrión que implemente
las funciones de acceso a memoria requeridas y registre los callbacks
correspondientes.

Las configuraciones heredadas de Sega/Main CPU y Sega CD Sub CPU mantienen
llamadas a callbacks específicos de Genesis Plus GX:

- `vdp_68k_irq_ack()` en `m68kconf.h`.
- `scd_68k_irq_ack()` en `s68kconf.h`.

Para utilizar el núcleo de forma independiente, sustituya esas llamadas por
callbacks propios o desactive las opciones que las requieran.

La compilación de `s68kcpu.c` y `m68kcpu.c` en el mismo programa requiere
gestionar sus símbolos compartidos según la configuración de Genesis Plus GX
original.

## Créditos y licencias

Consulte [`CREDITS.md`](CREDITS.md), [`readme.txt`](readme.txt) y
[`LICENSE.txt`](LICENSE.txt) antes de redistribuir este código.
