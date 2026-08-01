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
firebase/                                           Carga de todo esto en Firestore (ver abajo)
```

## Cargar todo en Firebase

Proyecto `jmventas-aab3c`. Son **8.158 documentos** en cuatro colecciones:

| Colección | Docs | ID del documento | Qué contiene |
|---|---:|---|---|
| `prospectos` | 7.808 | el RBD | Un establecimiento con básica regular, con tier, puntaje, canal y estado CRM |
| `redes` | 325 | slug del RUT | Sostenedores con 3+ establecimientos: 1 reunión = N colegios |
| `cuentas` | 24 | slug del nombre | Las cuentas de cabecera con correo y teléfono |
| `meta` | 1 | `carga` | Fuente, fecha de corte y totales |

### Paso 1 — crear la base (una sola vez, manual)

Firestore todavía no está aprovisionado en el proyecto. Ábrelo y dale a **Crear base de datos**:

    https://console.firebase.google.com/project/jmventas-aab3c/firestore

Modo de producción, región **southamerica-west1** (Santiago — la latencia importa si el equipo comercial va a usar esto a diario).

### Paso 2 — cargar

```bash
cd firebase
npm install
python3 transformar.py        # CSV -> NDJSON tipado, revisa antes de escribir
node cargar.mjs --dry-run     # muestra qué se escribiría, sin tocar la nube
node cargar.mjs --admin       # carga real
node verificar.mjs --admin    # cuenta lo que quedó y muestra el top
```

`--admin` necesita un service account: en la consola, **Configuración → Cuentas de servicio → Generar nueva clave privada**, y guárdalo como `firebase/serviceAccount.json`. Está en `.gitignore` — esa clave da acceso total al proyecto saltándose las reglas, así que nunca va al repo.

**Sin service account** puedes cargar con el SDK web (`node cargar.mjs`), pero entonces las reglas tienen que permitir escritura: aplica el bloque "modo carga" de `firebase/firestore.rules`, carga, y vuelve a dejar las de producción. Mientras ese modo esté activo cualquiera con la apiKey —que es pública— puede escribir y borrar. Prefiere `--admin`.

La carga es idempotente: escribe con `merge` y el ID es el RBD, así que se puede repetir sin duplicar. Son ~8.200 escrituras, dentro de las 20.000/día del plan Spark.

### Paso 3 — reglas e índices

```bash
npx firebase-tools deploy --only firestore:rules,firestore:indexes --project jmventas-aab3c
```

Las reglas de producción exigen usuario autenticado y sólo dejan editar los campos de gestión (`estadoCrm`, `email`, `telefono`, `contacto`, `notas`…). El resto viene del directorio MINEDUC y se reescribe en cada carga: editarlo a mano sólo genera divergencia.

Sobre la apiKey del `firebaseConfig`: es pública por diseño, viaja en el bundle de cualquier app web de Firebase. Lo que protege los datos son las reglas, no ocultar la clave.

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
