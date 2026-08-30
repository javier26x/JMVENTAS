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

  /* El mismo dato, reflejado en el prospecto. Dentro de la campaña sólo
     sirve para mirar esa campaña; en el prospecto permite preguntarle a
     la base "quiénes abrieron y no han contestado" sin recorrer campaña
     por campaña, que es la lista de llamadas del día. */
  if (!esBot) {
    // update y no set: con `set` un RBD inventado en la URL crearía un
    // prospecto fantasma en la base.
    await db.doc(`prospectos/${rbd}`).update({
      [campo === 'aperturas' ? 'aperturasCorreo' : 'clicsCorreo']: FieldValue.increment(1),
      ultimaApertura: FieldValue.serverTimestamp(),
    }).catch(() => { /* el destinatario puede no ser un prospecto de la base */ });
  }
}

/* Baja en un clic. Gmail exige que el enlace de List-Unsubscribe atienda
   un POST sin pedir confirmación; el GET existe para quien lo abre desde
   el pie del correo y merece ver una página que le diga qué pasó.
   La marca queda por RBD, fuera de la campaña, para que ninguna campaña
   futura la pise. */
async function darDeBaja(campanaId, rbd) {
  if (!valido(campanaId) || !valido(rbd)) return false;
  const dest = db.doc(`campanas/${campanaId}/destinatarios/${rbd}`);
  const snap = await dest.get();
  if (!snap.exists) return false;         // no crear documentos desde fuera

  await db.doc(`bajas/${rbd}`).set({
    rbd: Number(rbd) || rbd,
    email: snap.get('email') || '',
    motivo: 'enlace',
    campanaId,
    fecha: FieldValue.serverTimestamp(),
  }, { merge: true });
  await dest.set({ estado: 'baja', bajaEn: FieldValue.serverTimestamp() }, { merge: true });
  await db.doc(`campanas/${campanaId}`)
    .set({ totales: { bajas: FieldValue.increment(1) } }, { merge: true });
  return true;
}

const PAGINA_BAJA = (ok) => `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? 'Baja registrada' : 'Enlace no válido'}</title></head>
<body style="margin:0;background:#eef1f5;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:460px;margin:14vh auto;background:#fff;border-radius:14px;padding:32px 34px">
  <div style="height:5px;background:#e8443a;border-radius:3px;margin-bottom:22px"></div>
  <h1 style="margin:0 0 10px;font-size:20px;color:#14345c">
    ${ok ? 'Listo, no le escribiremos más' : 'Este enlace ya no es válido'}</h1>
  <p style="margin:0;font-size:15px;line-height:1.6;color:#333">
    ${ok
    ? 'Su establecimiento queda fuera de nuestros envíos. Si fue un error, '
      + 'basta con responder el último correo y lo revertimos.'
    : 'Puede pedir la baja respondiendo el correo con la palabra BAJA.'}</p>
  <p style="margin:22px 0 0;font-size:12px;color:#8a93a3">JUMP Math Chile · Santiago de Chile</p>
</div></body></html>`;

/* Traduce un enlace web de WhatsApp al esquema que abre la aplicación.
   Devuelve null para cualquier otro destino, que sigue con su redirect
   de siempre. */
function enlaceApp(url) {
  const host = url.hostname.toLowerCase();
  if (!['wa.me', 'api.whatsapp.com', 'web.whatsapp.com'].includes(host)) return null;
  const telefono = (host === 'wa.me'
    ? url.pathname.replace(/\D/g, '')
    : (url.searchParams.get('phone') || '').replace(/\D/g, ''));
  if (!telefono) return null;
  const texto = url.searchParams.get('text') || '';
  return `whatsapp://send?phone=${telefono}`
    + (texto ? `&text=${encodeURIComponent(texto)}` : '');
}

const escapar = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PAGINA_WHATSAPP = (app, web) => `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Abriendo WhatsApp…</title></head>
<body style="margin:0;background:#eef1f5;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:420px;margin:18vh auto;background:#fff;border-radius:14px;
  padding:30px 32px;text-align:center">
  <div style="height:5px;background:#1faa4f;border-radius:3px;margin-bottom:22px"></div>
  <h1 style="margin:0 0 8px;font-size:19px;color:#14345c">Abriendo WhatsApp…</h1>
  <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#5a6b84">
    Si no se abre solo, usa uno de estos:</p>
  <p style="margin:0 0 10px">
    <a href="${escapar(app)}" style="display:block;background:#1faa4f;color:#fff;
      text-decoration:none;font-weight:bold;padding:13px 18px;border-radius:9px">
      Abrir la aplicación</a></p>
  <p style="margin:0">
    <a href="${escapar(web)}" style="font-size:13.5px;color:#5a6b84">
      Seguir en WhatsApp Web</a></p>
</div>
<script>
  var app = ${JSON.stringify(app)};
  var web = ${JSON.stringify(web)};
  // Si la aplicación toma el enlace, esta pestaña deja de estar a la
  // vista: ahí no hay que mandar a nadie a la web, o al volver del chat
  // se encontraría con el código QR.
  var salio = false;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) salio = true;
  });
  window.addEventListener('pagehide', function () { salio = true; });
  // El intento va por un marco oculto y no por location: si nadie tiene
  // registrado el esquema, el navegador se lleva la pestaña entera a una
  // pantalla de error y con ella el plan B. Dentro del marco, el mismo
  // fallo no se nota.
  var marco = document.createElement('iframe');
  marco.style.display = 'none';
  marco.src = app;
  document.body.appendChild(marco);
  setTimeout(function () {
    if (!salio && !document.hidden) location.replace(web);
  }, 1600);
</script>
</body></html>`;

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
    const baja = ruta.match(/^\/t\/baja\/([^/]+)\/([^/?]+)/);
    if (baja) {
      let ok = false;
      try {
        ok = await darDeBaja(baja[1], baja[2]);
      } catch (e) {
        console.error('baja', e);
      }
      // Gmail hace el POST en segundo plano y sólo mira el código.
      if (req.method === 'POST') { res.status(ok ? 200 : 404).end(); return; }
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.status(ok ? 200 : 404).send(PAGINA_BAJA(ok));
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

    /* WhatsApp merece un salto distinto. Un 302 de servidor deja al
       teléfono sin la señal que necesita para entregarle el enlace a la
       aplicación instalada, y el clic termina en WhatsApp Web pidiendo un
       código QR: para un director que no usa la web, eso es un callejón
       sin salida y una reunión perdida. La página de abajo intenta abrir
       la aplicación y sólo cae a la web si no aparece. */
    const app = enlaceApp(url);
    if (app) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'no-store, max-age=0');
      res.status(200).send(PAGINA_WHATSAPP(app, url.toString()));
      return;
    }

    res.redirect(302, url.toString());
  });
