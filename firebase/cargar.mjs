#!/usr/bin/env node
// ============================================================
// JUMP Math Chile - Carga la base de prospectos en Firestore
//
//   node firebase/cargar.mjs --dry-run          revisa sin escribir
//   node firebase/cargar.mjs                    carga todo
//   node firebase/cargar.mjs --coleccion cuentas
//   node firebase/cargar.mjs --admin            usa serviceAccount.json
//
// Por defecto usa el SDK web con la config del proyecto, lo que exige
// que las reglas permitan escritura (ver firestore.rules, "modo carga").
// Con --admin escribe con credenciales de servicio y saltandose las
// reglas: es la via recomendada para la carga masiva.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { firebaseConfig, comprobarFirestore, CONSOLA_FIRESTORE } from './config.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(AQUI, 'data');
const LOTE = 500;                 // maximo de operaciones por batch en Firestore

const COLECCIONES = [
  { nombre: 'prospectos', archivo: 'prospectos.ndjson' },
  { nombre: 'redes', archivo: 'redes.ndjson' },
  { nombre: 'cuentas', archivo: 'cuentas.ndjson' },
  { nombre: 'meta', archivo: 'meta.json' },
];

// ---------- argumentos ----------
const argv = process.argv.slice(2);
const tiene = (f) => argv.includes(f);
const valor = (f, def = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const DRY = tiene('--dry-run');
const ADMIN = tiene('--admin');
const SOLO = valor('--coleccion');

// ---------- lectura ----------
async function leerNdjson(archivo) {
  const ruta = path.join(DATA, archivo);
  if (!fs.existsSync(ruta)) {
    throw new Error(`Falta ${ruta}. Corre primero: python3 firebase/transformar.py`);
  }
  const corrupto = (detalle) => new Error(
    `${archivo} está incompleto o corrupto (${detalle}).\n`
    + '  Suele pasar si el disco se llenó a media escritura.\n'
    + '  Libera espacio y regenera:  python3 firebase/transformar.py');

  if (archivo.endsWith('.json')) {
    try {
      return [JSON.parse(fs.readFileSync(ruta, 'utf8'))];
    } catch (e) {
      throw corrupto(e.message);
    }
  }

  const docs = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(ruta, 'utf8'),
    crlfDelay: Infinity,
  });
  let n = 0;
  for await (const linea of rl) {
    n += 1;
    const l = linea.trim();
    if (!l) continue;
    try {
      docs.push(JSON.parse(l));
    } catch (e) {
      throw corrupto(`línea ${n}: ${e.message}`);
    }
  }
  return docs;
}

// Convierte {lat,lon} en GeoPoint y descarta claves internas.
function prepararDoc(doc, GeoPoint, marcaTiempo) {
  const { _id, ...resto } = doc;
  if (resto.geo && typeof resto.geo === 'object') {
    resto.geo = new GeoPoint(resto.geo.lat, resto.geo.lon);
  }
  resto.actualizado = marcaTiempo;
  return { id: String(_id), datos: resto };
}

// ---------- backends ----------
async function backendAdmin() {
  const { initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore, GeoPoint, FieldValue } = await import('firebase-admin/firestore');

  const local = path.join(AQUI, 'serviceAccount.json');
  const credencial = fs.existsSync(local)
    ? cert(JSON.parse(fs.readFileSync(local, 'utf8')))
    : applicationDefault();

  initializeApp({ credential: credencial, projectId: firebaseConfig.projectId });
  const db = getFirestore();
  return {
    etiqueta: fs.existsSync(local) ? 'admin (serviceAccount.json)' : 'admin (ADC)',
    db, GeoPoint,
    marcaTiempo: FieldValue.serverTimestamp(),
    batch: () => {
      const b = db.batch();
      return {
        set: (col, id, datos) => b.set(db.collection(col).doc(id), datos, { merge: true }),
        commit: () => b.commit(),
      };
    },
  };
}

