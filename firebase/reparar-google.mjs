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
// Habla con la API por HTTP, con el token de `gcloud`, y no por el SDK de
// administración: la resolución de credenciales del SDK es una fuente de
// fallos propia —y ya falló acá— que no tiene nada que ver con el
// problema que se viene a arreglar. En Cloud Shell gcloud siempre está
// autenticado.
//
//   node firebase/reparar-google.mjs --correo info@jumpmath.cl
//   node firebase/reparar-google.mjs --uid 7AYHO7by…
//   node firebase/reparar-google.mjs --uid 7AYHO7by… \
//     --nuevo 112824584592168591971 --aplicar
//
// --nuevo acepta el identificador suelto, la URL de accounts.google.com o
// el texto completo del error, que es de donde sale.
// ============================================================
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { firebaseConfig } from './config.mjs';

const PROYECTO = firebaseConfig.projectId;
const IDP = `https://identitytoolkit.googleapis.com/v1/projects/${PROYECTO}`;
const FS = `https://firestore.googleapis.com/v1/projects/${PROYECTO}/databases/(default)/documents`;

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

/* La API devuelve `providerUserInfo` con `rawId`; el resto del script
   habla en `providerData` con `uid`, como el SDK. Se traduce una vez acá
   para que la decisión no tenga que saber de dónde vino el dato. */
export const normalizar = (cuenta) => ({
  uid: cuenta?.localId || '',
  email: cuenta?.email || '',
  displayName: cuenta?.displayName || '',
  photoURL: cuenta?.photoUrl || '',
  providerData: (cuenta?.providerUserInfo || [])
    .map((p) => ({ providerId: p.providerId, uid: p.rawId, email: p.email })),
});

