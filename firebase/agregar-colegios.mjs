#!/usr/bin/env node
// ============================================================
// Agrega colegios a la base desde un CSV de correos clasificados.
//
// El CSV trae una fila por correo, no por colegio: el mismo RBD aparece
// varias veces con direcciones de distinta calidad, ya clasificadas:
//
//   colegio    casilla institucional del establecimiento
//   red        dominio del sostenedor o del SLEP (una persona con cargo)
//   personal   gmail/hotmail de alguien del colegio
//   dudoso     relleno: "notiene@notiene.cl", "xxx@gmail.com"
//
// Qué hace con cada RBD:
//   ya está en la base  ->  le suma las direcciones que le faltan, sin
//                           pisar lo escrito a mano y sin degradar el
//                           correo que ya se estaba usando
//   no está             ->  lo crea, marcado con el nivel que imparte
//
// El "no está" son ~4.100 establecimientos que la base de prospección
// dejó fuera a propósito: sólo entraban los que imparten básica regular.
// Se agregan porque se pidieron, pero marcados: un jardín infantil y un
// liceo industrial no compran un programa de matemática de 1º a 8º, y
// mezclados sin marca contaminarían cada segmento de campaña.
//
//   node firebase/agregar-colegios.mjs --admin --csv datos/correos.csv --dry-run
//   node firebase/agregar-colegios.mjs --admin --csv datos/correos.csv
//   node firebase/agregar-colegios.mjs --admin --csv ... --solo-existentes
//   node firebase/agregar-colegios.mjs --admin --csv ... --niveles especial,revisar
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { firebaseConfig, comprobarFirestore } from './config.mjs';
import { leerCsv } from './csv.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.dirname(AQUI);
const LOTE = 400;
const MAX_CORREOS = 3;

const argv = process.argv.slice(2);
const tiene = (f) => argv.includes(f);
const valor = (f, def = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ADMIN = tiene('--admin');
const DRY = tiene('--dry-run');
const SOLO_EXISTENTES = tiene('--solo-existentes');
const CSV = valor('--csv', 'datos/correos-clasificados.csv');
const FUENTE = valor('--fuente', 'directorio');
const NIVELES = String(valor('--niveles', '') || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// ---------- correos ----------
const RE_MAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
// Dominios de correo gratuito: la dirección es real, pero no acredita
// nada. Si el colegio tiene casilla propia, esa va primero.
const LIBRES = ['gmail.', 'googlemail.', 'hotmail.', 'outlook.', 'live.',
  'yahoo.', 'ymail.', 'msn.', 'terra.', 'vtr.net', 'icloud.', 'me.com',
  'aol.', 'zoho.', 'protonmail.', 'proton.me'];
// Buzones que existen y nunca compran: no deben quedar de primeros.
const ROLES_MALOS = ['centrodealumnos', 'centro.alumnos', 'centroalumnos',
  'ceal', 'alumnos', 'apoderados', 'centropadres', 'biblioteca',
  'convivencia', 'enfermeria', 'psicologa', 'psicologo'];
/* Relleno que alguien escribió para poder guardar el formulario. La
   variante del dominio es más estrecha a propósito: "x+" o "na" delante
   de un punto son un dominio corto perfectamente real, y descartar un
   colegio entero por su dominio es un error caro. */
const RE_RELLENO = /^(no ?tiene|no ?posee|sin ?correo|x+|no ?se|nose|nn|test|prueba|aaa+|ninguno|na)$/;
const RE_RELLENO_DOMINIO = /^(no ?tiene|no ?posee|sin ?correo|no ?se|nose|ninguno)$/;

const libre = (correo) => {
  const dominio = correo.split('@')[1] || '';
  return LIBRES.some((d) => dominio.startsWith(d));
};

function correoValido(bruto) {
  const c = String(bruto || '').trim().toLowerCase();
  if (!RE_MAIL.test(c)) return '';
  const [local, dominio] = c.split('@');
  if (RE_RELLENO.test(local) || RE_RELLENO_DOMINIO.test(dominio.split('.')[0])) return '';
  // Un "correo" que termina en extensión de archivo salió de raspar un
  // <img src>, no de una persona.
  if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|pdf)$/.test(dominio)) return '';
  return c;
}

