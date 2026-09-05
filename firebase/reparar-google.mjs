#!/usr/bin/env node
// ============================================================
// Vuelve a apuntar una cuenta de Firebase a su cuenta de Google actual.
//
// El caso: Google devuelve para un correo un identificador distinto del
// que Firebase tiene guardado. Pasa cuando la cuenta de Google se borró y
// se volvió a crear, o cuando el dominio pasó a Workspace: el correo es
// el mismo, la cuenta de Google es otra, y Google nunca reutiliza un
// identificador.
//
// Al entrar, Firebase encuentra la cuenta por el correo —que viene
// verificado— e intenta enlazarle esa identidad nueva. Como la cuenta ya
// tiene un google.com enlazado, responde "provider-already-linked" y no
// hay forma de entrar. El mensaje habla de enlaces porque para Firebase
// eso es un enlace; para la persona es "no puedo entrar".
//
// Lo que NO hay que hacer es borrar el usuario y crear otro: el uid es la
// llave de la lista de operadores, de quién puede borrar cada campaña, de
// qué campañas programadas acepta despachar el reloj y de quién puede
// retirar la autorización de Gmail. Un uid nuevo rompe las cuatro cosas
// en silencio. Este script conserva el uid y cambia sólo la identidad de
// Google que cuelga de él.
//
//   node firebase/reparar-google.mjs --admin --correo info@jumpmath.cl
//   node firebase/reparar-google.mjs --admin --correo info@jumpmath.cl \
//     --nuevo 112824584592168591971 --aplicar
//
// --nuevo acepta el identificador suelto o el texto completo del error,
// que es de donde sale.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { firebaseConfig } from './config.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const tiene = (f) => argv.includes(f);
const valor = (f, def = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

/* El identificador que devuelve Google. En el error viaja como URL
   ("https://accounts.google.com/1128…") y a veces se copia suelto; se
   acepta cualquiera de las dos formas, y también el bloque JSON entero
   pegado tal cual. */
export function idDeGoogle(texto) {
  const t = String(texto || '').trim();
  const enUrl = t.match(/accounts\.google\.com\/(\d{10,32})/);
  if (enUrl) return enUrl[1];
  const suelto = t.match(/^\d{10,32}$/);
  if (suelto) return t;
  const enJson = t.match(/"federatedId"\s*:\s*"[^"]*?(\d{10,32})"/);
  return enJson ? enJson[1] : '';
}

/* Qué hacer con lo que hay. Aparte para poder probarla: decide si el
   arreglo corresponde, y se niega cuando el síntoma no encaja. */
export function decidir(usuario, nuevoId) {
  const google = (usuario?.providerData || []).filter((p) => p.providerId === 'google.com');
  const actual = google[0]?.uid || '';
  if (!nuevoId) return { accion: 'informar', actual, google: google.length };
  if (!actual) return { accion: 'enlazar', actual, google: google.length };
  if (actual === nuevoId) {
    return {
      accion: 'nada',
      actual,
      google: google.length,
      motivo: 'Firebase ya apunta a esa cuenta de Google. El problema es otro.',
    };
  }
  return { accion: 'cambiar', actual, google: google.length };
}

async function conectar() {
  if (!tiene('--admin')) {
    throw new Error('Cambia credenciales de acceso. Ejecuta con --admin.');
  }
  const { initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { getFirestore } = await import('firebase-admin/firestore');
  const local = path.join(AQUI, 'serviceAccount.json');
  initializeApp({
    credential: fs.existsSync(local)
      ? cert(JSON.parse(fs.readFileSync(local, 'utf8')))
      : applicationDefault(),
    projectId: firebaseConfig.projectId,
  });
  return { auth: getAuth(), db: getFirestore() };
}

async function main() {
  const correo = valor('--correo');
  if (!correo) throw new Error('Falta --correo <la dirección con la que se entra>');
  const nuevoId = idDeGoogle(valor('--nuevo', ''));
  if (valor('--nuevo') && !nuevoId) {
    throw new Error('No encuentro un identificador de Google en --nuevo.\n'
      + '  Es el número de "https://accounts.google.com/…" que aparece en el error.');
  }

  const { auth, db } = await conectar();
  const usuario = await auth.getUserByEmail(correo).catch(() => null);
  if (!usuario) throw new Error(`Firebase no tiene ninguna cuenta con ${correo}.`);

  const { accion, actual, google, motivo } = decidir(usuario, nuevoId);
  const esOperador = (await db.doc(`operadores/${usuario.uid}`).get()).exists;

  console.log(`Cuenta de Firebase para ${correo}`);
  console.log(`  uid            ${usuario.uid}`);
  console.log(`  en operadores  ${esOperador ? 'sí' : 'NO — no podrá entrar aunque se arregle esto'}`);
  console.log(`  proveedores    ${(usuario.providerData || [])
    .map((p) => `${p.providerId}:${p.uid}`).join(' · ') || 'ninguno'}`);
  if (google > 1) console.log(`  OJO: ${google} proveedores google.com en la misma cuenta.`);

  if (accion === 'informar') {
    console.log('\nPara compararlo, mira el error de la app: dice qué identidad');
    console.log('devolvió Google. Si ese número no es el de arriba, es este caso.');
    console.log(`\n  node firebase/reparar-google.mjs --admin --correo ${correo} \\`);
    console.log('    --nuevo <el número de accounts.google.com/…> --aplicar');
    return;
  }
  if (accion === 'nada') {
    console.log(`\n${motivo}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nQué haría:');
  if (accion === 'cambiar') console.log(`  quitar   google.com:${actual}`);
  console.log(`  enlazar  google.com:${nuevoId}  (${correo})`);
  console.log(`  el uid ${usuario.uid} no se toca, así que no se pierde nada`);
  console.log('  de lo que cuelga de él: operadores, campañas y autorización.');

  if (!tiene('--aplicar')) {
    console.log('\nSólo informe. Para hacerlo, repite con --aplicar');
    return;
  }

  /* En dos pasos porque la misma llamada no admite desenlazar y enlazar
     el mismo proveedor. Entre medio la cuenta queda sin proveedor: sigue
     existiendo, con su uid y su correo, y no se puede entrar con ella —
     son unos milisegundos y es la única forma de conservar el uid. */
  if (accion === 'cambiar') {
    await auth.updateUser(usuario.uid, { providersToUnlink: ['google.com'] });
    console.log('\n  quitado el proveedor anterior');
  }
  await auth.updateUser(usuario.uid, {
    providerToLink: {
      providerId: 'google.com',
      uid: nuevoId,
      email: correo,
      displayName: usuario.displayName || undefined,
      photoURL: usuario.photoURL || undefined,
    },
  });

  const despues = await auth.getUser(usuario.uid);
  console.log('  enlazada la cuenta de Google actual\n');
  console.log(`Listo. Ahora ${correo} es ${(despues.providerData || [])
    .map((p) => `${p.providerId}:${p.uid}`).join(' · ')}`);
  console.log('Vuelve a entrar en la app; si sigue fallando, el error dirá otra cosa.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\nError: ${e.message}`);
    if (/permission|PERMISSION_DENIED|insufficient|credential/i.test(e.message)) {
      console.error('\nCon --admin las reglas no aplican, así que esto es de credenciales:');
      console.error('  gcloud auth application-default login');
    }
    process.exit(1);
  });
}
