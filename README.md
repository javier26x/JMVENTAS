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
web/                                                CRM web sobre Firebase Hosting
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
cd ~/JMVENTAS
npx firebase-tools deploy --only firestore:rules,firestore:indexes --project jmventas-aab3c
```

Las reglas de producción exigen usuario autenticado y sólo dejan editar los campos de gestión (`estadoCrm`, `email`, `telefono`, `contacto`, `notas`…). El resto viene del directorio MINEDUC y se reescribe en cada carga: editarlo a mano sólo genera divergencia.

Sobre la apiKey del `firebaseConfig`: es pública por diseño, viaja en el bundle de cualquier app web de Firebase. Lo que protege los datos son las reglas, no ocultar la clave.

### Paso 4 — la app web

CRM para el equipo comercial: KPIs, filtros y tabla sobre las tres colecciones, con edición del estado de cada cuenta.

**Antes de desplegar**, habilita el proveedor de Google — las reglas exigen usuario autenticado y sin esto nadie entra:

Firebase Console → **Authentication → Sign-in method → Google → Habilitar**

```bash
cd ~/JMVENTAS
npx firebase-tools deploy --only hosting --project jmventas-aab3c
```

Queda en `https://jmventas-aab3c.web.app`.

Qué trae:

| | |
|---|---|
| **Cuentas** | Las 24 de cabecera, ordenadas por prioridad, con correo y teléfono clicables |
| **Redes** | Los 325 sostenedores con 3+ colegios, por matrícula |
| **Prospectos** | Los 7.808, paginados de a 300 desde el servidor |
| **Buscador** | Por palabra suelta (`tokens`), así "george" encuentra "Colegio Saint George's" |
| **Filtros** | Tier, canal, región, requisito ATE y estado, en una sola fila |
| **Estado** | Editable en línea; escribe a Firestore al instante |

Detalles que importan para el uso diario:

- **El filtro más selectivo se resuelve en el servidor y el resto en el cliente.** Firestore necesita un índice por cada combinación de filtros; en vez de declarar esa explosión, la app manda uno solo y afina sobre la página traída. Por eso el contador dice "N de M revisados": M es lo que se bajó, no la base entera. "Cargar más" trae la siguiente página.
- **Los tiers usan una rampa ordinal de un solo hue** (más difícil = más oscuro), validada en claro y oscuro. El requisito ATE va con icono y texto, nunca color solo.
- **Sólo se pueden editar los campos de gestión.** Si intentas cambiar otra cosa, las reglas lo rechazan y la app revierte el control.
- Si una consulta necesita un índice que falta, Firestore devuelve el enlace para crearlo y la app lo muestra clicable.

## Empezar

```bash
pip install --break-system-packages pandas openpyxl requests beautifulsoup4

# ver los cortes de la base
python3 scripts/analizar-base.py

# ver a quién llamar primero
column -s, -t datos/contactos-verificados.csv | less -S
```

## Conseguir los correos de los colegios

Tres fuentes, en este orden. Las dos primeras son gratis y oficiales; la tercera es la que cuesta tiempo.

### 1. Nóminas oficiales de Ayuda MINEDUC (empieza por acá)

MINEDUC publica nóminas regionales en PDF con **RBD, teléfono y correo** por establecimiento. Son oficiales, gratuitas y no requieren raspar nada.

```bash
pip install --break-system-packages requests pypdf
sudo apt-get install -y poppler-utils          # opcional, mejora el parseo

python3 scripts/cosechar-oficiales.py --listar   # ver qué archivos existen hoy
python3 scripts/cosechar-oficiales.py            # descargar y parsear
node firebase/actualizar-contactos.mjs --admin --csv datos/contactos-oficiales.csv
```

El script prueba ~90 nombres de archivo candidatos (16 regiones × varias convenciones, porque MINEDUC los publica con plantillas distintas cada año) y reporta cuáles resolvieron. Deja `datos/contactos-oficiales.csv` con RBD, correo, teléfono y de qué archivo salió cada dato.