/* De qué clase es una dirección. Es lo único que puede mover a un correo
   del primer puesto, y el primer puesto es el que recibe la campaña.
   Grueso a propósito: entre dos casillas institucionales no hay forma de
   saber cuál contesta mejor, y cambiar el destinatario de un colegio al
   que ya se le escribe, por una corazonada de puntaje, es peor que
   dejarlo como está. */
function clase(correo, tipo) {
  if (String(tipo || '').toLowerCase() === 'dudoso') return -1;
  const local = correo.split('@')[0].replace(/[^a-z]/g, '');
  const rolMalo = ROLES_MALOS.some((r) => local.includes(r.replace(/[^a-z]/g, '')));
  if (libre(correo)) return rolMalo ? 0 : 1;
  return rolMalo ? 2 : 3;
}

/* Dentro de una misma clase, para ordenar entre las que llegan nuevas:
   la casilla del establecimiento antes que la de una persona del
   sostenedor, y ésa antes que un correo gratuito. */
function calidad(correo, tipo) {
  const t = String(tipo || '').toLowerCase();
  if (t === 'dudoso') return -1;
  let n = { colegio: 40, red: 25, personal: 10 }[t];
  if (n === undefined) n = libre(correo) ? 10 : 30;   // dirección ya en la base, sin clasificar
  if (!libre(correo)) n += 5;
  return n;
}

/* Une la lista que ya está en la base con la del CSV, mejor primero.
   Dentro de la misma clase gana el que ya estaba: si el equipo lleva tres
   campañas escribiéndole a una casilla, moverla al segundo lugar cambia
   el destinatario sin que nadie lo haya pedido. Sólo la desplaza una
   dirección de clase superior: un gmail cede ante la casilla del colegio,
   y ahí el cambio sí vale lo que cuesta. */
function fusionarCorreos(existentes, entrantes) {
  const vistos = new Map();
  const anotar = (bruto, tipo, orden, viejo) => {
    const limpio = correoValido(bruto);
    if (!limpio) return;
    const cl = clase(limpio, tipo);
    if (cl < 0) return;
    const previo = vistos.get(limpio);
    if (previo) {
      previo.clase = Math.max(previo.clase, cl);
      previo.puntos = Math.max(previo.puntos, calidad(limpio, tipo));
      return;
    }
    vistos.set(limpio, {
      correo: limpio, clase: cl, puntos: calidad(limpio, tipo), orden, viejo,
    });
  };
  existentes.forEach((c, i) => anotar(c, '', i, true));
  entrantes.forEach((e, i) => anotar(e.correo, e.tipo, existentes.length + i, false));
  return [...vistos.values()]
    .sort((a, b) => b.clase - a.clase
      || Number(b.viejo) - Number(a.viejo)
      || b.puntos - a.puntos
      || a.orden - b.orden)
    .slice(0, MAX_CORREOS);
}

// ---------- teléfonos ----------
function telefonoValido(bruto) {
  const t = String(bruto || '').trim();
  const digitos = t.replace(/\D/g, '');
  if (digitos.length < 6 || digitos.length > 15) return '';
  if (/^0+$/.test(digitos)) return '';
  return t;
}

// ---------- nivel ----------
/* Qué imparte el establecimiento, deducido del nombre y la matrícula.
   La base de prospección sólo trae los que imparten básica regular; todo
   lo que llega de más cae en una de estas categorías y se marca, para
   que nadie arme una campaña de matemática de básica dirigida a salas
   cuna. `revisar` es el bucket honesto: parece básica y no estaba. */
const NIVELES_VALIDOS = ['basica', 'especial', 'parvularia', 'adultos', 'media',
  'sinmatricula', 'revisar'];
const ETIQUETA_NIVEL = {
  basica: 'Básica regular',
  especial: 'Educación especial',
  parvularia: 'Párvulos',
  adultos: 'Adultos',
  media: 'Media / técnico-profesional',
  sinmatricula: 'Sin matrícula',
  revisar: 'Por revisar · parece básica',
};