async function backendWeb() {
  const { initializeApp } = await import('firebase/app');
  const {
    getFirestore, doc, writeBatch, GeoPoint, serverTimestamp,
  } = await import('firebase/firestore');

  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  return {
    etiqueta: 'web SDK (requiere reglas en modo carga)',
    db, GeoPoint,
    marcaTiempo: serverTimestamp(),
    batch: () => {
      const b = writeBatch(db);
      return {
        set: (col, id, datos) => b.set(doc(db, col, id), datos, { merge: true }),
        commit: () => b.commit(),
      };
    },
  };
}

// ---------- escritura ----------
async function cargarColeccion(be, nombre, docs) {
  const preparados = docs.map((d) => prepararDoc(d, be.GeoPoint, be.marcaTiempo));
  let escritos = 0;

  for (let i = 0; i < preparados.length; i += LOTE) {
    const trozo = preparados.slice(i, i + LOTE);
    const b = be.batch();
    for (const { id, datos } of trozo) b.set(nombre, id, datos);

    let intento = 0;
    for (;;) {
      try {
        await b.commit();
        break;
      } catch (e) {
        // Los errores de cuota y de red se reintentan; los de permiso no.
        const permiso = /permission|PERMISSION_DENIED|insufficient/i.test(e.message || '');
        if (permiso || ++intento > 4) throw e;
        const espera = 2 ** intento * 1000;
        process.stdout.write(`\n    reintento ${intento} en ${espera / 1000}s (${e.message})`);
        await new Promise((r) => setTimeout(r, espera));
      }
    }
    escritos += trozo.length;
    process.stdout.write(`\r  ${nombre}: ${escritos}/${preparados.length}   `);
  }
  process.stdout.write(`\r  ${nombre}: ${escritos}/${preparados.length} listo\n`);
  return escritos;
}

// ---------- main ----------
async function main() {
  const objetivo = SOLO ? COLECCIONES.filter((c) => c.nombre === SOLO) : COLECCIONES;
  if (!objetivo.length) {
    console.error(`Colección desconocida: ${SOLO}`);
    console.error(`Disponibles: ${COLECCIONES.map((c) => c.nombre).join(', ')}`);
    process.exit(1);
  }

  console.log(`Proyecto: ${firebaseConfig.projectId}`);

  const cargas = [];
  let total = 0;
  for (const c of objetivo) {
    const docs = await leerNdjson(c.archivo);
    cargas.push({ ...c, docs });
    total += docs.length;
    console.log(`  ${c.nombre}: ${docs.length} documentos`);
  }
  console.log(`  total: ${total}`);

  if (DRY) {
    console.log('\n--dry-run: no se escribió nada.');
    console.log('Muestra del primer documento de cada colección:\n');
    for (const c of cargas) {
      console.log(`--- ${c.nombre} ---`);
      console.log(JSON.stringify(c.docs[0], null, 2).slice(0, 600));
    }
    return;
  }

  await comprobarFirestore({ admin: ADMIN });

  const be = ADMIN ? await backendAdmin() : await backendWeb();
  console.log(`Backend: ${be.etiqueta}\n`);

  const t0 = Date.now();
  let escritos = 0;
  for (const c of cargas) escritos += await cargarColeccion(be, c.nombre, c.docs);

  const seg = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nListo: ${escritos} documentos en ${seg}s.`);
  console.log('Si cargaste con el SDK web, vuelve a dejar firestore.rules en modo producción.');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nError: ${e.message}`);
  if (/permission|PERMISSION_DENIED/i.test(e.message)) {
    console.error('\nLas reglas están bloqueando la escritura. Opciones:');
    console.error('  1) node firebase/cargar.mjs --admin   (con serviceAccount.json)');
    console.error('  2) aplicar el "modo carga" de firebase/firestore.rules');
  }
  process.exit(1);
});
