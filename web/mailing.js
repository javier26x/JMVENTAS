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
  firmante: 'Macarena Bascour F.',
  cargo: 'Directora · JUMP Math Chile',
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
  /* Todo enlace pasa por el registro de clics cuando hay seguimiento: un
     clic en el botón de WhatsApp es la señal de compra más fuerte que
     produce esta pieza. */
  const enlace = (url) => (track
    ? `${base}/t/c/${campanaId}/${rbd}?u=${encodeURIComponent(url)}`
    : url);
  const img = (nombre) => `${base}/img/${nombre}.png`;

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
     toca el botón y el chat llega auto-identificado. */
  const dig = String(ctx?.whatsapp || '').replace(/\D/g, '');
  const waNum = dig.length === 9 && dig.startsWith('9') ? `56${dig}` : dig;
  const wa = waNum.length >= 11
    ? `https://wa.me/${waNum}?text=${encodeURIComponent(
      `Hola, le escribo de ${titulo(prospecto?.establecimiento || 'un colegio')}` +
      `${comuna ? ` (${titulo(prospecto?.comuna)})` : ''}. Quiero agendar la reunión de JUMP Math.`)}`
    : '';
  const waVisible = waNum.length >= 11
    ? `+${waNum.slice(0, 2)} ${waNum.slice(2, 3)} ${waNum.slice(3, 7)} ${waNum.slice(7)}` : '';

  const sitio = String(ctx?.sitio || '').trim();
  const remitente = String(ctx?.remitente || '').trim();
  const horarios = String(ctx?.horarios || '').split(',')
    .map((h) => h.trim()).filter(Boolean).slice(0, 4);

  const f = 'font-family:Arial,Helvetica,sans-serif';

  const tarjetaSimce = Number.isFinite(simce) ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#f2f6fc;border-left:4px solid ${MARCA.rojo};border-radius:0 10px 10px 0">
      <tr>
        <td width="46%" style="padding:16px 6px 16px 18px;${f};border-right:1px solid #dde5f0" valign="top">
          <span style="font-size:34px;font-weight:bold;color:${MARCA.rojo}">${Math.round(simce)}</span>
          <span style="font-size:13px;font-weight:bold;color:${MARCA.navy}">&nbsp;puntos</span>
          <div style="font-size:12.5px;font-weight:bold;color:${MARCA.navy};padding-top:4px">
            SIMCE Matemática 4º básico${anio ? ` ${escaparHtml(anio)}` : ''}</div>
        </td>
        <td style="padding:16px 18px 16px 16px;${f}" valign="top">
          ${brecha > 0 ? `
          <span style="font-size:34px;font-weight:bold;color:${MARCA.rojo}">${brecha}</span>
          <span style="font-size:13px;font-weight:bold;color:${MARCA.rojo}">&nbsp;puntos bajo el<br>
            <span style="padding-left:2px">promedio nacional (${ctx?.promedio || 253})</span></span>
          <div style="font-size:12.5px;color:#5a6b84;padding-top:5px">
            Una brecha que un método estructurado puede cerrar.</div>`
    : `<div style="font-size:13px;color:#5a6b84;padding-top:8px">
            Promedio nacional: ${ctx?.promedio || 253} puntos.</div>`}
        </td>
      </tr>
    </table>` : '';

  const chips = horarios.length ? `
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      ${horarios.map((h) => {
    const [dia, ...resto] = h.split(/\s+/);
    return `<td style="padding:0 10px 0 0"><table role="presentation" cellpadding="0" cellspacing="0">
        <tr><td style="background:#eef2f8;border-radius:8px;padding:9px 13px;${f};font-size:13px">
          <img src="${img('ic-cal-chip')}" width="14" alt="" style="vertical-align:-2px;border:0">
          &nbsp;<b style="color:${MARCA.navy}">${escaparHtml(dia)}</b>
          &nbsp;<span style="color:#3d4c63">${escaparHtml(resto.join(' '))}</span>
        </td></tr></table></td>`;
  }).join('')}
    </tr></table>` : '';

  const beneficios = [
    ['ic-grafico', 'Mejora significativa en resultados SIMCE.'],
    ['ic-personas', 'Menos brechas, más estudiantes comprendiendo.'],
    ['ic-lista', 'Docentes con secuencias claras y fáciles de aplicar.'],
    ['ic-diana', 'Progreso medible clase a clase.'],
  ].map(([icono, txt], i) => `
    <td width="25%" align="center" valign="top"
        style="padding:4px 8px;${f};font-size:12px;line-height:1.45;color:#2c4a38;
        ${i ? 'border-left:1px solid #d8e8dc' : ''}">
      <img src="${img(icono)}" width="34" alt="" style="border:0"><br>
      <span style="display:inline-block;padding-top:6px">${txt}</span>
    </td>`).join('');

  const botonWa = wa ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center" style="background:#1faa4f;border-radius:10px">
        <a href="${enlace(wa)}" style="display:block;padding:15px 20px;${f};font-size:16px;
          font-weight:bold;color:#ffffff;text-decoration:none">
          <img src="${img('ic-wa-blanco')}" width="20" alt="" style="vertical-align:-4px;border:0">
          &nbsp;Agendar reunión de 30 minutos por WhatsApp&nbsp;&nbsp;&#8250;</a>
      </td></tr>
    </table>
    <div style="${f};font-size:12.5px;color:#5a6b84;padding-top:8px" align="center">
      o simplemente responda este correo — contesto personalmente.</div>` : `
    <div style="${f};font-size:14px;color:#333333;padding:2px 0 6px">
      Responda este correo y coordinamos una reunión de 30 minutos — contesto personalmente.</div>`;

  const filaContacto = (icono, contenido) => `
    <tr><td style="padding:5px 0;${f};font-size:13px">
      <img src="${img(icono)}" width="16" alt="" style="vertical-align:-3px;border:0">
      &nbsp;&nbsp;${contenido}</td></tr>`;
  const contactos = [
    waVisible ? filaContacto('ic-wa',
      `<a href="${enlace(wa)}" style="color:${MARCA.navy};text-decoration:none;font-weight:bold">${waVisible}</a>`) : '',
    remitente ? filaContacto('ic-mail',
      `<a href="mailto:${escaparHtml(remitente)}" style="color:${MARCA.navy};text-decoration:none">${escaparHtml(remitente)}</a>`) : '',
    sitio ? filaContacto('ic-globo',
      `<a href="${enlace(sitio)}" style="color:${MARCA.navy};text-decoration:none">${escaparHtml(sitio.replace(/^https?:\/\//, ''))}</a>`) : '',
  ].filter(Boolean).join('');

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${MARCA.fondo}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">
  Una oportunidad concreta para matemática en ${colegio || 'su establecimiento'} &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${MARCA.fondo}">
  <tr><td align="center" style="padding:26px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0"
           style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden">
      <tr><td colspan="2" style="height:5px;background:${MARCA.rojo};font-size:0">&nbsp;</td></tr>

      <tr><td colspan="2" style="padding:24px 32px 4px">
        <img src="${base}${MARCA.logo}" width="168" alt="JUMP Math Chile"
             style="display:block;border:0;max-width:168px">
      </td></tr>

      <tr>
        <td style="padding:18px 6px 0 32px;${f}" valign="top">
          <div style="font-size:12px;font-weight:bold;letter-spacing:.09em;
            text-transform:uppercase;color:${MARCA.rojo}">${colegio}${comuna
    ? `&nbsp;&nbsp;<span style="color:#8a93a3;font-weight:normal">·&nbsp;&nbsp;${comuna}</span>` : ''}</div>
          <div style="font-size:25px;line-height:1.25;font-weight:bold;color:${MARCA.navy};
            padding:6px 0 2px">Una oportunidad concreta para seguir mejorando</div>
          <div style="font-size:22px;line-height:1.3;color:${MARCA.navy}">en Matemática 4º básico.</div>
        </td>
        <td width="215" style="padding:10px 26px 0 0" valign="top" align="right">
          <img src="${img('ilustracion')}" width="205" alt=""
               style="display:block;border:0;max-width:205px">
        </td>
      </tr>

      <tr><td colspan="2" style="padding:14px 32px 14px;${f};font-size:15px;color:#333333">
        Estimado equipo directivo:
      </td></tr>

      ${tarjetaSimce ? `<tr><td colspan="2" style="padding:0 32px 16px">${tarjetaSimce}</td></tr>` : ''}

      <tr><td colspan="2" style="padding:0 32px 18px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="background:#f4f6f9;border-radius:999px">
          <tr><td style="padding:9px 18px;${f};font-size:12px;color:#5a6b84" align="center">
            <img src="${img('ic-globo')}" width="15" alt="" style="vertical-align:-3px;border:0">
            &nbsp;Creado en Canadá &nbsp;·&nbsp; Ensayos controlados aleatorizados
            &nbsp;·&nbsp; Canadá, EE.&nbsp;UU. y España</td></tr>
        </table>
      </td></tr>

      <tr><td colspan="2" style="padding:0 32px 4px;${f}">
        <div style="font-size:16px;font-weight:bold;color:${MARCA.navy};padding-bottom:6px">
          ¿Qué es JUMP Math?</div>
        <div style="font-size:14.5px;line-height:1.6;color:#333333">${cuerpo}</div>
      </td></tr>

      <tr><td colspan="2" style="padding:16px 32px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="background:#eef7f0;border-radius:12px">
          <tr><td colspan="4" style="padding:16px 18px 8px;${f};font-size:15px;
            font-weight:bold;color:#1e6b40">¿Qué logran los colegios con JUMP Math?</td></tr>
          <tr>${beneficios}</tr>
          <tr><td colspan="4" style="font-size:0;height:16px">&nbsp;</td></tr>
        </table>
      </td></tr>

      <tr>
        <td width="86" style="padding:22px 0 0 32px" valign="top">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="background:#eaf0f8;border-radius:50%;width:64px;height:64px" align="center" valign="middle">
              <img src="${img('ic-cal-navy')}" width="34" alt="" style="border:0;vertical-align:middle">
            </td></tr></table>
        </td>
        <td style="padding:22px 32px 0 14px;${f}" valign="top">
          <div style="font-size:16.5px;font-weight:bold;color:${MARCA.navy};padding-bottom:4px">
            ¿Revisamos juntos cómo funciona${comuna ? ` en ${comuna}` : ''}?</div>
          <div style="font-size:14px;line-height:1.55;color:#333333;padding-bottom:10px">
            Podemos reunirnos 30 minutos para mostrarles cómo implementarlo
            y los resultados que han obtenido otros colegios.</div>
          ${chips}
        </td>
      </tr>

      <tr><td colspan="2" style="padding:18px 32px 6px">${botonWa}</td></tr>

      <tr><td colspan="2" style="padding:14px 32px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="background:#fdefee;border-radius:10px">
          <tr>
            <td width="52" style="padding:13px 0 13px 16px" valign="middle">
              <img src="${img('ic-cal-rojo')}" width="30" alt="" style="border:0"></td>
            <td style="padding:13px 16px 13px 6px;${f};font-size:13px;line-height:1.5;color:#333333">
              Los programas que comienzan con el <b style="color:${MARCA.rojo}">año escolar 2027</b>
              se están definiendo durante estas semanas, por lo que este es un buen momento
              para evaluarlo.</td>
          </tr>
        </table>
      </td></tr>

      <tr><td colspan="2" style="padding:20px 32px 0">
        <div style="border-top:1px solid #e6e9ef;font-size:0">&nbsp;</div>
      </td></tr>
      <tr>
        <td style="padding:6px 6px 26px 32px;${f}" valign="top">
          <img src="${base}${MARCA.firma}" width="205" alt="${escaparHtml(MARCA.firmante)}"
               style="display:block;border:0;max-width:205px">
          <div style="font-size:15px;font-weight:bold;color:${MARCA.navy};padding-top:8px">
            ${escaparHtml(MARCA.firmante)}</div>
          <div style="font-size:13px;color:#5a6b84;padding-top:1px">${escaparHtml(MARCA.cargo)}</div>
        </td>
        <td width="235" style="padding:14px 32px 26px 16px;border-left:1px solid #e6e9ef" valign="middle">
          <table role="presentation" cellpadding="0" cellspacing="0">${contactos}</table>
        </td>
      </tr>
    </table>

    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
      <tr><td style="padding:14px 20px;${f};font-size:11px;line-height:1.5;color:#8a93a3" align="center">
        Le escribimos porque ${colegio || 'su establecimiento'} figura en el directorio público
        de establecimientos de MINEDUC. Si prefiere no recibir más información,<br>
        responda este correo con la palabra BAJA.
      </td></tr>
    </table>
  </td></tr>
