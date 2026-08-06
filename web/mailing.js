// ============================================================
// Campañas de correo — envío por la API de Gmail
//
// Se envía desde la cuenta que el usuario conecta, no desde un
// servidor: el token OAuth vive sólo en memoria y nunca se guarda.
// Eso permite operar sin backend y sin plan de pago.
//
// Lo que sí necesita servidor son las aperturas y los clics: hay que
// registrar el pixel y los redirects en alguna parte. La función está
// en functions/ y se activa desplegándola; sin ella se siguen midiendo
// envíos, errores, rebotes y respuestas, que es lo que predice ventas.
// ============================================================
import {
  GoogleAuthProvider, signInWithPopup,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query,
  orderBy, limit, where, writeBatch, serverTimestamp, increment,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

const GMAIL_ENVIAR = 'https://www.googleapis.com/auth/gmail.send';
const GMAIL_LEER = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Gmail corta a 500 destinatarios diarios; Workspace a 2.000. Se envía
// con pausa para no gatillar el límite por minuto ni parecer spam.
export const LIMITE_DIARIO = 450;
const PAUSA_MS = 1400;

/* MINEDUC publica los nombres en mayúsculas. Escribir "Estimado equipo
   directivo de COLEGIO DE LOS SAGRADOS CORAZONES" se lee como grito y
   delata un envío masivo, así que se pasan a capitalización normal. */
const MENORES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'en', 'a', 'al']);

