// ============================================================
// Quién puede entrar a la aplicación
//
// Hasta ahora bastaba con tener una cuenta de Google. Eso significaba
// que cualquiera que diera con la dirección podía leer los 8.158
// colegios con sus correos y teléfonos, editarlos, y —lo más caro— dejar
// una campaña "programada" en Firestore para que el servidor la
// despachara firmada con la cuenta de Gmail del equipo.
//
// Ahora las reglas exigen que exista operadores/{uid}. Esta colección no
// se puede escribir desde el navegador: sólo desde acá, con el Admin SDK.
//
// IMPORTANTE: da de alta a las personas del equipo ANTES de desplegar
// las reglas nuevas. Si despliegas primero, nadie puede entrar —ni tú—
// y habrá que arreglarlo desde este mismo script o la consola.
//
// Uso:
//   node firebase/operadores.mjs --admin --listar
//   node firebase/operadores.mjs --admin --alta <uid|correo> [nombre]
//   node firebase/operadores.mjs --admin --baja <uid|correo>
//
// El uid sale de la consola de Firebase, en Authentication > Users; el
// correo se resuelve solo si esa persona ya entró alguna vez.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firebaseConfig } from './config.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const tiene = (f) => args.includes(f);
const valor = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : '';
};

async function conectar() {
  if (!tiene('--admin')) {
    throw new Error('La lista de operadores es la que decide quién entra, así que '
      + 'las reglas se la reservan al Admin SDK. Ejecuta con --admin.');
  }
  const { initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  const { getAuth } = await import('firebase-admin/auth');
  const local = path.join(AQUI, 'serviceAccount.json');
  initializeApp({
    credential: fs.existsSync(local)
      ? cert(JSON.parse(fs.readFileSync(local, 'utf8')))
      : applicationDefault(),
    projectId: firebaseConfig.projectId,
  });
  return { db: getFirestore(), auth: getAuth(), FieldValue };
}

/* Se acepta uid o correo porque el uid no lo sabe nadie de memoria, pero
   es lo único estable: un correo se puede reasignar. */
async function resolver(auth, quien) {
  if (!quien) throw new Error('Falta el uid o el correo.');
  if (!quien.includes('@')) return { uid: quien, correo: '' };
  const u = await auth.getUserByEmail(quien).catch(() => null);
  if (!u) {
    throw new Error(`Nadie ha entrado nunca con ${quien}, así que todavía no `
      + 'tiene uid. Pídele que entre una vez y vuelve a intentarlo, o usa el '
      + 'uid de la consola de Firebase.');
  }
  return { uid: u.uid, correo: u.email || '' };
}

async function main() {
  const { db, auth, FieldValue } = await conectar();

  if (tiene('--listar') || args.length === 1) {
    const s = await db.collection('operadores').get();
    if (s.empty) {
      console.log('No hay ningún operador dado de alta.');
      console.log('Con las reglas nuevas desplegadas, NADIE puede entrar a la app.');
      return;
    }
    console.log(`${s.size} operador(es):`);
    for (const d of s.docs) {
      const x = d.data();
      console.log(`  ${d.id}  ${x.correo || '(sin correo)'}  ${x.nombre || ''}`);
    }
    return;
  }

  if (tiene('--alta')) {
    const { uid, correo } = await resolver(auth, valor('--alta'));
    await db.doc(`operadores/${uid}`).set({
      correo,
      nombre: args[args.indexOf('--alta') + 2] || '',
      alta: FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`Alta: ${uid} ${correo}`);
    return;
  }

  if (tiene('--baja')) {
    const { uid } = await resolver(auth, valor('--baja'));
    await db.doc(`operadores/${uid}`).delete();
    console.log(`Baja: ${uid}. Esa persona ya no puede entrar.`);
    return;
  }

  console.log('Usa --listar, --alta <uid|correo> [nombre] o --baja <uid|correo>.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
