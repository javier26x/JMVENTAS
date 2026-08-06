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

// Los filtros antispam y los escáneres corporativos cargan las imágenes
// al recibir el correo, no al leerlo. Una apertura a los pocos segundos
// del envío es una máquina, y contarla infla la tasa justo donde uno
// querría confiar en ella.
const SEGUNDOS_BOT = 15;

async function registrar(campanaId, rbd, campo) {
  if (!valido(campanaId) || !valido(rbd)) return;
  const dest = db.doc(`campanas/${campanaId}/destinatarios/${rbd}`);
  const snap = await dest.get();
  if (!snap.exists) return;            // no crear documentos desde fuera

  const enviado = snap.get('enviadoEn');
  const segundos = enviado?.toMillis ? (Date.now() - enviado.toMillis()) / 1000 : Infinity;
  const esBot = campo === 'aperturas' && segundos < SEGUNDOS_BOT;
  const real = esBot ? 'aperturasBot' : campo;

  const datos = { [real]: FieldValue.increment(1) };
  if (!esBot && campo === 'aperturas') {
    // La primera apertura es el dato interesante; las siguientes cuentan.
    if (!snap.get('primeraApertura')) datos.primeraApertura = FieldValue.serverTimestamp();
    // No degradar un "respondido" a "abierto".
    if (snap.get('estado') === 'enviado') datos.estado = 'abierto';
  }
  await dest.set(datos, { merge: true });
  await db.doc(`campanas/${campanaId}`)
    .set({ totales: { [real]: FieldValue.increment(1) } }, { merge: true });
}

exports.seguimiento = onRequest({
  region: 'southamerica-west1',
  // Endpoint público: sin tope, un bucle de peticiones se traduce en
  // factura. Diez instancias sobran para el volumen de correo real.
  maxInstances: 10,
  memory: '256MiB',
  timeoutSeconds: 20,
}, async (req, res) => {
    // Detrás de un rewrite de Hosting la ruta puede llegar en originalUrl.
    const ruta = String(req.originalUrl || req.url || req.path || '');
    if (/^\/t\/estado/.test(ruta)) {
      res.json({ ok: true, servicio: 'seguimiento' });   // sonda para la app
      return;
    }
    const m = ruta.match(/^\/t\/(o|c)\/([^/]+)\/([^/?]+)/);
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
