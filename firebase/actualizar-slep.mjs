// ============================================================
// Re-etiqueta los colegios traspasados a un SLEP
//
// El directorio MINEDUC que alimenta la base es la foto de 2025. El 1 de
// enero de 2026, diez Servicios Locales asumieron 827 establecimientos
// que hasta entonces administraba un DAEM. En la base siguen figurando
// como "Municipal/DAEM", y eso importa por tres razones:
//
//   - cambia quién compra: decide el director del SLEP, no el alcalde;
//   - cambia el canal, y con él el guion de la conversación;
//   - el correo del DAEM puede estar muerto, o sea rebote.
//
// El mapa de comunas vive en datos/slep-2026.csv, con su fuente por fila,
// porque es un dato que se verifica leyendo y no deduciendo: el SLEP
// "Los Álamos" administra comunas del Maule y no la comuna homónima del
// Biobío, que se traspasa recién en 2027.
//
// Uso:
//   node firebase/actualizar-slep.mjs --admin              # sólo informa
//   node firebase/actualizar-slep.mjs --admin --aplicar    # escribe
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firebaseConfig } from './config.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.dirname(AQUI);
const LOTE = 400;

const argv = process.argv.slice(2);
const tiene = (f) => argv.includes(f);
const valor = (f, def) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ADMIN = tiene('--admin');
const APLICAR = tiene('--aplicar');
const CSV = valor('--csv', 'datos/slep-2026.csv');

/* Los nombres de comuna llegan en mayúsculas, con tildes y a veces con
   guiones distintos: se comparan sin nada de eso. */
const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^A-Z0-9]/g, '');

function leerMapa(ruta) {
  const lineas = fs.readFileSync(ruta, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
  const cab = lineas.shift().split(';');
  const iSlep = cab.indexOf('SLEP');
  const iCom = cab.indexOf('COMUNA');
  const mapa = new Map();
  for (const l of lineas) {
    const c = l.split(';');
    if (!c[iCom]) continue;
    mapa.set(norm(c[iCom]), { slep: c[iSlep], comuna: c[iCom] });
  }
  return mapa;
}

async function conectar() {
  if (!ADMIN) {
    throw new Error('Este script escribe campos oficiales, que las reglas '
      + 'reservan al Admin SDK. Ejecuta con --admin.');
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

async function main() {
  const ruta = path.isAbsolute(CSV) ? CSV : path.join(RAIZ, CSV);
  if (!fs.existsSync(ruta)) throw new Error(`No existe ${ruta}`);
  const mapa = leerMapa(ruta);
  console.log(`Mapa: ${mapa.size} comunas traspasadas en ${
    new Set([...mapa.values()].map((v) => v.slep)).size} servicios locales.`);

  const { db, marca } = await conectar();
  console.log('Leyendo los municipales de la base…');
  const snap = await db.collection('prospectos')
    .where('dependencia', '==', 'Municipal/DAEM').get();
  console.log(`  ${snap.size} establecimientos municipales en Firestore.`);

  const porSlep = new Map();
  const cambios = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    const hallado = mapa.get(norm(d.comuna));
    if (!hallado) continue;
    cambios.push({ id: doc.id, slep: hallado.slep, nombre: d.establecimiento, comuna: d.comuna });
    porSlep.set(hallado.slep, (porSlep.get(hallado.slep) || 0) + 1);
  }

  console.log('\nColegios a re-etiquetar como SLEP:');
  for (const [slep, n] of [...porSlep].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  SLEP ${slep}`);
  }
  console.log(`  ----\n  ${String(cambios.length).padStart(4)}  en total`);

  if (!cambios.length) { console.log('\nNada que cambiar.'); return; }
  if (!APLICAR) {
    console.log('\nEsto fue sólo un informe. Para escribirlo:');
    console.log('  node firebase/actualizar-slep.mjs --admin --aplicar');
    console.log('\nEjemplos de lo que cambiaría:');
    for (const c of cambios.slice(0, 5)) {
      console.log(`  ${c.id}  ${c.nombre} (${c.comuna}) → SLEP ${c.slep}`);
    }
    return;
  }

  /* El puntaje y el tier no se tocan: en la fórmula, Municipal y SLEP
     tienen la misma fricción de compra, así que la facilidad de cierre no
     cambia. Lo que cambia es con quién se habla. */
  let hechos = 0;
  for (let i = 0; i < cambios.length; i += LOTE) {
    const b = db.batch();
    for (const c of cambios.slice(i, i + LOTE)) {
      b.set(db.collection('prospectos').doc(c.id), {
        dependencia: 'SLEP',
        canal: 'E · SLEP',
        slep: c.slep,
        traspasoSlep: '2026-01-01',
        actualizado: marca,
      }, { merge: true });
    }
    await b.commit();
    hechos += Math.min(LOTE, cambios.length - i);
    console.log(`  escritos ${hechos}/${cambios.length}`);
  }
  console.log(`\nListo: ${hechos} establecimientos ahora figuran como SLEP.`);
  console.log('El contacto del DAEM puede haber quedado obsoleto: conviene');
  console.log('enviarles en una tanda aparte y mirar el rebote.');
}

main().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
