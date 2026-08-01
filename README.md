# JMVENTAS — Prospección comercial JUMP Math Chile

Base de prospectos, estrategia y herramientas para vender el programa JUMP Math a colegios particulares y sostenedores públicos en Chile.

## Qué hay acá

```
estrategia/estrategia-comercial-jumpmath-chile.md   Estrategia completa: segmentación, canales, calendario
datos/prospectos_jumpmath.csv                       7.808 establecimientos puntuados y clasificados por tier
datos/prospectos_jumpmath_2026.xlsx                 Lo mismo + hoja de redes + resumen
datos/contactos-verificados.csv                     24 cuentas de cabecera, 14 con correo o teléfono directo
scripts/build-prospectos.sh                         Regenera la base desde el directorio oficial MINEDUC
scripts/analizar-base.py                            Reproduce los cortes que sostienen la estrategia
scripts/enriquecer-contactos.py                     Busca sitio, correo y teléfono de cada colegio
```

## Empezar

```bash
pip install --break-system-packages pandas openpyxl requests beautifulsoup4

# ver los cortes de la base
python3 scripts/analizar-base.py

# ver a quién llamar primero
column -s, -t datos/contactos-verificados.csv | less -S
```

## Completar los contactos que faltan

`datos/contactos-verificados.csv` cubre la cabecera del pipeline (las 7 redes principales, los colegios privados de mayor matrícula, el Registro ATE y los SLEP identificados). El resto del Tier 1 se completa con el enriquecedor:

```bash
# solo particular pagado del Tier 1: no requiere ATE, ciclo de 4-10 semanas
python3 scripts/enriquecer-contactos.py \
  --csv datos/prospectos_jumpmath.csv \
  --tier "1 · FACIL" --canal "A · Directo Privado" --limite 250

# un representante por red, para venta de sostenedor
python3 scripts/enriquecer-contactos.py \
  --csv datos/prospectos_jumpmath.csv \
  --tier "1 · FACIL" --por-sostenedor --limite 100

# ver a quién consultaría sin salir a la red
python3 scripts/enriquecer-contactos.py --csv datos/prospectos_jumpmath.csv --dry-run
```

Es resumible: guarda cada 10 registros y no repite lo ya resuelto. Con las pausas educadas que trae por defecto, el Tier 1 completo toma unas 3 horas. **Requiere salida a internet** — no corre en entornos con egress restringido.

## Regenerar la base

El directorio oficial MINEDUC sale cada noviembre:

```bash
bash scripts/build-prospectos.sh
```

## Cómo leer el CSV de contactos

| Columna | Para qué |
|---|---|
| `PRIORIDAD` | 1 = llamar esta semana, 2 = este mes, 3 = cuando haya ATE |
| `REQUIERE_ATE` | Si es `SÍ`, no hay venta legal sin estar en el Registro ATE |
| `CONFIANZA` | `ALTA` = del sitio oficial · `MEDIA` = de una fuente · `BAJA` = confirmar antes de usar |
| `FUENTE` | De dónde salió cada dato |
| `PROXIMO_PASO` | Qué hacer concretamente con esa cuenta |

Los teléfonos y correos se recogieron de fuentes públicas en agosto de 2026. Los marcados `MEDIA` y `BAJA` conviene confirmarlos en la primera llamada; los cargos de directores ejecutivos de SLEP rotan y hay que validarlos en `dep.gob.cl` antes de dirigir una carta.

## Lo que falta

- **Cruce con SIMCE Matemática y Categoría de Desempeño** (`informacionestadistica.agenciaeducacion.cl`). Convierte la base en "colegios con problema de matemática documentado" y es lo que más sube la tasa de respuesta.
- **Nombre y cargo de la contraparte en Cognita.** La cuenta ya tiene teléfono y correo corporativo, pero falta identificar al director académico regional LatAm — el que realmente decide sobre 21 colegios.
- Enriquecimiento del Tier 1 completo (351 registros): hoy hay 24 cuentas de cabecera de 351.
- Contacto de los 36 SLEP. Sólo 5 están identificados y 3 con confianza baja: los cargos de director ejecutivo rotan y hay que sacarlos de `dep.gob.cl`.