export function titulo(texto) {
  return String(texto || '').trim().split(/\s+/).map((p, i) => {
    if (/[\d°]/.test(p)) return p;                              // N° 12, 21 de Mayo
    if (/^[IVX]{1,4}$/.test(p)) return p;                       // numeral romano
    if (/^[A-ZÑ]{2,}(?:\.[A-ZÑ]+\.?)+$/.test(p)) return p;      // SS.CC., S.S.
    const bajo = p.toLowerCase();
    if (i > 0 && MENORES.has(bajo.replace(/[.,]/g, ''))) return bajo;
    // Capitaliza también tras apóstrofo o guion: O´Higgins, Vicuña-Mackenna
    return bajo.replace(/(^|[´'’\-])([\wáéíóúñü])/gu, (_, a, b) => a + b.toUpperCase());
  }).join(' ');
}

export const VARIABLES = {
  '{{establecimiento}}': (p) => titulo(p.establecimiento),
  '{{comuna}}': (p) => titulo(p.comuna),
  '{{region}}': (p) => titulo(p.region),
  '{{simce}}': (p) => (p.simceMate ? Math.round(p.simceMate) : '—'),
  '{{brecha}}': (p, ctx) => (p.simceMate
    ? Math.max(0, Math.round(ctx.promedio - p.simceMate)) : '—'),
  '{{promedio}}': (p, ctx) => ctx.promedio,
  '{{matricula}}': (p) => (p.matBasica ?? '').toLocaleString('es-CL'),
  '{{contacto}}': (p) => (p.contacto || '').replace(/^Director \d*:\s*/, ''),
  '{{tier}}': (p) => ({ 1: 'alta prioridad', 2: 'prioridad media', 3: '' }[p.tierNum] || ''),
};

// ---------- sesión de Gmail ----------
const sesion = { token: null, correo: null, expira: 0, permisos: [] };

export const gmailConectado = () => Boolean(sesion.token) && Date.now() < sesion.expira;
export const gmailCorreo = () => sesion.correo;
export const puedeEnviar = () => sesion.permisos.includes(GMAIL_ENVIAR);
/* Leer el buzón es un permiso "restringido" para Google: una app externa
   que lo pida necesita auditoría de seguridad. Enviar es sólo "sensible".
   Por eso se puede conectar sin él y quedarse sin detección de
   respuestas, en vez de que ese trámite bloquee todo el envío. */
export const puedeLeer = () => sesion.permisos.includes(GMAIL_LEER);

export async function conectarGmail(auth, { leer = true } = {}) {
  const proveedor = new GoogleAuthProvider();
  proveedor.addScope(GMAIL_ENVIAR);
  if (leer) proveedor.addScope(GMAIL_LEER);
  proveedor.setCustomParameters({ prompt: 'consent select_account' });

  const res = await signInWithPopup(auth, proveedor);
  const cred = GoogleAuthProvider.credentialFromResult(res);
  if (!cred?.accessToken) {
    throw new Error('Google no entregó un token con permiso para enviar correo.');
  }
  sesion.token = cred.accessToken;
  sesion.correo = res.user.email;
  // Los tokens de Google duran una hora; se descuenta un minuto para no
  // quedar a medio envío con un token recién vencido.
  sesion.expira = Date.now() + 59 * 60 * 1000;

  /* Google puede conceder menos de lo pedido: en la pantalla de consentimiento
     el usuario desmarca permisos uno por uno. Preguntar qué quedó concedido
     evita ofrecer una función que va a fallar recién al usarla. */
  sesion.permisos = await permisosDelToken(sesion.token);
  if (!puedeEnviar()) {
    sesion.token = null;
    throw new Error('No se concedió el permiso para enviar correo. '
      + 'Vuelve a conectar y deja marcada la casilla de envío.');
  }
  return { correo: sesion.correo, leer: puedeLeer() };
}

async function permisosDelToken(token) {
  try {
    const r = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`);
    if (!r.ok) return [];
    return String((await r.json()).scope || '').split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

async function gmail(ruta, opciones = {}) {
  if (!gmailConectado()) {
    throw new Error('La sesión de Gmail expiró. Vuelve a conectarla.');
  }
  const r = await fetch(`${API}${ruta}`, {
    ...opciones,
    headers: {
      Authorization: `Bearer ${sesion.token}`,
      'Content-Type': 'application/json',
      ...(opciones.headers || {}),
    },
  });
  if (!r.ok) {
    const cuerpo = await r.json().catch(() => ({}));
    const msg = cuerpo?.error?.message || `HTTP ${r.status}`;
    if (r.status === 401 || r.status === 403) sesion.token = null;
    throw new Error(msg);
  }
  return r.json();
}

// ---------- redacción ----------
export function aplicarVariables(texto, prospecto, ctx) {
  let salida = String(texto || '');
  for (const [clave, fn] of Object.entries(VARIABLES)) {
    if (salida.includes(clave)) {
      salida = saline(salida, clave, String(fn(prospecto, ctx) ?? ''));
    }
  }
  return salida;
}
const saline = (s, buscar, reemplazo) => s.split(buscar).join(reemplazo);

const escaparHtml = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Identidad del correo. El logo y la firma viven en Hosting, así que los
   clientes los cargan por URL absoluta. Para usar el logotipo oficial
   basta reemplazar web/img/logo-jumpmath.png y volver a desplegar. */
const MARCA = {
  navy: '#14345c',
  rojo: '#e8443a',
  fondo: '#eef1f5',
  logo: '/img/logo-jumpmath.png',
  firma: '/img/firma-macarena.png',
  firmante: 'Macarena Bascour',
  cargo: 'JUMP Math Chile',
};

/**
 * El correo completo como pieza diseñada, pero construida en HTML.
 *
 * A propósito NO es una imagen con el texto adentro: los correos
 * imagen-sin-texto puntúan alto en los filtros de spam, y Outlook —común
 * en colegios— bloquea imágenes por defecto, con lo que el destinatario
 * vería un rectángulo vacío. Acá el nombre del colegio y su SIMCE son
 * texto real con aspecto de lámina: llegan aunque las imágenes no.
 * Tablas e estilos en línea porque es lo único que respetan los clientes
 * de correo.
 */
export function correoHtml({ texto, prospecto, ctx, base, campanaId, rbd, track }) {
  /* Todo enlace del correo pasa por el registro de clics cuando hay
     seguimiento: un clic en el botón de WhatsApp es la señal de compra
     más fuerte que produce esta pieza. */
  const enlace = (url) => (track
    ? `${base}/t/c/${campanaId}/${rbd}?u=${encodeURIComponent(url)}`
    : url);

  let cuerpo = escaparHtml(texto).replace(/\n/g, '<br>');
  cuerpo = cuerpo.replace(/(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${enlace(url)}" style="color:${MARCA.navy}">${url}</a>`);
  const pixel = track
    ? `<img src="${base}/t/o/${campanaId}/${rbd}" width="1" height="1" alt="" style="display:none">`
    : '';

  const colegio = escaparHtml(titulo(prospecto?.establecimiento || ''));
  const comuna = escaparHtml(titulo(prospecto?.comuna || ''));
  const simce = Number(prospecto?.simceMate);
  const anio = prospecto?.simceAnio || '';
  const brecha = Number.isFinite(simce) ? Math.round((ctx?.promedio || 253) - simce) : null;

  /* WhatsApp con el mensaje ya escrito y el colegio adentro: el director
     toca el botón y el chat llega auto-identificado. Es el paso de menor
     fricción posible entre leer y contactar. */
  const dig = String(ctx?.whatsapp || '').replace(/\D/g, '');
  const waNum = dig.length === 9 && dig.startsWith('9') ? `56${dig}` : dig;
  const wa = waNum.length >= 11
    ? `https://wa.me/${waNum}?text=${encodeURIComponent(
      `Hola, le escribo de ${titulo(prospecto?.establecimiento || 'un colegio')}` +
      `${comuna ? ` (${titulo(prospecto?.comuna)})` : ''}. Me interesa conocer JUMP Math.`)}`
    : '';
  const waVisible = waNum.length >= 11
    ? `+${waNum.slice(0, 2)} ${waNum.slice(2, 3)} ${waNum.slice(3, 7)} ${waNum.slice(7)}` : '';

  const sitio = String(ctx?.sitio || '').trim();
  const remitente = String(ctx?.remitente || '').trim();

  const tarjetaSimce = Number.isFinite(simce) ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#f2f6fc;border-left:4px solid ${MARCA.rojo};border-radius:0 8px 8px 0">
      <tr>
        <td style="padding:14px 18px;font-family:Arial,sans-serif">
          <span style="font-size:30px;font-weight:bold;color:${MARCA.navy}">${Math.round(simce)}</span>
          <span style="font-size:13px;color:#5a6b84">&nbsp;puntos · SIMCE Matemática 4º básico${anio ? ` ${escaparHtml(anio)}` : ''}</span>
          ${brecha > 0 ? `<div style="font-size:13px;color:${MARCA.rojo};font-weight:bold;padding-top:2px">
            ${brecha} puntos bajo el promedio nacional (${ctx?.promedio || 253})</div>
          <div style="font-size:12px;color:#5a6b84;padding-top:3px">Una brecha que un método estructurado puede cerrar.</div>` : ''}
        </td>
      </tr>
    </table>` : '';

  const botonWa = wa ? `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 6px">
      <tr><td style="background:#25D366;border-radius:8px">
        <a href="${enlace(wa)}" style="display:inline-block;padding:13px 26px;
          font-family:Arial,sans-serif;font-size:15px;font-weight:bold;
          color:#ffffff;text-decoration:none">Conversemos por WhatsApp&nbsp;&nbsp;&#8250;</a>
      </td></tr>
    </table>
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#5a6b84;padding-bottom:4px">
      o simplemente responda este correo — contesto personalmente.</div>` : `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#333;padding:2px 0 6px">
      Responda este correo y coordinamos — contesto personalmente.</div>`;

  const contactoFirma = [
    waVisible ? `WhatsApp <a href="${enlace(wa)}" style="color:${MARCA.navy};text-decoration:none;font-weight:bold">${waVisible}</a>` : '',
    remitente ? `<a href="mailto:${escaparHtml(remitente)}" style="color:${MARCA.navy};text-decoration:none">${escaparHtml(remitente)}</a>` : '',
    sitio ? `<a href="${enlace(sitio)}" style="color:${MARCA.navy};text-decoration:none">${escaparHtml(sitio.replace(/^https?:\/\//, ''))}</a>` : '',
  ].filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${MARCA.fondo}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">
  Una propuesta concreta para matemática en ${colegio || 'su establecimiento'} &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${MARCA.fondo}">
  <tr><td align="center" style="padding:26px 12px">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0"
           style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden">
      <tr><td style="height:5px;background:${MARCA.rojo};font-size:0">&nbsp;</td></tr>
      <tr><td style="padding:22px 30px 6px">
        <img src="${base}${MARCA.logo}" width="170" alt="JUMP Math Chile"
             style="display:block;border:0;max-width:170px">
      </td></tr>
      <tr><td style="padding:16px 30px 4px;font-family:Arial,sans-serif">
        ${comuna ? `<div style="font-size:12px;font-weight:bold;letter-spacing:.09em;
          text-transform:uppercase;color:${MARCA.rojo}">${comuna}</div>` : ''}
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.25;
          color:${MARCA.navy};padding:4px 0 14px">${colegio}</div>
        ${tarjetaSimce}
      </td></tr>
      <tr><td style="padding:12px 30px 0;font-family:Arial,sans-serif;font-size:12px;
        color:#8a93a3">Creado en Canadá &nbsp;·&nbsp; Ensayos controlados aleatorizados
        &nbsp;·&nbsp; Presente en Canadá, EE.&nbsp;UU. y España</td></tr>
      <tr><td style="padding:14px 30px 6px;font-family:Arial,sans-serif;
        font-size:15px;line-height:1.65;color:#333333">${cuerpo}</td></tr>
      <tr><td style="padding:12px 30px 4px">${botonWa}</td></tr>
      <tr><td style="padding:12px 30px 6px">
        <img src="${base}${MARCA.firma}" width="185" alt="${escaparHtml(MARCA.firmante)}"
             style="display:block;border:0;max-width:185px">
        <div style="font-family:Arial,sans-serif;font-size:14px;font-weight:bold;
          color:${MARCA.navy};padding-top:6px">${escaparHtml(MARCA.firmante)}</div>
        <div style="font-family:Arial,sans-serif;font-size:13px;color:#5a6b84">${escaparHtml(MARCA.cargo)}</div>
        ${contactoFirma ? `<div style="font-family:Arial,sans-serif;font-size:12px;
          color:#5a6b84;padding-top:6px">${contactoFirma}</div>` : ''}
      </td></tr>
      <tr><td style="padding:6px 30px 26px;font-family:Arial,sans-serif;font-size:13px;
        line-height:1.55;color:#333333"><b>PD:</b> los programas que parten con el año
        escolar se definen en estas semanas. Si le hace sentido para 2027, este es el
        momento de conversarlo.</td></tr>
    </table>
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
      <tr><td style="padding:14px 20px;font-family:Arial,sans-serif;font-size:11px;
        line-height:1.5;color:#8a93a3" align="center">
        Le escribimos porque ${colegio || 'su establecimiento'} figura en el directorio público
        de establecimientos de MINEDUC.<br>
        Si prefiere no recibir más información, responda este correo con la palabra BAJA.
      </td></tr>
    </table>
  </td></tr>
</table>${pixel}</body></html>`;
}

/** RFC 2822 en base64url, que es lo que espera la API de Gmail. */
function mensajeCrudo({ para, asunto, html, texto, de }) {
  const limite = `lim_${Math.random().toString(36).slice(2)}`;
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const cabeceras = [
    `From: ${de}`,
    `To: ${para}`,
    // El asunto puede traer tildes y ñ: MIME encoded-word evita que
    // llegue con caracteres rotos.
    `Subject: =?UTF-8?B?${b64(asunto)}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${limite}"`,
  ].join('\r\n');

  const cuerpo = [
    '', `--${limite}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64', '', b64(texto),
    `--${limite}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64', '', b64(html),
    `--${limite}--`,
  ].join('\r\n');

  return b64(cabeceras + '\r\n' + cuerpo)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------- persistencia ----------
export async function listarCampanas(db) {
  const s = await getDocs(query(collection(db, 'campanas'),
    orderBy('creado', 'desc'), limit(100)));
  return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function leerCampana(db, id) {
  const d = await getDoc(doc(db, 'campanas', id));
  return d.exists() ? { id: d.id, ...d.data() } : null;
}

export async function guardarCampana(db, campana, destinatarios, uid) {
  const id = campana.id || doc(collection(db, 'campanas')).id;
  await setDoc(doc(db, 'campanas', id), {
    nombre: campana.nombre || 'Sin nombre',
    asunto: campana.asunto || '',
    cuerpo: campana.cuerpo || '',
    segmento: campana.segmento || {},
    track: Boolean(campana.track),
    estado: campana.estado || 'borrador',
    uid,
    creado: campana.creado || serverTimestamp(),
    actualizado: serverTimestamp(),
    totales: campana.totales
      || { destinatarios: destinatarios?.length || 0, enviados: 0, errores: 0,
           respuestas: 0, aperturas: 0, clics: 0 },
  }, { merge: true });

  if (destinatarios) {
    // 500 operaciones por lote es el máximo de Firestore.
    for (let i = 0; i < destinatarios.length; i += 450) {
      const b = writeBatch(db);
      for (const p of destinatarios.slice(i, i + 450)) {
        b.set(doc(db, 'campanas', id, 'destinatarios', String(p.rbd)), {
          rbd: p.rbd,
          establecimiento: p.establecimiento || '',
          email: primerCorreo(p.email),
          comuna: p.comuna || '',
          estado: 'pendiente',
          aperturas: 0,
          clics: 0,
        }, { merge: true });
      }
      await b.commit();
    }
  }
  return id;
}

export const primerCorreo = (campo) => String(campo || '')
  .split(';').map((s) => s.trim()).filter(Boolean)[0] || '';

export async function listarDestinatarios(db, campanaId, soloPendientes = false) {
  const partes = [collection(db, 'campanas', campanaId, 'destinatarios')];
  if (soloPendientes) partes.push(where('estado', '==', 'pendiente'));
  partes.push(limit(2000));
  const s = await getDocs(query(...partes));
  return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function borrarCampana(db, id) {
  const dest = await listarDestinatarios(db, id);
  for (let i = 0; i < dest.length; i += 450) {
    const b = writeBatch(db);
    for (const d of dest.slice(i, i + 450)) {
      b.delete(doc(db, 'campanas', id, 'destinatarios', d.id));
    }
    await b.commit();
  }
  await deleteDoc(doc(db, 'campanas', id));
}

// ---------- envío ----------
/**
 * Envía uno a uno, guardando el resultado de cada correo apenas ocurre.
 * Un corte a mitad de camino no pierde el avance: los ya enviados quedan
 * marcados y `reanudar` retoma sólo los pendientes.
 */
export async function enviarCampana(db, campana, destinatarios, ctx, alAvanzar) {
  const base = location.origin;
  let enviados = 0;
  let errores = 0;

  for (const [i, d] of destinatarios.entries()) {
    if (ctx.cancelado?.()) break;
    if (!d.email) {
      await marcar(db, campana.id, d.rbd, { estado: 'error', error: 'sin correo' });
      errores += 1;
      alAvanzar?.({ i: i + 1, total: destinatarios.length, d, error: 'sin correo' });
      continue;
    }

    const prospecto = ctx.prospectos.get(String(d.rbd)) || d;
    const asunto = aplicarVariables(campana.asunto, prospecto, ctx);
    const texto = aplicarVariables(campana.cuerpo, prospecto, ctx);
    const html = correoHtml({
      texto, prospecto, ctx,
      base, campanaId: campana.id, rbd: d.rbd, track: campana.track,
    });

    try {
      const res = await gmail('/messages/send', {
        method: 'POST',
        body: JSON.stringify({
          raw: mensajeCrudo({ para: d.email, asunto, html, texto, de: gmailCorreo() }),
        }),
      });
      await marcar(db, campana.id, d.rbd, {
        estado: 'enviado',
        enviadoEn: serverTimestamp(),
        threadId: res.threadId || '',
        messageId: res.id || '',
        error: '',
      });
      enviados += 1;
      alAvanzar?.({ i: i + 1, total: destinatarios.length, d });
    } catch (e) {
      await marcar(db, campana.id, d.rbd, { estado: 'error', error: String(e.message).slice(0, 200) });
      errores += 1;
      alAvanzar?.({ i: i + 1, total: destinatarios.length, d, error: e.message });
      // Un token vencido o una cuota agotada no se arreglan reintentando
      // el resto: mejor detenerse y conservar lo ya enviado.
      if (/quota|rate|limit|401|403|expir/i.test(e.message)) break;
    }
    await new Promise((r) => setTimeout(r, PAUSA_MS));
  }

  await updateDoc(doc(db, 'campanas', campana.id), {
    estado: 'enviada',
    'totales.enviados': increment(enviados),
    'totales.errores': increment(errores),
    actualizado: serverTimestamp(),
  });
  return { enviados, errores };
}

async function marcar(db, campanaId, rbd, datos) {
  await setDoc(doc(db, 'campanas', campanaId, 'destinatarios', String(rbd)),
    datos, { merge: true });
}

/** Envía el correo a la propia cuenta conectada, con los datos de un
 *  destinatario real ya reemplazados. No toca la campaña ni el CRM. */
export async function enviarPrueba(campana, prospecto, ctx) {
  const asunto = aplicarVariables(campana.asunto, prospecto, ctx);
  const texto = aplicarVariables(campana.cuerpo, prospecto, ctx);
  const html = correoHtml({ texto, prospecto, ctx, base: location.origin, track: false });
  await gmail('/messages/send', {
    method: 'POST',
    body: JSON.stringify({
      raw: mensajeCrudo({
        para: gmailCorreo(),
        asunto: `[PRUEBA] ${asunto}`,
        html, texto, de: gmailCorreo(),
      }),
    }),
  });
}

// ---------- respuestas y rebotes ----------
/**
 * Revisa cada hilo enviado y marca los que tienen respuesta o rebote.
 *
 * Es la métrica que de verdad importa y no necesita servidor: Gmail ya
 * sabe si contestaron. Un hilo con más de un mensaje, o con un mensaje
 * que no es nuestro, es una respuesta.
 */
export async function revisarRespuestas(db, campanaId, alAvanzar) {
  const dest = (await listarDestinatarios(db, campanaId))
    .filter((d) => d.threadId && d.estado !== 'respondido');
  let respuestas = 0;
  let rebotes = 0;
  const yo = (gmailCorreo() || '').toLowerCase();

  for (const [i, d] of dest.entries()) {
    try {
      const hilo = await gmail(`/threads/${d.threadId}?format=metadata`
        + '&metadataHeaders=From&metadataHeaders=Subject');
      const mensajes = hilo.messages || [];
      const entrantes = mensajes.filter((m) => {
        const from = (m.payload?.headers || [])
          .find((h) => h.name.toLowerCase() === 'from')?.value || '';
        return !from.toLowerCase().includes(yo);
      });
      if (entrantes.length) {
        const from = (entrantes[0].payload?.headers || [])
          .find((h) => h.name.toLowerCase() === 'from')?.value || '';
        const rebote = /mailer-daemon|postmaster|delivery.?(status|subsystem)/i.test(from);
        await marcar(db, campanaId, d.rbd, {
          estado: rebote ? 'rebotado' : 'respondido',
          respondidoEn: serverTimestamp(),
        });
        if (rebote) rebotes += 1; else respuestas += 1;
      }
    } catch (e) {
      if (/401|403|expir/i.test(e.message)) throw e;
    }
    alAvanzar?.({ i: i + 1, total: dest.length });
  }

  if (respuestas || rebotes) {
    await updateDoc(doc(db, 'campanas', campanaId), {
      'totales.respuestas': increment(respuestas),
      'totales.rebotes': increment(rebotes),
      actualizado: serverTimestamp(),
    });
  }
  return { respuestas, rebotes, revisados: dest.length };
}
