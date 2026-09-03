#!/usr/bin/env node
// ============================================================
// Verifica que la carga en Firestore quedó completa y consultable.
//
//   node firebase/verificar.mjs
//   node firebase/verificar.mjs --admin
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { firebaseConfig, comprobarFirestore, CONSOLA_FIRESTORE } from './config.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = process.argv.includes('--admin');

/* Mínimos, no cantidades exactas. `prospectos` es 7.808 mientras la base
   sea sólo la de básica regular; con firebase/agregar-colegios.mjs crece,
   y exigir igualdad convertía cada ampliación en un "FALLA" que no lo es.
   Por debajo del mínimo sí es una carga incompleta. */
const ESPERADO = { prospectos: 7808, redes: 325, cuentas: 24, meta: 1 };

async function conAdmin() {
  const { initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const local = path.join(AQUI, 'serviceAccount.json');
  initializeApp({
    credential: fs.existsSync(local)
      ? cert(JSON.parse(fs.readFileSync(local, 'utf8')))
      : applicationDefault(),
    projectId: firebaseConfig.projectId,
  });
  const db = getFirestore();
  return {
    contar: async (c) => (await db.collection(c).count().get()).data().count,
    top: async (c, campo, n, filtro) => {
      let q = db.collection(c);
      if (filtro) q = q.where(filtro[0], '==', filtro[1]);
      const s = await q.orderBy(campo, 'desc').limit(n).get();
      return s.docs.map((d) => d.data());
    },
  };
}

async function conWeb() {
  const { initializeApp } = await import('firebase/app');
  const {
    getFirestore, collection, getCountFromServer, query, where, orderBy, limit, getDocs,
  } = await import('firebase/firestore');
  const db = getFirestore(initializeApp(firebaseConfig));
  return {
    contar: async (c) => (await getCountFromServer(collection(db, c))).data().count,
    top: async (c, campo, n, filtro) => {
      const partes = [collection(db, c)];
      if (filtro) partes.push(where(filtro[0], '==', filtro[1]));
      partes.push(orderBy(campo, 'desc'), limit(n));
      const s = await getDocs(query(...partes));
      return s.docs.map((d) => d.data());
    },
  };
}

const main = async () => {
  await comprobarFirestore();
  const api = ADMIN ? await conAdmin() : await conWeb();
  console.log(`Proyecto: ${firebaseConfig.projectId}\n`);

  let ok = true;
  for (const [col, esperado] of Object.entries(ESPERADO)) {
    const n = await api.contar(col);
    const bien = n >= esperado;
    ok &&= bien;
    const extra = n > esperado ? `  (+${n - esperado} agregados)` : '';
    console.log(`  ${bien ? 'OK  ' : 'FALLA'} ${col.padEnd(12)} ${n} / ${esperado} mínimo${extra}`);
  }

  console.log('\nTop 5 cuentas por matrícula:');
  for (const c of await api.top('cuentas', 'matBasica', 5)) {
    const contacto = (c.emails?.[0] || c.telefonos?.[0] || 'sin contacto');
    console.log(`  ${String(c.matBasica).padStart(6)}  ${c.cuenta.slice(0, 44).padEnd(46)} ${contacto}`);
  }

  console.log('\nTop 5 prospectos Tier 1 por matrícula:');
  for (const p of await api.top('prospectos', 'matBasica', 5, ['tierNum', 1])) {
    console.log(`  ${String(p.matBasica).padStart(6)}  ${p.establecimiento.slice(0, 44).padEnd(46)} ${p.comuna}`);
  }

  console.log(ok ? '\nCarga completa.' : '\nFaltan documentos: vuelve a correr la carga.');
  process.exit(ok ? 0 : 1);
};

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  if (/permission|PERMISSION_DENIED/i.test(e.message)) {
    console.error(`\nLas reglas bloquean la lectura sin autenticación.`
      + `\nUsa --admin, o autentícate desde la app web.\n  ${CONSOLA_FIRESTORE}`);
  }
  process.exit(1);
});
