// ============================================================
// Configuración del proyecto y chequeo previo de Firestore.
//
// La apiKey es pública por diseño: viaja en el bundle de cualquier app
// web de Firebase. Lo que protege los datos son firestore.rules, no
// ocultar esta clave.
// ============================================================

export const firebaseConfig = {
  apiKey: 'AIzaSyCTmWjLoe2p78K6wng9SF9DKUoAKEoMf1M',
  authDomain: 'jmventas-aab3c.firebaseapp.com',
  projectId: 'jmventas-aab3c',
  storageBucket: 'jmventas-aab3c.firebasestorage.app',
  messagingSenderId: '868229245128',
  appId: '1:868229245128:web:5e5dc094e7c782b7c05dfd',
};

export const CONSOLA_FIRESTORE =
  `https://console.firebase.google.com/project/${firebaseConfig.projectId}/firestore`;

/**
 * El SDK web no falla cuando Firestore no está aprovisionado: reintenta la
 * conexión en silencio y el proceso queda colgado indefinidamente. Una
 * llamada REST previa convierte esa espera en un error accionable.
 *
 * @param {{admin?: boolean}} opts
 */
export async function comprobarFirestore({ admin = false } = {}) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}`
    + `/databases/(default)/documents/_preflight?pageSize=1&key=${firebaseConfig.apiKey}`;

  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  } catch {
    return;   // sin red o timeout: que falle el SDK con su propio error
  }
  if (r.ok || r.status === 404) return;   // 404 = la colección no existe, la base sí

  const cuerpo = await r.json().catch(() => ({}));
  const razon = cuerpo?.error?.details?.[0]?.reason || '';
  const mensaje = cuerpo?.error?.message || `HTTP ${r.status}`;

  if (razon === 'SERVICE_DISABLED' || /has not been used in project/i.test(mensaje)) {
    throw new Error(
      'Firestore no está creado todavía en este proyecto.\n\n'
      + '  Ábrelo una vez en la consola y elige "Crear base de datos":\n'
      + `    ${CONSOLA_FIRESTORE}\n\n`
      + '  Modo de producción y región southamerica-west1 (Santiago).\n'
      + '  Después vuelve a correr este comando.');
  }
  if (r.status === 403 && !admin) {
    console.warn('  Aviso: la API responde 403. Si es por reglas, usa --admin '
      + 'o aplica el modo carga de firestore.rules.\n');
    return;
  }
  throw new Error(mensaje);
}