### 2. Registro de correos de sostenedores (Superintendencia)

`supereduc.cl/sostenedores-habilitados/` publica el **Registro de Correos Electrónicos de Sostenedores** por RUT. Para la estrategia de redes esto vale más que el correo del colegio: un sostenedor es quien decide por sus 8, 17 u 83 establecimientos. Se cruza con la columna `RUT_SOSTENEDOR`.

### 3. Raspado de los sitios propios (lo que falte)

```bash
python3 scripts/enriquecer-contactos.py --csv datos/prospectos_jumpmath.csv \
  --tier "1 · FACIL" --canal "A · Directo Privado" --limite 250
node firebase/actualizar-contactos.mjs --admin --csv datos/prospectos_jumpmath.csv
```

### 4. Base de correos por establecimiento

Si consigues una planilla con varios correos por RBD ya clasificados (casilla del colegio, dominio del sostenedor, correo personal), entra por otra puerta: `agregar-colegios.mjs`, que además **crea** los establecimientos que la base de prospección no tiene.

El CSV se espera con una fila por correo y estas columnas:

```
rbd,correo,tipo,nombre,comuna,dependencia,matricula,rut_sostenedor,telefono,director
```

`tipo` es `colegio`, `red`, `personal` o `dudoso`. Los `dudoso` se descartan; del resto se guardan hasta tres direcciones por colegio, la mejor primero, porque **sólo la primera recibe la campaña**.

```bash
# El nombre importa: .gitignore tiene que cubrirlo o el cargador se niega.
mv ~/descargas/correosclasificados.csv datos/correos-clasificados.csv

node firebase/agregar-colegios.mjs --admin --csv datos/correos-clasificados.csv --dry-run
node firebase/agregar-colegios.mjs --admin --csv datos/correos-clasificados.csv
```

Qué hace con cada RBD:

- **Ya está en la base** → le suma las direcciones que le faltan. No pisa lo escrito a mano, y no mueve del primer puesto un correo institucional que ya se estaba usando: sólo lo desplaza uno de mejor clase, como cuando había un gmail y aparece la casilla del colegio.
- **No está** → lo crea, marcado en `nivel` con lo que imparte: `especial`, `parvularia`, `media`, `adultos`, `sinmatricula` o `revisar`.

Ese marcado no es cosmético. La base de prospección son los **colegios con básica regular**, que son los que pueden usar JUMP Math de 1º a 8º; un jardín infantil o un liceo industrial no compran el programa, y mezclados sin marca contaminan cada segmento de campaña. Los agregados quedan sin tier, sin puntaje y con matrícula de básica en cero, así que caen al final de toda lista ordenada y no compiten con los prospectos reales. En el CRM se filtran con **Nivel**, y el panel los cuenta aparte.

`revisar` es el que vale la pena mirar: son escuelas con matrícula que parecen básica y que la base no tenía.

Para cargar sólo una parte:

```bash
# sólo completar los que ya están, sin crear ninguno
node firebase/agregar-colegios.mjs --admin --csv datos/correos-clasificados.csv --solo-existentes

# crear únicamente los dudosos de clasificar
node firebase/agregar-colegios.mjs --admin --csv datos/correos-clasificados.csv --niveles revisar
```

### Qué esperar de verdad

**Ninguna fuente pública trae los 7.808 correos, y las que cubren casi todo lo hacen con calidad despareja**: en la base de correos por establecimiento, cerca de un tercio de los colegios sólo tiene una casilla de gmail o hotmail. Sirve para llegar, no para dar por verificado. La cobertura realista por segmento, cuando se raspa colegio por colegio:

| Segmento | EE | Expectativa | Por qué |
|---|---:|---|---|
| Particular pagado | 499 | Casi total | Todos tienen sitio y correo de admisión público |
| Particular subvencionado | 3.077 | Alta | La mayoría tiene sitio; muchos salen en las nóminas MINEDUC |
| Municipal urbano y SLEP | ~1.500 | Media | Muchos no tienen sitio propio; el contacto real es el DAEM o el SLEP |
| Municipal rural | ~2.700 | Baja | Escuelas de 20-80 alumnos, sin sitio ni correo publicado |

