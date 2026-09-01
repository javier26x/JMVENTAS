// ============================================================
// Rellena a qué buzón se le escribió a cada colegio
//
// La guardia de 30 días deja de aplicar cuando el correo actual es
// distinto del último al que se escribió. Para saberlo, cada envío guarda
// ahora `ultimoCorreo` en el prospecto. Pero los envíos anteriores a ese
// cambio no lo guardaron, y son justo los colegios por los que se pidió
// la regla: "ya les escribí al correo viejo, déjame escribirles al nuevo".
//
// Este script lo reconstruye desde las campañas: cada destinatario que
// salió tiene el correo al que salió y la fecha. Se toma el más reciente
// por RBD y se escribe en el prospecto. Sólo si falta, salvo --forzar.
//
//   node firebase/rellenar-ultimo-correo.mjs --admin            # informa
//   node firebase/rellenar-ultimo-correo.mjs --admin --aplicar  # escribe
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firebaseConfig } from './config.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const tiene = (f) => args.includes(f);

// Un destinatario en estos estados recibió el correo, o al menos salió.
// "pendiente" y "error" no: a esos no se les escribió a ninguna parte.
const SALIO = new Set(['enviado', 'abierto', 'respondido', 'rebotado', 'baja']);

async function conectar() {
  if (!tiene('--admin')) {
    throw new Error('Escribe en prospectos con credenciales de servicio. Ejecuta con --admin.');
  }
  const { initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const local = path.join(AQUI, 'serviceAccount.json');
  initializeApp({
    credential: fs.existsSync(local)
      ? cert(JSON.parse(fs.readFileSync(local, 'utf8')))
      : applicationDefault(),
    projectId: firebaseConfig.projectId,
  });
  return getFirestore();
}

async function main() {
  const db = await conectar();
  const aplicar = tiene('--aplicar');
  const forzar = tiene('--forzar');

  // El último buzón por RBD, mirando todas las campañas.
  const ultimo = new Map();   // rbd -> { correo, cuando, campana }
  const campanas = await db.collection('campanas').get();
  console.log(`${campanas.size} campañas`);
  for (const c of campanas.docs) {
    const dest = await c.ref.collection('destinatarios').get();
    for (const d of dest.docs) {
      if (!SALIO.has(d.get('estado'))) continue;
      const correo = String(d.get('email') || '').trim().toLowerCase();
      if (!correo) continue;
      const cuando = d.get('enviadoEn')?.toMillis?.() || 0;
      const previo = ultimo.get(d.id);
      if (!previo || cuando > previo.cuando) {
        ultimo.set(d.id, { correo, cuando, campana: c.get('nombre') || c.id });
      }
    }
  }
  console.log(`${ultimo.size} colegios con al menos un envío registrado`);
  if (!ultimo.size) return;

  let escritos = 0;
  let saltados = 0;
  let sinProspecto = 0;
  const lote = [];
  for (const [rbd, u] of ultimo) {
    const ref = db.doc(`prospectos/${rbd}`);
    const snap = await ref.get();
    if (!snap.exists) { sinProspecto += 1; continue; }
    if (snap.get('ultimoCorreo') && !forzar) { saltados += 1; continue; }
    lote.push({ ref, rbd, ...u });
  }

  console.log(`\n${lote.length} por escribir · ${saltados} ya tenían buzón · ${sinProspecto} sin prospecto`);
  for (const x of lote.slice(0, 8)) {
    console.log(`  RBD ${x.rbd.padEnd(6)} ${x.correo}  (${x.campana})`);
  }
  if (lote.length > 8) console.log(`  … y ${lote.length - 8} más`);

  if (!aplicar) {
    console.log('\nSólo informe. Para escribir:');
    console.log('  node firebase/rellenar-ultimo-correo.mjs --admin --aplicar');
    return;
  }

  // update y no set: si el prospecto no existe no hay que inventarlo, y
  // ya se filtró arriba; acá sólo se tocan los que están.
  for (let i = 0; i < lote.length; i += 400) {
    const b = db.batch();
    for (const x of lote.slice(i, i + 400)) {
      b.update(x.ref, { ultimoCorreo: x.correo });
      escritos += 1;
    }
    await b.commit();
  }
  console.log(`\nListo: ${escritos} prospectos con su buzón anterior registrado.`);
  console.log('Desde ahora, un correo distinto al de ese registro vuelve a entrar en el segmento.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
