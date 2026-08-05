// ============================================================
// Seguimiento de aperturas y clics
//
// Es la única pieza que necesita servidor: un pixel y un redirect
// tienen que registrarse en alguna parte. Desplegarla exige el plan
// Blaze de Firebase; sin ella la app sigue midiendo envíos, errores,
// rebotes y respuestas, que es lo que predice ventas.
//
//   firebase deploy --only functions,hosting
// ============================================================
const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// GIF transparente de 1x1: el pixel más pequeño que existe.
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const valido = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);

async function registrar(campanaId, rbd, campo) {
  if (!valido(campanaId) || !valido(rbd)) return;
  const dest = db.doc(`campanas/${campanaId}/destinatarios/${rbd}`);
  const snap = await dest.get();
  if (!snap.exists) return;            // no crear documentos desde fuera

  const datos = { [campo]: FieldValue.increment(1) };
  // La primera apertura es el dato interesante; las siguientes sólo
  // cuentan. Y no se degrada un "respondido" a "abierto".
  if (campo === 'aperturas' && !snap.get('primeraApertura')) {
    datos.primeraApertura = FieldValue.serverTimestamp();
  }
  if (snap.get('estado') === 'enviado' && campo === 'aperturas') {
    datos.estado = 'abierto';
  }
  await dest.set(datos, { merge: true });
  await db.doc(`campanas/${campanaId}`)
    .set({ totales: { [campo]: FieldValue.increment(1) } }, { merge: true });
}

exports.seguimiento = onRequest({ region: 'southamerica-west1', cors: true },
  async (req, res) => {
    const m = req.path.match(/^\/t\/(o|c)\/([^/]+)\/([^/?]+)/);
    if (!m) { res.status(404).end(); return; }
    const [, tipo, campanaId, rbd] = m;

    try {
      await registrar(campanaId, rbd, tipo === 'o' ? 'aperturas' : 'clics');
    } catch (e) {
      console.error('seguimiento', e);   // nunca romper la experiencia del lector
    }

    if (tipo === 'o') {
      res.set('Content-Type', 'image/gif');
      res.set('Cache-Control', 'no-store, max-age=0');
      res.status(200).send(PIXEL);
      return;
    }

    // Redirect de clic. Sólo http/s: un destino con javascript: convertiría
    // el dominio propio en un salto para phishing.
    const destino = String(req.query.u || '');
    let url;
    try { url = new URL(destino); } catch { res.status(400).send('destino inválido'); return; }
    if (!['http:', 'https:'].includes(url.protocol)) {
      res.status(400).send('destino inválido');
      return;
    }
    res.redirect(302, url.toString());
  });