Para las ~2.700 rurales el correo del establecimiento no es el camino: **se venden por sostenedor**, y ahí el contacto es el DAEM o el SLEP, que sí es público. Perseguir esos correos uno a uno es trabajo perdido — un municipio con 30 escuelas rurales es un solo contrato.

`actualizar-contactos.mjs` nunca pisa un contacto ya verificado a mano con uno cosechado, y marca `estadoCrm` como `contacto_ok` cuando aparece un correo nuevo, así el CRM refleja el avance. Ojo: por lo mismo, **salta el colegio que ya tiene correo**. Para corregir una cosecha anterior con datos mejores hay que pasarle `--forzar`, que respeta igual lo marcado como «A mano».

Los CSV con correos de personas nunca van al repositorio: `.gitignore` cubre `datos/*contact*.csv`, `*correo*.csv`, `*clasificad*.csv` y `*directorio*.csv`, y `agregar-colegios.mjs` se niega a leer un archivo que git no esté ignorando.

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

## Habilitar el envío de correo

El código está desplegado, pero enviar por Gmail requiere tres cosas en Google Cloud que no se configuran solas.

### 1. Habilitar la API de Gmail

```bash
gcloud services enable gmail.googleapis.com --project jmventas-aab3c
```

### 2. Declarar los permisos en la pantalla de consentimiento

Console → **APIs y servicios → Pantalla de consentimiento OAuth** → agregar:

| Permiso | Nivel según Google | Para qué |
|---|---|---|
| `.../auth/gmail.send` | Sensible | Enviar los correos |
| `.../auth/gmail.readonly` | **Restringido** | Detectar respuestas y rebotes |

La diferencia importa. Un permiso **restringido** en una app de tipo *External* publicada obliga a una auditoría de seguridad CASA, que cuesta dinero y semanas. Hay dos formas de evitarla:

- **Cuenta Google Workspace** → tipo de usuario **Internal**. Sin verificación, sin advertencias, sin límite de usuarios. Es la opción correcta si JUMP Math tiene dominio propio.
- **Cuenta @gmail.com corriente** → dejar la app en **Testing** y agregar las cuentas del equipo como *usuarios de prueba*. Funciona hasta 100 usuarios, con una pantalla de advertencia al conectar. Suficiente para un equipo comercial.

Si ninguna de las dos calza, el botón **"Solo enviar"** conecta pidiendo únicamente `gmail.send`, que es sensible y no restringido. Se pierde la detección automática de respuestas —hay que mirarlas en la bandeja— pero el envío funciona sin trámite.

### 3. Habilitar el proveedor Google

Console de Firebase → **Authentication → Sign-in method → Google → Habilitar**. Sin esto nadie entra a la app, ni siquiera a ver la base.

### Límites de envío

| Cuenta | Correos por día |
|---|---:|
| Gmail personal | 500 |
| Workspace | 2.000 |

La app corta en 450 por tanda y deja el resto pendiente, reanudable desde el detalle de la campaña.

## Lo que falta

- **Cruce con SIMCE Matemática y Categoría de Desempeño** (`informacionestadistica.agenciaeducacion.cl`). Convierte la base en "colegios con problema de matemática documentado" y es lo que más sube la tasa de respuesta.
- **Nombre y cargo de la contraparte en Cognita.** La cuenta ya tiene teléfono y correo corporativo, pero falta identificar al director académico regional LatAm — el que realmente decide sobre 21 colegios.
- Enriquecimiento del Tier 1 completo (351 registros): hoy hay 24 cuentas de cabecera de 351.
- Contacto de los 36 SLEP. Sólo 5 están identificados y 3 con confianza baja: los cargos de director ejecutivo rotan y hay que sacarlos de `dep.gob.cl`.
