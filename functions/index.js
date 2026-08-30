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
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

/* Credenciales del cliente OAuth para el envío programado. El id es
   público por diseño (viaja en cada pantalla de consentimiento); vive
   acá sólo para que configurar esto sean dos comandos y no un archivo
   más. El secreto sí es secreto y nunca sale de Secret Manager. */
const CLIENT_ID = defineSecret('GMAIL_CLIENT_ID');
const CLIENT_SECRET = defineSecret('GMAIL_CLIENT_SECRET');

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

// ============================================================
// Envío programado
//
// El navegador redacta y el servidor despacha. Ese reparto es a
// propósito: la plantilla, la firma y el seguimiento se arman una sola
// vez —en la app, donde se pueden ver antes de mandar— y acá sólo se
// entrega lo ya redactado. Así el correo que sale el lunes a las 8 es
// byte por byte el que se aprobó el sábado.
//
// Para despachar sin nadie delante hace falta un permiso que sobreviva
// al cierre del navegador. Se guarda un refresh token en `secretos`,
// una colección que las reglas niegan a todo cliente: sólo la alcanza
// este código con credenciales de servicio.
// ============================================================
const OAUTH = 'https://oauth2.googleapis.com/token';
const ENVIAR = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const LIMITE_DIARIO = 450;
const PAUSA_MS = 1400;

/* El día se cuenta en Santiago y no en UTC: a las 21:00 de un martes
   chileno ya es miércoles en Greenwich, y el contador del calentamiento
   se reiniciaría a mitad de una tanda. */
const diaSantiago = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