function nivelDe(nombre, matricula) {
  const n = String(nombre || '').toUpperCase();
  if (/ADULTO|C\.?E\.?I\.?A|NOCTURN|VESPERT/.test(n)) return 'adultos';
  if (/ESPECIAL|ESPEC\.|ESP\.|\bESP\b|DIFERENCIAL|LENGUAJE/.test(n)) return 'especial';
  if (/JARD[IÍ]N|SALA CUNA|PARVUL|INFANTIL/.test(n)) return 'parvularia';
  if (/LICEO|POLIT[EÉ]C|POLIV|COMERCIAL|INDUSTRIAL|INSTITUTO|T[EÉ]CNIC/.test(n)) return 'media';
  if (!(Number(matricula) > 0)) return 'sinmatricula';
  return 'revisar';
}

// ---------- texto ----------
// Mismas reglas que firebase/transformar.py: si divergen, la búsqueda
// encuentra los colegios viejos y no los nuevos.
const VACIAS = new Set(['colegio', 'escuela', 'liceo', 'centro', 'educacional',
  'particular', 'basica', 'del', 'las', 'los', 'san', 'santa', 'the', 'para', 'con']);

const sinTildes = (s) => String(s)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\u0020-\u007e]/g, '');

function slug(s, maxlen = 120) {
  const limpio = sinTildes(s).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return (limpio || 'sin-nombre').slice(0, maxlen);
}

function tokenizar(...textos) {
  const vistos = [];
  for (const t of textos) {
    for (const p of sinTildes(t).toLowerCase().split(/[^a-z0-9]+/)) {
      if (p.length >= 3 && !VACIAS.has(p) && !vistos.includes(p)) vistos.push(p);
    }
  }
  return vistos.slice(0, 25);
}

