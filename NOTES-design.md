# Notas de diseño

Qué se probó y qué se descartó, para no volver a recorrer el mismo camino.

## Paleta y temas (2026-09)

**El sujeto.** Un CRM de prospección que una o dos personas usan ocho horas
al día sobre una tabla de 11.948 colegios. El único trabajo de la pantalla:
decidir a quién escribirle hoy y ver si contestaron. Todo lo demás compite
con eso.

**De dónde sale el color.** De la identidad que la propia app manda en cada
correo: el navy `#14345c` y el rojo `#e8443a` de JUMP Math, que vivían sólo
en `MARCA` dentro de `mailing.js`. La herramienta usaba un azul de stock que
no tenía nada que ver con lo que vende. Ahora el acento es ese navy y el
rojo es el color de lo urgente.

**La regla del vidrio.** Liquid Glass en el cromo —riel, ficha,
desplegables, velo, barra— y material opaco en los datos —tabla, KPI,
tarjetas, campos—. No es una concesión: una cifra leída a través de un
vidrio se lee peor, y esta pantalla existe para leer cifras. El vidrio va
donde se navega, no donde se decide.

**El lienzo.** Dos focos radiales fijos —navy arriba a la izquierda, un
rescoldo del rojo abajo a la derecha— sobre `#dbe3ef`. Sin ellos el vidrio
no refracta nada y el riel se ve como un panel gris. Es el único elemento
decorativo del diseño y se mantiene bajo: a `.09` el rojo, porque a `.13`
el área vacía de Campañas se leía como un degradado morado de plantilla.

**La firma.** El ítem de navegación activo como una lente: pastilla de
vidrio con filo especular arriba y un halo del acento detrás. Es el único
sitio donde la interfaz se permite ser vistosa.

### Descartado

- **Vidrio también en KPI y tarjetas.** Fue el primer impulso y es
  glassmorphism decorativo: hundía la legibilidad de las cifras, que es
  justo lo que la pantalla tiene que hacer bien.
- **Webfont de display.** Un CRM que pinta 300 filas no debe esperar a una
  fuente. El stack del sistema es además la tipografía nativa de Liquid
  Glass en Mac y iOS. El carácter va en la escala —tracking negativo en
  títulos, versalitas espaciadas en etiquetas— y no en la familia.
- **Oscuro casi negro con un acento ácido.** Es el default de todo panel
  generado hoy. El oscuro de acá es el mismo navy bajado a carbón, para que
  los dos temas se reconozcan como la misma herramienta.

### Segunda pasada: que el vidrio sea vidrio

La primera versión tenía translucidez y desenfoque, y aun así el riel se
leía como una columna tintada. Lo que faltaba no era más blur: era que se
viera el fondo por los cuatro lados y que el borde tuviera espesor. Tres
decisiones:

- **Flota.** El riel lleva 10px de aire y esquinas de 20px; la ficha se
  posa sobre la tabla con aire alrededor en vez de salir pegada al borde.
  Un panel translúcido pegado a un lado es pintura; despegado, es un objeto.
- **Canto.** `--relieve-vidrio`: filo de luz arriba y a la izquierda —de
  donde viene la luz del lienzo—, filo de sombra abajo, y una banda clara
  que entra desde el borde superior como la luz al cruzar la lámina. Todo
  con sombras internas: el riel desplaza su contenido y un pseudo-elemento
  absoluto se iría con él.
- **Esquinas concéntricas.** Lente de 8px dentro de un riel de 20px con
  12px de relleno. Paralelas se ven mal y nadie sabe por qué.

El desenfoque bajó de 22 a 18px y subió la saturación: el vidrio tiene que
dejar adivinar la forma de lo que pasa por debajo. Los controles del
filtro siguen opacos: son cromo, pero están pegados a los datos.

Descartado: grano/ruido (Apple no lo usa; sólo ensucia), y vidrio en los
selectores de la barra de filtros (se pierde legibilidad justo donde se
decide qué mirar).

### Restricciones que hay que respetar al tocar esto

- La rampa ordinal de tiers está validada (monotonía, ΔL, contraste del
  extremo claro, un solo hue). El único hex que se movió fue `--tier-2` en
  claro, de `#2a78d6` a `#2773ce`, mismo hue y luminancia todavía entre t1
  y t3, porque con el anterior ninguna etiqueta —ni blanca ni negra—
  llegaba a AA.
- Todo par texto/fondo pasa AA sobre superficie **y** sobre vidrio. Los
  colores que se aclaran en oscuro para separarse del fondo (`--acento`,
  `--critico`, `--tier-2`) llevan su propio token de tinta encima
  (`--sobre-*`): el blanco sobre ellos cae a 2,9:1.
- El tema se aplica en un script en `<head>`, antes de pintar. Puesto en
  `app.js` —que es un módulo, y por tanto diferido— la página aparecería un
  instante en claro antes de saltar a oscuro en cada carga.