function token() {
  try {
    return execFileSync('gcloud', ['auth', 'print-access-token'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    throw new Error('No pude obtener un token de gcloud.\n'
      + `  ${String(e.stderr || e.message).trim().split('\n')[0]}\n`
      + '  En Cloud Shell suele bastar:  gcloud auth login');
  }
}

/* Con las credenciales de una persona —las que deja `gcloud auth
   login`— Google no sabe a qué proyecto cobrarle la llamada y rechaza
   con 403 aunque los permisos estén bien. Esta cabecera lo dice. */
const cabeceras = (tk, conCuerpo) => ({
  Authorization: `Bearer ${tk}`,
  'x-goog-user-project': PROYECTO,
  ...(conCuerpo ? { 'Content-Type': 'application/json' } : {}),
});

async function llamar(url, cuerpo, tk) {
  const r = await fetch(url, {
    method: cuerpo ? 'POST' : 'GET',
    headers: cabeceras(tk, Boolean(cuerpo)),
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });
  const texto = await r.text();
  let j = {};
  try { j = JSON.parse(texto); } catch { /* respuesta no JSON */ }
  if (!r.ok) {
    const msg = j?.error?.message || texto.slice(0, 300) || `HTTP ${r.status}`;
    if (r.status === 403) {
      /* Dos cosas muy distintas dan 403, y confundirlas manda a revisar
         permisos que están bien. */
      const cuota = /quota project|serviceusage/i.test(msg);
      throw new Error(`${cuota ? 'Falta habilitar el proyecto de cuota' : 'Sin permiso'} `
        + `sobre ${PROYECTO}: ${msg}\n`
        + (cuota
          ? '  Prueba:  gcloud auth application-default set-quota-project '
            + `${PROYECTO}\n  y si no, habilita la API:  gcloud services enable `
            + `identitytoolkit.googleapis.com --project ${PROYECTO}`
          : '  La cuenta de gcloud tiene que ser dueña o editora del proyecto.\n'
            + '  Comprueba con:  gcloud auth list'));
    }
    throw new Error(`${msg} (HTTP ${r.status})`);
  }
  return j;
}

async function main() {
  const correo = valor('--correo');
  const uid = valor('--uid');
  if (!correo && !uid) {
    throw new Error('Falta --correo <la dirección con la que se entra>, o --uid <el de Firebase>');
  }
  const nuevoId = idDeGoogle(valor('--nuevo', ''));
  if (valor('--nuevo') && !nuevoId) {
    throw new Error('No encuentro un identificador de Google en --nuevo.\n'
      + '  Es el número de "https://accounts.google.com/…" que aparece en el error.');
  }

  const tk = token();
  console.log(`Proyecto: ${PROYECTO}`);
  // Saber con qué cuenta se está actuando importa cuando lo que falla es
  // un permiso; que no se pueda averiguar no es motivo para no seguir.
  let quien = '';
  try {
    quien = execFileSync('gcloud', ['config', 'get-value', 'account'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* da igual */ }
  console.log(`Con la cuenta: ${quien || '(no se pudo averiguar)'}\n`);

  const busqueda = await llamar(`${IDP}/accounts:lookup`,
    uid ? { localId: [uid] } : { email: [correo] }, tk);
  const cuentas = busqueda.users || [];

  if (!cuentas.length) {
    // Antes de decir que no está, ver qué hay: el correo puede estar en
    // el proveedor y no en el campo `email` de la cuenta.
    const todas = (await llamar(`${IDP}/accounts:batchGet?maxResults=500`, null, tk)).users || [];
    const buscado = String(correo || '').toLowerCase();
    const porProveedor = todas.filter((u) => (u.providerUserInfo || [])
      .some((p) => String(p.email || '').toLowerCase() === buscado));
    if (porProveedor.length === 1) {
      console.log(`(${correo} está en el proveedor, no en el correo de la cuenta)\n`);
      cuentas.push(porProveedor[0]);
    } else {
      throw new Error(`No hay ninguna cuenta con ${uid || correo} en ${PROYECTO}.\n`
        + `Las que existen (${todas.length}):\n`
        + todas.map((u) => `  ${u.localId}  ${u.email || '(sin correo)'}  `
          + `${(u.providerUserInfo || []).map((p) => `${p.providerId}:${p.rawId}`).join(' ')}`)
          .join('\n'));
    }
  }
  if (cuentas.length > 1) {
    throw new Error(`Hay ${cuentas.length} cuentas con ${correo}:\n`
      + cuentas.map((u) => `  ${u.localId}`).join('\n')
      + '\n  Elige una con --uid <uid>.');
  }

  const usuario = normalizar(cuentas[0]);
  const { accion, actual, google, motivo } = decidir(usuario, nuevoId);

  const enOperadores = await fetch(`${FS}/operadores/${usuario.uid}`,
    { headers: cabeceras(tk, false) }).then((r) => r.ok).catch(() => null);

  console.log(`Cuenta de Firebase para ${usuario.email || usuario.uid}`);
  console.log(`  uid            ${usuario.uid}`);
  console.log(`  en operadores  ${enOperadores === null ? 'no se pudo comprobar'
    : enOperadores ? 'sí' : 'NO — no podrá entrar aunque se arregle esto'}`);
  console.log(`  proveedores    ${usuario.providerData
    .map((p) => `${p.providerId}:${p.uid}`).join(' · ') || 'ninguno'}`);
  if (google > 1) console.log(`  OJO: ${google} proveedores google.com en la misma cuenta.`);

  if (accion === 'informar') {
    console.log('\nCompáralo con el error de la app: dice qué identidad devolvió');
    console.log('Google. Si ese número no es el de arriba, es este caso.\n');
    console.log(`  node firebase/reparar-google.mjs --uid ${usuario.uid} \\`);
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
  console.log(`  enlazar  google.com:${nuevoId}  (${usuario.email})`);
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
    await llamar(`${IDP}/accounts:update`,
      { localId: usuario.uid, deleteProvider: ['google.com'] }, tk);
    console.log('\n  quitado el proveedor anterior');
  }
  await llamar(`${IDP}/accounts:update`, {
    localId: usuario.uid,
    linkProviderUserInfo: {
      providerId: 'google.com',
      rawId: nuevoId,
      email: usuario.email,
      ...(usuario.displayName ? { displayName: usuario.displayName } : {}),
      ...(usuario.photoURL ? { photoUrl: usuario.photoURL } : {}),
    },
  }, tk);
  console.log('  enlazada la cuenta de Google actual\n');

  const despues = normalizar(((await llamar(`${IDP}/accounts:lookup`,
    { localId: [usuario.uid] }, tk)).users || [])[0]);
  console.log(`Listo. Ahora ${despues.email} es ${despues.providerData
    .map((p) => `${p.providerId}:${p.uid}`).join(' · ')}`);
  console.log('Vuelve a entrar en la app; si sigue fallando, el error dirá otra cosa.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\nError: ${e.message}`);
    process.exit(1);
  });
}