const normalizar = (s) => sinTildes(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- dependencia y canal ----------
// El CSV escribe la dependencia con otra caja que la base. Dejarla como
// viene parte los filtros en dos: "Particular subvencionado" y
// "Particular Subvencionado" son dos opciones distintas en la pantalla.
const DEPENDENCIA = {
  'particular subvencionado': 'Particular Subvencionado',
  'particular pagado': 'Particular Pagado',
  municipal: 'Municipal/DAEM',
  'municipal/daem': 'Municipal/DAEM',
  slep: 'SLEP',
  'administracion delegada': 'Corp. Adm. Delegada',
  'corp. adm. delegada': 'Corp. Adm. Delegada',
};
/* La región se deduce de la comuna mirando la base, que ya trae las 345.
   Las que faltan son comunas sin ningún colegio de básica: sin esto el
   establecimiento queda con región vacía y el filtro por región no lo
   encuentra nunca. */
const REGION_EXTRA = { antartica: 'MAG' };

const CANAL = {
  'Particular Subvencionado': 'C · PS Individual',
  'Particular Pagado': 'A · Directo Privado',
  'Municipal/DAEM': 'D · Municipal/DAEM',
  SLEP: 'E · SLEP',
  'Corp. Adm. Delegada': 'F · Otro',
};

// ---------- lectura del CSV ----------
function agruparPorRbd(filas) {
  const porRbd = new Map();
  for (const f of filas) {
    const rbd = String(f.RBD || '').trim().replace(/\.0$/, '');
    if (!rbd || !/^\d+$/.test(rbd)) continue;
    let g = porRbd.get(rbd);
    if (!g) {
      g = {
        rbd,
        correos: [],
        nombre: (f.NOMBRE || f.ESTABLECIMIENTO || '').trim(),
        comuna: (f.COMUNA || '').trim(),
        dependencia: (f.DEPENDENCIA || '').trim(),
        matricula: Number(String(f.MATRICULA || '').replace(/\D/g, '')) || 0,
        rutSostenedor: (f.RUT_SOSTENEDOR || '').trim(),
        telefono: '',
        contacto: '',
      };
      porRbd.set(rbd, g);
    }
    if (f.CORREO || f.EMAIL) g.correos.push({ correo: f.CORREO || f.EMAIL, tipo: f.TIPO || '' });
    if (!g.telefono) g.telefono = telefonoValido(f.TELEFONO);
    if (!g.contacto) {
      const d = (f.DIRECTOR || f.CONTACTO || '').trim();
      if (d && !/^sin informaci/i.test(d)) g.contacto = d;
    }
  }
  return porRbd;
}

// ---------- backend ----------
async function backend() {
  if (!ADMIN) {
    throw new Error('Crear prospectos exige credenciales de servicio. Ejecuta con --admin.\n'
      + '  Las reglas niegan `create` a todo cliente: la base no se amplía desde el navegador.');
  }
  const { initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  const local = path.join(AQUI, 'serviceAccount.json');
  initializeApp({
    credential: fs.existsSync(local)
      ? cert(JSON.parse(fs.readFileSync(local, 'utf8')))
      : applicationDefault(),
    projectId: firebaseConfig.projectId,
  });
  const db = getFirestore();
  return { db, marca: FieldValue.serverTimestamp() };
}

/* Toda la base de una vez, y sólo los campos que se van a comparar. Son
   ~7.800 documentos: pedirlos de a 100 por RBD cuesta lo mismo y además
   deja fuera lo que hace falta para el cruce por nombre y para deducir
   la región de una comuna que el CSV no trae. */
async function leerBase(db) {
  const snap = await db.collection('prospectos')
    .select('email', 'telefono', 'contacto', 'contactoFuente', 'estadoCrm',
      'nivel', 'establecimiento', 'comuna', 'region')
    .get();
  const porRbd = new Map();
  const porNombre = new Map();
  const regionDeComuna = new Map();
  for (const d of snap.docs) {
    const x = d.data();
    porRbd.set(d.id, x);
    const clave = `${normalizar(x.establecimiento)}|${normalizar(x.comuna)}`;
    const lista = porNombre.get(clave) || [];
    lista.push(d.id);
    porNombre.set(clave, lista);
    const c = normalizar(x.comuna);
    if (c && x.region && !regionDeComuna.has(c)) regionDeComuna.set(c, x.region);
  }
  return { porRbd, porNombre, regionDeComuna };
}

const partes = (campo) => String(campo || '').split(';').map((s) => s.trim()).filter(Boolean);

/* Este CSV trae 24.000 correos y nombres de directores de colegios de
   todo Chile, y el repositorio es público. Si el archivo cae dentro del
   repo con un nombre que .gitignore no cubre, el próximo `git add -A`
   lo publica y ya no hay forma de recogerlo. Se para antes: cuesta un
   `mv` y evita una filtración irreversible. */
function comprobarQueNoSePublica(ruta) {
  const dentro = path.resolve(ruta).startsWith(`${path.resolve(RAIZ)}${path.sep}`);
  if (!dentro) return;
  try {
    execFileSync('git', ['check-ignore', '-q', ruta], { cwd: RAIZ, stdio: 'ignore' });
    return;                       // salida 0: git lo ignora, va bien
  } catch (e) {
    if (e.status !== 1) return;   // sin git o no es un repo: no hay nada que proteger
  }
  throw new Error(
    `${path.relative(RAIZ, ruta)} está dentro del repositorio y git NO lo ignora.\n`
    + '  Este archivo trae miles de correos y nombres de personas, y el repo es\n'
    + '  público: un `git add` lo publicaría para siempre. Sácalo de aquí o\n'
    + '  dale un nombre que .gitignore cubra, por ejemplo:\n'
    + `    mv ${path.relative(RAIZ, ruta)} datos/correos-clasificados.csv`);
}

/* ---------- la decisión, aparte y sin Firestore ----------
   Estas dos funciones son todo lo que decide qué queda escrito en 12.000
   documentos. Una regla mal puesta acá no da error: deja la base peor y
   nadie se entera hasta que rebota una campaña. Por eso son puras, y por
   eso se prueban una por una. */

/* Qué cambiarle a un colegio que ya está en la base. Devuelve null si no
   hay nada que cambiar, para no gastar una escritura en no hacer nada. */
export function actualizacionDe(g, previo, { fuente = 'directorio', marca = null } = {}) {
  const datos = {};
  // Lo escrito a mano no se toca nunca: es el único dato de la base que
  // salió de una conversación real.
  if (previo.contactoFuente !== 'manual') {
    const fusion = fusionarCorreos(partes(previo.email), g.correos);
    const nuevo = fusion.map((x) => x.correo).join('; ');
    if (nuevo && nuevo !== String(previo.email || '').trim()) {
      datos.email = nuevo;
      /* La marca de origen sigue al correo que se va a usar. Si el
         primero es el que ya estaba, la fuente también: degradar a
         "directorio" un correo que vino de la nómina del MINEDUC borraría
         de la pantalla la única prueba de su procedencia. */
      if (!fusion[0].viejo || !previo.contactoFuente) datos.contactoFuente = fuente;
    }
    if (g.telefono && !String(previo.telefono || '').trim()) datos.telefono = g.telefono;
    if (g.contacto && !String(previo.contacto || '').trim()) datos.contacto = g.contacto;
  }
  /* La base original queda marcada como básica regular: sin eso, "sólo
     básica" en la pantalla dejaría fuera en silencio a los colegios que
     nadie volvió a tocar. Se marca sólo al que no trae nivel: los que
     creó este mismo cargador ya lo tienen, y volver a correrlo los
     convertiría a todos en básica —jardines incluidos— sin avisar. */
  if (!String(previo.nivel || '').trim()) datos.nivel = 'basica';
  const correoFinal = partes(datos.email ?? previo.email)[0] || '';
  if (correoFinal && (previo.estadoCrm || 'nuevo') === 'nuevo') datos.estadoCrm = 'contacto_ok';

  if (!Object.keys(datos).length) return null;
  if (marca) datos.actualizado = marca;
  return datos;
}

/* El documento de un colegio que no estaba. Se arma con el vocabulario de
   la base —misma caja en la dependencia, mismo canal, mismos tokens de
   búsqueda—; si diverge, los filtros se parten en dos y la búsqueda
   encuentra los viejos y no los nuevos. */
export function documentoNuevo(g, { fuente = 'directorio', marca = null, region = '' } = {}) {
  const email = fusionarCorreos([], g.correos).map((x) => x.correo).join('; ');
  const dep = DEPENDENCIA[normalizar(g.dependencia).replace(/\s+/g, ' ')] || g.dependencia || '';
  const datos = {
    rbd: Number(g.rbd),
    establecimiento: g.nombre,
    busqueda: slug(g.nombre, 200).replace(/-/g, ' '),
    tokens: tokenizar(g.nombre, g.comuna),
    comuna: g.comuna,
    region,
    dependencia: dep,
    canal: CANAL[dep] || 'F · Otro',
    requiereAte: dep !== 'Particular Pagado',
    rutSostenedor: g.rutSostenedor,
    /* Sin tier, sin puntaje y con la matrícula de básica en cero. Son los
       tres campos por los que la pantalla ordena y filtra, y ninguno
       significa nada en un jardín infantil: inventarlos los pondría a
       competir con los prospectos reales. Así quedan al final de cada
       lista, y aparecen cuando se les busca por nivel. */
    matBasica: 0,
    matTotal: g.matricula,
    eeEnRed: 1,
    matRed: 0,
    geo: null,
    nivel: nivelDe(g.nombre, g.matricula),
    email,
    telefono: g.telefono,
    contacto: g.contacto,
    web: '',
    busquedaWeb: '',
    contactoFuente: email ? fuente : '',
    estadoCrm: email ? 'contacto_ok' : 'nuevo',
  };
  if (marca) datos.actualizado = marca;
  return datos;
}

// ---------- main ----------
async function main() {
  const ruta = path.isAbsolute(CSV) ? CSV : path.join(RAIZ, CSV);
  if (!fs.existsSync(ruta)) throw new Error(`No existe ${ruta}`);
  comprobarQueNoSePublica(ruta);
  for (const n of NIVELES) {
    if (!NIVELES_VALIDOS.includes(n)) {
      throw new Error(`Nivel desconocido: ${n}\n  Válidos: ${NIVELES_VALIDOS.join(', ')}`);
    }
  }

  const filas = leerCsv(ruta);
  const porRbd = agruparPorRbd(filas);
  console.log(`${path.relative(RAIZ, ruta)}: ${filas.length} filas · ${porRbd.size} colegios`);
  if (!porRbd.size) throw new Error('El CSV no trae ninguna fila con RBD numérico.');

  await comprobarFirestore();
  const { db, marca } = await backend();
  const base = await leerBase(db);
  console.log(`Base actual: ${base.porRbd.size} prospectos\n`);

  const escrituras = [];
  const cuenta = {
    actualizados: 0, sinCambio: 0, creados: 0, omitidos: 0,
    porNombre: 0, marcadosBasica: 0,
  };
  const porNivel = new Map();
  const sinRegion = new Set();
  const ejemplos = { nuevos: [], nombre: [] };

  for (const g of porRbd.values()) {
    // ¿Existe por RBD? Si no, ¿existe por nombre y comuna, y ese otro RBD
    // no viene también en el CSV? Entonces es el mismo colegio con el RBD
    // cambiado, no uno nuevo.
    let id = base.porRbd.has(g.rbd) ? g.rbd : null;
    if (!id) {
      const clave = `${normalizar(g.nombre)}|${normalizar(g.comuna)}`;
      const candidatos = (base.porNombre.get(clave) || []).filter((r) => !porRbd.has(r));
      if (candidatos.length === 1) {
        [id] = candidatos;
        cuenta.porNombre += 1;
        if (ejemplos.nombre.length < 6) ejemplos.nombre.push(`${g.rbd} → ${id}  ${g.nombre}`);
      }
    }

    if (id) {
      const datos = actualizacionDe(g, base.porRbd.get(id), { fuente: FUENTE, marca });
      if (!datos) { cuenta.sinCambio += 1; continue; }
      if (datos.nivel === 'basica') cuenta.marcadosBasica += 1;
      escrituras.push({ id, datos });
      cuenta.actualizados += 1;
      continue;
    }

    // No está en la base: hay que crearlo.
    const nivel = nivelDe(g.nombre, g.matricula);
    porNivel.set(nivel, (porNivel.get(nivel) || 0) + 1);
    if (SOLO_EXISTENTES || (NIVELES.length && !NIVELES.includes(nivel))) {
      cuenta.omitidos += 1;
      continue;
    }
    const comuna = normalizar(g.comuna);
    const region = base.regionDeComuna.get(comuna) || REGION_EXTRA[comuna] || '';
    if (!region) sinRegion.add(g.comuna);
    const datos = documentoNuevo(g, { fuente: FUENTE, marca, region });
    escrituras.push({ id: g.rbd, datos });
    cuenta.creados += 1;
    if (ejemplos.nuevos.length < 8) {
      ejemplos.nuevos.push(`${g.rbd.padEnd(6)} ${ETIQUETA_NIVEL[nivel].padEnd(28)} `
        + `${g.nombre.slice(0, 40).padEnd(42)} ${partes(datos.email)[0] || 'sin correo'}`);
    }
  }

  // ---------- informe ----------
  console.log('Colegios del CSV que ya estaban en la base:');
  console.log(`  ${cuenta.actualizados} reciben datos nuevos`);
  console.log(`  ${cuenta.sinCambio} ya tenían todo`);
  if (cuenta.porNombre) {
    console.log(`  ${cuenta.porNombre} cruzados por nombre y comuna (el RBD no calzaba):`);
    for (const e of ejemplos.nombre) console.log(`      ${e}`);
  }
  if (cuenta.marcadosBasica) {
    console.log(`  ${cuenta.marcadosBasica} quedan marcados como básica regular`);
  }

  console.log('\nColegios del CSV que no estaban en la base, por nivel:');
  for (const n of NIVELES_VALIDOS) {
    if (!porNivel.get(n)) continue;
    const pedido = !SOLO_EXISTENTES && (!NIVELES.length || NIVELES.includes(n));
    console.log(`  ${String(porNivel.get(n)).padStart(5)}  ${ETIQUETA_NIVEL[n].padEnd(30)}`
      + `${pedido ? '' : '  (se omite)'}`);
  }
  if (cuenta.creados) {
    console.log(`\n  Se crean ${cuenta.creados}. Muestra:`);
    for (const e of ejemplos.nuevos) console.log(`      ${e}`);
  }
  if (cuenta.omitidos) console.log(`\n  Se omiten ${cuenta.omitidos}.`);

  if (sinRegion.size) {
    console.log(`\nSin región deducible (${sinRegion.size} comunas): `
      + `${[...sinRegion].join(', ')}\n  El filtro por región no los va a encontrar.`);
  }

  /* Los de la base que el CSV no trae también necesitan la marca de nivel.
     Sin esto, "Sólo básica regular" en la pantalla los dejaría fuera en
     silencio: veinticinco colegios reales invisibles, sin un error, sin
     un aviso, y sin forma de notarlo salvo contando a mano. */
  const faltan = [...base.porRbd.keys()].filter((r) => !porRbd.has(r));
  const porMarcar = faltan.filter((r) => !String(base.porRbd.get(r).nivel || '').trim());
  for (const r of porMarcar) {
    escrituras.push({ id: r, datos: { nivel: 'basica', ...(marca ? { actualizado: marca } : {}) } });
  }
  if (faltan.length) {
    console.log(`\n${faltan.length} colegios de la base no vienen en el CSV: `
      + `conservan lo que ya tenían${porMarcar.length ? `, y ${porMarcar.length} reciben `
        + 'la marca de básica regular' : ''}.`);
  }

  if (DRY) {
    console.log(`\n--dry-run: no se escribió nada. ${escrituras.length} documentos en cola.`);
    return;
  }
  if (!escrituras.length) {
    console.log('\nNada que escribir.');
    return;
  }

  console.log('');
  let hechas = 0;
  for (let i = 0; i < escrituras.length; i += LOTE) {
    const trozo = escrituras.slice(i, i + LOTE);
    const b = db.batch();
    for (const e of trozo) b.set(db.collection('prospectos').doc(e.id), e.datos, { merge: true });
    for (let intento = 0; ; intento += 1) {
      try { await b.commit(); break; } catch (err) {
        if (intento >= 4) throw err;
        const espera = 2 ** (intento + 1) * 1000;
        process.stdout.write(`\n  reintento ${intento + 1} en ${espera / 1000}s (${err.message})`);
        await new Promise((r) => setTimeout(r, espera));
      }
    }
    hechas += trozo.length;
    process.stdout.write(`\r  ${hechas}/${escrituras.length} escritos   `);
  }

  console.log(`\n\nListo: ${cuenta.actualizados} actualizados, ${cuenta.creados} creados.`);
  console.log(`La base queda con ${base.porRbd.size + cuenta.creados} prospectos.`);
  if (cuenta.creados) {
    console.log('Los nuevos aparecen en el CRM con el filtro "Nivel"; van al final de\n'
      + 'cada lista porque no tienen matrícula de básica.');
  }
  process.exit(0);
}

// Se exportan las piezas puras para poder probarlas sin tocar Firestore,
// y sólo se arranca cuando este archivo es el que se ejecutó.
export {
  correoValido, clase, calidad, fusionarCorreos, telefonoValido, nivelDe,
  slug, tokenizar, normalizar, agruparPorRbd, partes,
  ETIQUETA_NIVEL, NIVELES_VALIDOS,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\nError: ${e.message}`);
    if (/permission|PERMISSION_DENIED|insufficient/i.test(e.message)) {
      console.error('\nCon --admin las reglas no aplican, así que esto es de credenciales:');
      console.error('  gcloud auth application-default login');
      console.error('  o deja una clave de servicio en firebase/serviceAccount.json');
    }
    process.exit(1);
  });
}