</table>${pixel}</body></html>`;
}

/** RFC 2822 en base64url, que es lo que espera la API de Gmail. */
function mensajeCrudo({ para, asunto, html, texto, de }) {
  const limite = `lim_${Math.random().toString(36).slice(2)}`;
  const b64 = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const x of bytes) bin += String.fromCharCode(x);
    return btoa(bin);
  };
  // RFC 2045: el base64 del cuerpo va en lineas de hasta 76 columnas. Una
  // sola linea de miles de caracteres viola el largo maximo de linea de
  // correo y hay agentes que al repararla pierden metadatos por el camino.
  const plegar = (s) => s.replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');

  /* Una palabra codificada MIME admite 75 caracteres como maximo: un
     asunto con nombre de colegio la excede y queda a merced de como cada
     servidor la repare. Se parte en trozos legales, cuidando no cortar un
     caracter multibyte por la mitad. */
  const asuntoMime = (s) => {
    const trozos = [];
    let actual = '';
    for (const ch of String(s)) {
      if (new TextEncoder().encode(actual + ch).length > 42) {
        trozos.push(actual);
        actual = ch;
      } else actual += ch;
    }
    if (actual) trozos.push(actual);
    return trozos.map((t) => `=?UTF-8?B?${b64(t)}?=`).join('\r\n ');
  };

  const cabeceras = [
    `From: ${de}`,
    `To: ${para}`,
    `Subject: ${asuntoMime(asunto)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${limite}"`,
  ].join('\r\n');

  const cuerpo = [
    '', `--${limite}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64', '', plegar(b64(texto)),
    `--${limite}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64', '', plegar(b64(html)),
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