async function pedirToken(cuerpo) {
  const r = await fetch(OAUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID.value(), client_secret: CLIENT_SECRET.value(), ...cuerpo,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
  return j;
}

/* Canjea el código del consentimiento por un permiso duradero. Sólo lo
   puede pedir alguien con sesión iniciada en la app, y queda registrado
   quién autorizó: es un permiso para enviar correo en nombre de una
   persona, no un detalle de configuración. */
/* Los dominios donde vive la app. Detrás del rewrite de Hosting la
   petición llega a Cloud Run con `host` puesto en el servicio interno
   (…​.a.run.app), no en el sitio: comparar contra él rechazaría siempre
   la autorización. El dominio original viaja en x-forwarded-host, y los
   dos de Firebase se derivan del proyecto para no escribirlos a mano. */
const PROYECTO = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || '';
const HOSTS_APP = new Set([`${PROYECTO}.web.app`, `${PROYECTO}.firebaseapp.com`]);

function destinoValido(destino, req) {
  let url;
  try { url = new URL(destino); } catch { return false; }
  if (url.protocol !== 'https:' || url.pathname !== '/oauth.html') return false;
  const propio = String(req.get('x-forwarded-host') || req.get('host') || '');
  return HOSTS_APP.has(url.host) || url.host === propio;
}

async function guardarAutorizacion(code, redirectUri, uid, correo) {
  /* Google exige que el canje repita el mismo redirect_uri con el que se
     pidió el consentimiento, así que viene del navegador; pero se acepta
     sólo si apunta a este mismo sitio, para que nadie pueda usar este
     endpoint como paso intermedio hacia un destino ajeno. */
  const t = await pedirToken({
    code, redirect_uri: redirectUri, grant_type: 'authorization_code',
  });
  if (!t.refresh_token) {
    throw new Error('Google no entregó un permiso duradero. Vuelve a conectar '
      + 'eligiendo la cuenta y aceptando de nuevo la pantalla de permisos.');
  }
  await db.doc('secretos/gmail').set({
    refreshToken: t.refresh_token,
    correo: correo || '',
    autorizadoPor: uid,
    autorizadoEn: FieldValue.serverTimestamp(),
    permisos: String(t.scope || ''),
  });
  return { correo };
}

async function tokenDeEnvio() {
  const snap = await db.doc('secretos/gmail').get();
  const refresh = snap.get('refreshToken');
  if (!refresh) throw new Error('sin autorización guardada');
  const t = await pedirToken({ refresh_token: refresh, grant_type: 'refresh_token' });
  return { token: t.access_token, correo: snap.get('correo') || '' };
}

/* Un solo correo. Devuelve el hilo para que un seguimiento posterior
   pueda colgarse de él, igual que en el envío manual. */
async function despachar(token, crudo, hilo) {
  const r = await fetch(ENVIAR, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: crudo, ...(hilo ? { threadId: hilo } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  return j;
}

/* Cupo que queda hoy. El calentamiento no se suspende porque el envío
   sea automático: una cuenta que despacha 450 correos de golpe termina
   suspendida igual, y con ella se va la base entera. */
async function cupoDeHoy() {
  const dia = diaSantiago();
  const s = await db.doc(`envios/${dia}`).get();
  return { dia, resto: Math.max(0, LIMITE_DIARIO - (Number(s.get('n')) || 0)) };
}

/* Marca el prospecto igual que el envío manual: sin esto, un colegio al
   que le escribió el servidor seguiría figurando como no contactado y
   la campaña siguiente volvería a escribirle. */
async function anotarContacto(rbd, nombre, uid) {
  // update y no set: un destinatario que viene de otra colección no debe
  // aparecer como prospecto fantasma en la base.
  await db.doc(`prospectos/${rbd}`).update({
    estadoCrm: 'contactado',
    ultimoContacto: FieldValue.serverTimestamp(),
    actualizado: FieldValue.serverTimestamp(),
  }).catch(() => { /* el CRM no debe hacer fallar un envío ya despachado */ });
  // La bitácora va aparte: que el prospecto no exista no es razón para
  // perder el registro de que el correo salió.
  await db.collection('actividad').add({
    rbd: String(rbd), tipo: 'envio', uid: uid || '',
    texto: `Correo enviado · ${nombre || 'campaña'} (programado)`,
    creado: FieldValue.serverTimestamp(),
  }).catch(() => { /* nada */ });
}

/* Despacha una campaña vencida. Sale antes de que la función se quede
   sin tiempo y deja el resto para la corrida siguiente: cada correo se
   marca apenas sale, así que retomar nunca reenvía. */
async function enviarCampana(campana, token, hastaMs) {
  const ref = db.doc(`campanas/${campana.id}`);
  const cupo = await cupoDeHoy();
  if (!cupo.resto) return { enviados: 0, errores: 0, corte: 'cupo' };

  const dest = await ref.collection('destinatarios')
    .where('estado', '==', 'pendiente').limit(500).get();
  // Sólo los que el navegador dejó redactados: el resto del segmento
  // queda para una tanda posterior y no debe salir hoy.
  const cola = dest.docs.filter((d) => d.get('crudo')).slice(0, cupo.resto);

  let enviados = 0;
  let errores = 0;
  let corte = '';

  for (const d of cola) {
    if (Date.now() > hastaMs) { corte = 'tiempo'; break; }
    const rbd = d.id;
    // Alguien pudo darse de baja entre el sábado y el lunes. Honrarlo
    // acá es la última oportunidad antes de que el correo salga.
    const baja = await db.doc(`bajas/${rbd}`).get();
    if (baja.exists) {
      await d.ref.update({ estado: 'baja', error: 'dado de baja antes del envío' });
      continue;
    }
    try {
      const res = await despachar(token, d.get('crudo'), d.get('threadId'));
      await d.ref.update({
        estado: 'enviado',
        enviadoEn: FieldValue.serverTimestamp(),
        threadId: res.threadId || d.get('threadId') || '',
        messageId: res.id || '',
        error: '',
        crudo: FieldValue.delete(),   // ya cumplió; ocupa 20 KB por fila
      });
      enviados += 1;
      await db.doc(`envios/${cupo.dia}`).set(
        { n: FieldValue.increment(1), actualizado: FieldValue.serverTimestamp() },
        { merge: true });
      await anotarContacto(rbd, campana.nombre, campana.uid);
    } catch (e) {
      const msg = String(e.message).slice(0, 200);
      await d.ref.update({ estado: 'error', error: msg });
      errores += 1;
      // Cuota agotada o permiso vencido no se arreglan insistiendo con
      // los que siguen: se detiene y se conserva lo ya enviado.
      if (/quota|rate|limit|401|403|expir|invalid_grant/i.test(msg)) { corte = 'cuenta'; break; }
    }
    await new Promise((r) => setTimeout(r, PAUSA_MS));
  }

  if (enviados || errores) {
    await ref.update({
      'totales.enviados': FieldValue.increment(enviados),
      'totales.errores': FieldValue.increment(errores),
      actualizado: FieldValue.serverTimestamp(),
    });
  }
  return { enviados, errores, corte, quedaron: cola.length - enviados - errores };
}

/* Santiago corre funciones pero no Cloud Scheduler, así que el reloj
   vive en otra región. Da igual dónde: el trabajo es hablar con
   Firestore y con Gmail, y entre correo y correo hay una pausa de 1,4
   segundos que se come cualquier diferencia de latencia. La hora sí es
   chilena, que es lo único que se nota. */
const REGION_RELOJ = 'us-central1';

exports.correosProgramados = onSchedule({
  schedule: '*/5 * * * *',
  timeZone: 'America/Santiago',
  region: REGION_RELOJ,
  secrets: [CLIENT_ID, CLIENT_SECRET],
  timeoutSeconds: 540,
  memory: '512MiB',
  // Una sola instancia: dos corridas en paralelo sobre la misma campaña
  // se pisarían, y el precio de equivocarse es un correo duplicado a un
  // director que ya desconfía del remitente.
  maxInstances: 1,
}, async () => {
  const ahora = new Date();
  const vencidas = await db.collection('campanas')
    .where('estado', '==', 'programada')
    .where('programadaPara', '<=', ahora)
    .limit(5).get();
  if (vencidas.empty) return;

  let token;
  let correo;
  try {
    ({ token, correo } = await tokenDeEnvio());
  } catch (e) {
    // Sin permiso no sale nada, y callarlo sería peor que no programar:
    // la campaña queda marcada para que se vea en la app.
    for (const c of vencidas.docs) {
      await c.ref.update({
        estado: 'error',
        errorProgramado: `No se pudo enviar: ${String(e.message).slice(0, 160)}. `
          + 'Vuelve a autorizar el envío programado en la app.',
      });
    }
    console.error('programadas: sin token', e);
    return;
  }

  // Ocho minutos de trabajo y un margen para cerrar antes del corte.
  const hasta = Date.now() + 8 * 60 * 1000;

  for (const c of vencidas.docs) {
    if (Date.now() > hasta) break;
    /* Reclamar antes de tocar nada: si una corrida anterior sigue viva,
       esta se aparta. La marca caduca a los diez minutos para que una
       función muerta a medio camino no deje la campaña congelada. */
    const mia = await db.runTransaction(async (tx) => {
      const s = await tx.get(c.ref);
      if (s.get('estado') !== 'programada') return false;
      const desde = s.get('enviandoDesde')?.toMillis?.() || 0;
      if (Date.now() - desde < 10 * 60 * 1000) return false;
      tx.update(c.ref, { enviandoDesde: FieldValue.serverTimestamp() });
      return true;
    });
    if (!mia) continue;

    try {
      const r = await enviarCampana({ id: c.id, ...c.data() }, token, hasta);
      // Con corte por tiempo o por cupo la campaña sigue programada y la
      // corrida siguiente retoma donde quedó.
      const termino = !r.corte || r.corte === 'cuenta';
      await c.ref.update({
        estado: termino ? 'enviada' : 'programada',
        enviandoDesde: FieldValue.delete(),
        ...(termino ? { enviadaEn: FieldValue.serverTimestamp() } : {}),
      });
      console.log(`programadas: ${c.id} desde ${correo}`, r);
    } catch (e) {
      await c.ref.update({
        estado: 'error',
        enviandoDesde: FieldValue.delete(),
        errorProgramado: String(e.message).slice(0, 200),
      });
      console.error('programadas', c.id, e);
    }
  }
});

exports.seguimiento = onRequest({
  region: 'southamerica-west1',
  secrets: [CLIENT_ID, CLIENT_SECRET],
  // Endpoint público: sin tope, un bucle de peticiones se traduce en
  // factura. Diez instancias sobran para el volumen de correo real.
  maxInstances: 10,
  memory: '256MiB',
  timeoutSeconds: 20,
}, async (req, res) => {
    // Detrás de un rewrite de Hosting la ruta puede llegar en originalUrl.
    const ruta = String(req.originalUrl || req.url || req.path || '');
    if (/^\/t\/estado/.test(ruta)) {
      // Sonda para la app: qué hay disponible y, si el envío programado
      // está configurado, con qué cuenta quedó autorizado.
      let firma = null;
      try {
        const s = await db.doc('secretos/gmail').get();
        if (s.exists) {
          firma = {
            correo: s.get('correo') || '',
            desde: s.get('autorizadoEn')?.toMillis?.() || 0,
            puedeLeer: /gmail\.readonly/.test(String(s.get('permisos') || '')),
          };
        }
      } catch { /* la sonda nunca debe fallar por esto */ }
      res.json({
        ok: true,
        servicio: 'seguimiento',
        // El id del cliente OAuth es público; se entrega acá para que la
        // app no tenga que llevar una copia que se desincronice.
        clientId: CLIENT_ID.value() || '',
        programado: Boolean(CLIENT_ID.value() && CLIENT_SECRET.value()),
        autorizacion: firma,
      });
      return;
    }

    /* Canje del consentimiento por un permiso duradero. Va por el
       servidor porque el secreto del cliente no puede salir al
       navegador, y exige sesión iniciada: sin esto, cualquiera que
       encontrara la URL podría dejar su propia cuenta enviando. */
    if (/^\/t\/autorizar/.test(ruta)) {
      if (req.method !== 'POST') { res.status(405).end(); return; }
      try {
        const cabecera = String(req.get('Authorization') || '');
        const idToken = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : '';
        if (!idToken) { res.status(401).json({ error: 'sin sesión' }); return; }
        const usuario = await getAuth().verifyIdToken(idToken);
        const code = String(req.body?.code || '');
        if (!code) { res.status(400).json({ error: 'sin código' }); return; }
        const destino = String(req.body?.redirectUri || '');
        if (!destinoValido(destino, req)) {
          // El detalle va al registro y no a la respuesta: al usuario no
          // le sirve, y a quien husmee tampoco hay que contárselo.
          console.error('autorizar: destino rechazado', destino,
            'host', req.get('host'), 'reenviado', req.get('x-forwarded-host'));
          res.status(400).json({ error: 'destino de autorización no válido' });
          return;
        }
        const r = await guardarAutorizacion(code, destino, usuario.uid, req.body?.correo);
        res.json({ ok: true, ...r });
      } catch (e) {
        console.error('autorizar', e);
        res.status(400).json({ error: String(e.message).slice(0, 200) });
      }
      return;
    }

    /* Un token de Gmail para la aplicación, sacado del permiso que ya
       está guardado. Es lo que evita que haya que pasar por la pantalla
       de Google cada vez que se abre la app o cada vez que pasa una
       hora: el permiso se concede una vez y desde entonces el servidor
       reparte tokens frescos a quien tenga sesión y derecho.

       El derecho no es "estar autenticado": eso permitiría a cualquiera
       con una cuenta de Google mandar correo firmando como otro. Sólo
       pasan quien concedió el permiso y el dueño de la casilla. */
    if (/^\/t\/token/.test(ruta)) {
      if (req.method !== 'POST') { res.status(405).end(); return; }
      try {
        const cabecera = String(req.get('Authorization') || '');
        const idToken = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : '';
        if (!idToken) { res.status(401).json({ error: 'sin sesión' }); return; }
        const usuario = await getAuth().verifyIdToken(idToken);
        const snap = await db.doc('secretos/gmail').get();
        if (!snap.exists) { res.status(404).json({ error: 'sin autorización guardada' }); return; }

        const suyo = usuario.uid === snap.get('autorizadoPor');
        const propia = String(usuario.email || '').toLowerCase()
          === String(snap.get('correo') || '').toLowerCase();
        if (!suyo && !propia) {
          res.status(403).json({ error: 'esta cuenta no puede enviar por el servidor' });
          return;
        }

        const t = await pedirToken({
          refresh_token: snap.get('refreshToken'), grant_type: 'refresh_token',
        });
        res.set('Cache-Control', 'no-store, max-age=0');
        res.json({
          token: t.access_token,
          expira: Date.now() + ((Number(t.expires_in) || 3600) - 60) * 1000,
          permisos: String(snap.get('permisos') || ''),
          correo: snap.get('correo') || '',
        });
      } catch (e) {
        // invalid_grant es el permiso caducado o revocado; conviene que
        // la app lo distinga de un fallo pasajero para pedir uno nuevo.
        const msg = String(e.message);
        res.status(/invalid_grant|expired|revoked/i.test(msg) ? 401 : 400)
          .json({ error: msg.slice(0, 200) });
      }
      return;
    }

    /* Retira el permiso duradero. Tiene que ser tan fácil como darlo:
       un permiso para enviar correo en nombre de alguien que sólo se
       puede quitar entrando a la consola de Google es un permiso que
       nadie quita. */
    if (/^\/t\/desautorizar/.test(ruta)) {
      if (req.method !== 'POST') { res.status(405).end(); return; }
      try {
        const cabecera = String(req.get('Authorization') || '');
        const idToken = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : '';
        if (!idToken) { res.status(401).json({ error: 'sin sesión' }); return; }
        await getAuth().verifyIdToken(idToken);
        await db.doc('secretos/gmail').delete();
        // Las campañas que esperaban ya no van a salir: mejor decirlo
        // ahora que dejarlas en silencio hasta el lunes.
        const pend = await db.collection('campanas')
          .where('estado', '==', 'programada').limit(50).get();
        for (const c of pend.docs) {
          await c.ref.update({
            estado: 'borrador',
            errorProgramado: 'Se retiró la autorización de envío programado.',
          });
        }
        res.json({ ok: true, liberadas: pend.size });
      } catch (e) {
        res.status(400).json({ error: String(e.message).slice(0, 200) });
      }
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
