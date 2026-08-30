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
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, deleteField,
  query, orderBy, limit, where, writeBatch, serverTimestamp, increment,
  documentId,
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

/** Enlace de baja de un destinatario concreto, que atiende la función de
 *  seguimiento. Va en la cabecera List-Unsubscribe y en el pie. */
export const urlBaja = (base, campanaId, rbd) =>
  (base && campanaId && rbd ? `${base}/t/baja/${campanaId}/${rbd}` : '');

/* Identidad del correo. El logo y la firma viven en Hosting, así que los
   clientes los cargan por URL absoluta. Para usar el logotipo oficial
   basta reemplazar web/img/logo-jumpmath.png y volver a desplegar. */
const MARCA = {
  navy: '#14345c',
  rojo: '#e8443a',
  fondo: '#eef1f5',
  logo: '/img/logo-jumpmath.png',
  /* Gmail sirve las imágenes desde su propio proxy y las cachea por URL.
     Al cambiar el archivo hay que cambiar la versión, o los envíos nuevos
     siguen mostrando la firma antigua. */
  firma: '/img/firma-macarena.png?v=2',
  firmante: 'Macarena Bascour F.',
  cargo: 'Directora · JUMP Math Chile',
  /* Lo primero que se ve en la bandeja es el nombre del remitente, antes
     que el asunto: una dirección suelta parece automática. */
  remitenteNombre: 'Macarena Bascour · JUMP Math Chile',
  /* Identificar a quién escribe, con ciudad, es práctica estándar
     antispam y sube la confianza del que recibe en frío. */
  identidad: 'JUMP Math Chile · Santiago de Chile',
};

/* Dos modos y cinco plantillas. El modo decide los colores; la plantilla,
   qué bloques aparecen y con qué forma. Separarlos evita diez piezas de
   HTML distintas que se desincronizan a la primera corrección. */
export const TEMAS = {
  claro: {
    nombre: 'Claro',
    fondo: '#eef1f5', tarjeta: '#ffffff',
    tinta: '#333333', tinta2: '#5a6b84', tinta3: '#8a93a3',
    linea: '#e6e9ef', suave: '#f2f6fc', pastilla: '#f4f6f9',
    titulo: '#14345c', acento: '#e8443a',
    verdeFondo: '#eef7f0', verdeTitulo: '#1e6b40', verdeTexto: '#2c4a38',
    urgencia: '#fdefee', chip: '#eef2f8', chipTinta: '#3d4c63',
    logo: '/img/logo-jumpmath.png?v=3',
    firma: '/img/firma-macarena.png?v=2',
  },
  oscuro: {
    nombre: 'Oscuro',
    fondo: '#080d14', tarjeta: '#131c26',
    tinta: '#e4ebf3', tinta2: '#a3b3c6', tinta3: '#7b8a9c',
    linea: '#26313f', suave: '#1a2735', pastilla: '#1a2735',
    // Sobre fondo oscuro, el navy de marca no se lee: sube a un azul claro.
    titulo: '#9dbcf0', acento: '#ff7063',
    verdeFondo: '#14261c', verdeTitulo: '#7cc79b', verdeTexto: '#bdd7c7',
    urgencia: '#2a1a1c', chip: '#1f2c3b', chipTinta: '#b6c4d4',
    logo: '/img/logo-jumpmath-oscuro.png?v=3',
    // La misma firma con tinta clara: un filtro CSS no lo resuelve,
    // porque los clientes de correo no lo aplican.
    firma: '/img/firma-macarena-oscura.png?v=1',
  },
};

export const PLANTILLAS = {
  lamina: {
    nombre: 'Lámina',
    idea: 'La completa: ilustración, cifras a dos columnas y beneficios en rejilla.',
    ilustracion: true, cifras: 'tarjeta', beneficios: 'rejilla',
    prueba: true, reunion: true, urgencia: true,
  },
  carta: {
    nombre: 'Carta',
    idea: 'Sobria, sin imágenes ni cajas. Se lee como una carta escrita a mano.',
    ilustracion: false, cifras: 'linea', beneficios: 'lista',
    prueba: false, reunion: true, urgencia: false,
  },
  titular: {
    nombre: 'Titular',
    idea: 'Abre con la brecha en grande sobre una banda de color. Directa al dolor.',
    ilustracion: false, cifras: 'banda', beneficios: 'rejilla',
    prueba: true, reunion: true, urgencia: true,
  },
  ficha: {
    nombre: 'Ficha',
    idea: 'Estética de informe: los datos en filas, líneas finas, cero adornos.',
    ilustracion: false, cifras: 'tabla', beneficios: 'lista',
    prueba: true, reunion: true, urgencia: false,
  },
  minimo: {
    nombre: 'Mínimo',
    idea: 'Sólo saludo, dato, texto y botón. El que mejor pasa los filtros.',
    ilustracion: false, cifras: 'linea', beneficios: 'ninguno',
    prueba: false, reunion: false, urgencia: false,
  },
};

/**
 * El correo completo como pieza diseñada, pero construida en HTML.
 *
 * A propósito NO es una imagen con el texto adentro: los correos
 * imagen-sin-texto puntúan alto en los filtros de spam, y Outlook —común
 * en colegios— bloquea imágenes por defecto, con lo que el destinatario
 * vería un rectángulo vacío. Acá el nombre del colegio y su SIMCE son
 * texto real con aspecto de lámina: llegan aunque las imágenes no.
 * Tablas y estilos en línea porque es lo único que respetan los clientes
 * de correo.
 */
export function correoHtml({ texto, prospecto, ctx, base, campanaId, rbd, track, breve }) {
  const T = TEMAS[ctx?.tema] || TEMAS.claro;
  const P = PLANTILLAS[ctx?.plantilla] || PLANTILLAS.lamina;

  /* Todo enlace pasa por el registro de clics cuando hay seguimiento: un
     clic en el botón de WhatsApp es la señal de compra más fuerte que
     produce esta pieza. */
  const enlace = (url) => (track
    ? `${base}/t/c/${campanaId}/${rbd}?u=${encodeURIComponent(url)}`
    : url);
  const img = (nombre) => `${base}/img/${nombre}.png`;

  let cuerpo = escaparHtml(texto).replace(/\n/g, '<br>');
  cuerpo = cuerpo.replace(/(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${enlace(url)}" style="color:${T.titulo}">${url}</a>`);
  const pixel = track
    ? `<img src="${base}/t/o/${campanaId}/${rbd}" width="1" height="1" alt="" style="display:none">`
    : '';

  const colegio = escaparHtml(titulo(prospecto?.establecimiento || ''));
  const comuna = escaparHtml(titulo(prospecto?.comuna || ''));
  const simce = Number(prospecto?.simceMate);
  const anio = prospecto?.simceAnio || '';
  const promedio = ctx?.promedio || 253;
  const brecha = Number.isFinite(simce) ? Math.round(promedio - simce) : null;

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
  // Hasta seis bloques, en filas de tres: más de tres en una línea no
  // caben en 600 px y llegan cortados.
  const horarios = String(ctx?.horarios || '').split(',')
    .map((h) => h.trim()).filter(Boolean).slice(0, 6);
  /* La página de evidencia sólo se enlaza cuando quien envía la activa:
     una promesa de pruebas que lleva a una página a medio escribir hace
     más daño que no prometer nada. El WhatsApp viaja en la dirección para
     que la página no tenga que guardar un número que después cambie. */
  const evidencia = ctx?.evidencia && base
    ? `${base}/evidencia.html${waNum.length >= 11 ? `?wa=${waNum}` : ''}` : '';
  const bajaUrl = ctx?.funcion ? urlBaja(base, campanaId, rbd) : '';

  const f = 'font-family:Arial,Helvetica,sans-serif';
  const M = 'padding-left:34px;padding-right:34px';
  const fila = (contenido, arriba = 0, abajo = 0) => `<tr><td style="${M}${
    arriba ? `;padding-top:${arriba}px` : ''}${abajo ? `;padding-bottom:${abajo}px` : ''}">${
    contenido}</td></tr>`;

  const gancho = escaparHtml([
    brecha > 0
      ? `${brecha} puntos bajo el promedio nacional en Matemática 4º básico`
      : 'Matemática 4º básico con un método con evidencia',
    horarios.length
      ? `${horarios.length} horarios concretos para una reunión de 30 minutos`
      : 'Una reunión de 30 minutos para mostrarles cómo funciona',
  ].join(' · '));

  // ---------- bloques ----------
  const logo = (ancho = 190) => `<img src="${base}${T.logo}" width="${ancho}"
    alt="JUMP Math Chile" style="display:block;border:0;max-width:${ancho}px">`;

  const kicker = `<div style="${f};font-size:12px;font-weight:bold;letter-spacing:.08em;
    text-transform:uppercase;color:${T.acento}">${colegio}${comuna
    ? `<span style="color:${T.tinta3};font-weight:normal">&nbsp;&nbsp;·&nbsp;&nbsp;${comuna}</span>` : ''}</div>`;

  const titular = `<div style="${f};font-size:24px;line-height:1.3;color:${T.titulo}">
    <b>Una oportunidad concreta</b> para seguir mejorando en
    <b>Matemática 4º básico.</b></div>`;

  const cifra = (num, etiqueta, nota, color) => `
    <div style="${f};font-size:36px;line-height:1;font-weight:bold;color:${color}">${num}</div>
    <div style="${f};font-size:12.5px;font-weight:bold;line-height:1.35;
      color:${T.titulo};padding-top:7px">${etiqueta}</div>
    ${nota ? `<div style="${f};font-size:12px;line-height:1.4;color:${T.tinta2};
      padding-top:4px">${nota}</div>` : ''}`;

  const etiquetaSimce = `puntos en SIMCE Matemática<br>4º básico${anio ? ` ${escaparHtml(anio)}` : ''}`;

  function bloqueCifras() {
    if (!Number.isFinite(simce)) return '';
    if (P.cifras === 'tarjeta') {
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:${T.suave};border-left:4px solid ${T.acento};border-radius:0 10px 10px 0">
        <tr>
          <td width="50%" valign="top" style="padding:18px 16px 18px 20px;border-right:1px solid ${T.linea}">
            ${cifra(Math.round(simce), etiquetaSimce, '', T.titulo)}</td>
          <td width="50%" valign="top" style="padding:18px 20px 18px 18px">
            ${brecha > 0
    ? cifra(brecha, `puntos bajo el promedio<br>nacional (${promedio})`,
      'Una brecha que un método estructurado puede cerrar.', T.acento)
    : cifra(promedio, 'es el promedio nacional<br>de referencia', '', T.titulo)}</td>
        </tr></table>`;
    }
    if (P.cifras === 'banda') {
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:${T.acento};border-radius:12px">
        <tr><td style="padding:26px 28px;${f}" align="center">
          <div style="font-size:56px;line-height:1;font-weight:bold;color:#ffffff">
            ${brecha > 0 ? brecha : Math.round(simce)}</div>
          <div style="font-size:15px;line-height:1.45;color:#ffffff;padding-top:10px">
            ${brecha > 0
    ? `puntos bajo el promedio nacional<br>en Matemática 4º básico${anio ? ` (${escaparHtml(anio)})` : ''}`
    : `puntos en SIMCE Matemática 4º básico${anio ? ` ${escaparHtml(anio)}` : ''}`}</div>
        </td></tr></table>`;
    }
    if (P.cifras === 'tabla') {
      const renglon = (a, b, ultimo) => `<tr>
        <td style="padding:11px 0;${f};font-size:13.5px;color:${T.tinta2}${
  ultimo ? '' : `;border-bottom:1px solid ${T.linea}`}">${a}</td>
        <td align="right" style="padding:11px 0;${f};font-size:14px;font-weight:bold;
          color:${T.tinta}${ultimo ? '' : `;border-bottom:1px solid ${T.linea}`}">${b}</td></tr>`;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="border-top:2px solid ${T.titulo}">
        ${renglon(`SIMCE Matemática 4º básico${anio ? ` · ${escaparHtml(anio)}` : ''}`,
    `${Math.round(simce)} puntos`)}
        ${renglon('Promedio nacional de referencia', `${promedio} puntos`)}
        ${brecha > 0
    ? renglon('<b style="color:' + T.acento + '">Brecha</b>',
      `<span style="color:${T.acento}">${brecha} puntos</span>`, true)
    : renglon('Sobre el promedio', 'sí', true)}
      </table>`;
    }
    // 'linea': una sola frase, sin caja
    return `<div style="${f};font-size:14.5px;line-height:1.6;color:${T.tinta}">
      Su establecimiento obtuvo <b style="color:${T.titulo}">${Math.round(simce)} puntos</b>
      en SIMCE Matemática de 4º básico${anio ? ` (${escaparHtml(anio)})` : ''}${brecha > 0
    ? `, <b style="color:${T.acento}">${brecha} bajo el promedio nacional</b> de ${promedio}.`
    : `, sobre el promedio nacional de ${promedio}.`}</div>`;
  }

  const BENEFICIOS = [
    ['ic-grafico', 'Mejora significativa en los resultados SIMCE.'],
    ['ic-personas', 'Aumento de motivación y autoestima académica.'],
    ['ic-lista', 'Docentes con secuencias claras y fáciles de aplicar.'],
    ['ic-diana', 'Alineado a las Bases Curriculares del Mineduc.'],
  ];

  function bloqueBeneficios() {
    if (P.beneficios === 'ninguno') return '';
    const titulo2 = `<div style="${f};font-size:15px;font-weight:bold;color:${T.verdeTitulo};
      padding-bottom:10px">¿Qué logran los colegios con JUMP Math?</div>`;

    if (P.beneficios === 'lista') {
      // Sin caja de color: filas con un punto de acento. Encaja con las
      // plantillas sobrias, donde un panel verde desentonaría.
      return `${titulo2}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${BENEFICIOS.map(([, txt]) => `<tr>
            <td width="18" valign="top" style="${f};font-size:14px;line-height:1.6;
              color:${T.verdeTitulo}">•</td>
            <td style="${f};font-size:14px;line-height:1.6;color:${T.tinta};
              padding-bottom:5px">${txt}</td></tr>`).join('')}
        </table>`;
    }
    const celda = ([icono, txt]) => `
      <td width="50%" valign="top" style="padding:7px 12px 7px 0">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
          <td width="40" valign="top" style="padding-top:1px">
            <img src="${img(icono)}" width="30" alt="" style="display:block;border:0"></td>
          <td valign="top" style="${f};font-size:13px;line-height:1.5;color:${T.verdeTexto}">${txt}</td>
        </tr></table></td>`;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:${T.verdeFondo};border-radius:12px">
      <tr><td colspan="2" style="padding:16px 18px 4px">${titulo2}</td></tr>
      <tr><td colspan="2" style="padding:0 8px 0 18px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>${celda(BENEFICIOS[0])}${celda(BENEFICIOS[1])}</tr>
          <tr>${celda(BENEFICIOS[2])}${celda(BENEFICIOS[3])}</tr>
        </table></td></tr>
      <tr><td colspan="2" style="font-size:0;height:14px">&nbsp;</td></tr>
    </table>`;
  }

  const chip = (h) => {
    const [dia, ...resto] = h.split(/\s+/);
    return `<td style="padding:0 8px 8px 0"><table role="presentation" cellpadding="0" cellspacing="0">
        <tr><td style="background:${T.chip};border-radius:8px;padding:9px 14px;${f};
          font-size:13px;white-space:nowrap">
          <b style="color:${T.titulo}">${escaparHtml(dia)}</b>
          &nbsp;<span style="color:${T.chipTinta}">${escaparHtml(resto.join(' '))}</span>
        </td></tr></table></td>`;
  };
  const filasChips = [];
  for (let i = 0; i < horarios.length; i += 3) filasChips.push(horarios.slice(i, i + 3));
  const chips = horarios.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0">${
      filasChips.map((r) => `<tr>${r.map(chip).join('')}</tr>`).join('')}</table>`
    : '';

  const botonWa = wa ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center" style="background:#1faa4f;border-radius:10px">
        <a href="${enlace(wa)}" style="display:block;padding:15px 20px;${f};font-size:16px;
          font-weight:bold;color:#ffffff;text-decoration:none">
          Agendar reunión de 30 minutos por WhatsApp&nbsp;&nbsp;&#8250;</a>
      </td></tr>
    </table>
    <div style="${f};font-size:12.5px;color:${T.tinta2};padding-top:9px" align="center">
      o simplemente responda este correo — contesto personalmente.</div>` : `
    <div style="${f};font-size:14px;color:${T.tinta};padding:2px 0 6px">
      Responda este correo y coordinamos una reunión de 30 minutos — contesto personalmente.</div>`;

  const filaContacto = (icono, contenido) => `
    <tr><td style="padding:0 0 9px;${f};font-size:13px;color:${T.tinta2}">
      ${icono}&nbsp;&nbsp;${contenido}</td></tr>`;
  const contactos = [
    waVisible ? filaContacto('WhatsApp',
      `<a href="${enlace(wa)}" style="color:${T.titulo};text-decoration:none;font-weight:bold">${waVisible}</a>`) : '',
    remitente ? filaContacto('Correo',
      `<a href="mailto:${escaparHtml(remitente)}" style="color:${T.titulo};text-decoration:none">${escaparHtml(remitente)}</a>`) : '',
    sitio ? filaContacto('Sitio',
      `<a href="${enlace(sitio)}" style="color:${T.titulo};text-decoration:none">${escaparHtml(sitio.replace(/^https?:\/\//, ''))}</a>`) : '',
  ].filter(Boolean).join('');

  const firma = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="top" style="${f}">
        <img src="${base}${T.firma}" width="196" alt="${escaparHtml(MARCA.firmante)}"
             style="display:block;border:0;max-width:196px">
        <div style="font-size:15px;font-weight:bold;color:${T.titulo};padding-top:10px">
          ${escaparHtml(MARCA.firmante)}</div>
        <div style="font-size:13px;color:${T.tinta2};padding-top:2px">${escaparHtml(MARCA.cargo)}</div>
      </td>
      <td width="222" valign="top" style="padding-left:20px;border-left:1px solid ${T.linea}">
        <table role="presentation" cellpadding="0" cellspacing="0">${contactos}</table>
      </td>
    </tr></table>`;

  const pie = `<table role="presentation" width="600" cellpadding="0" cellspacing="0"
      style="max-width:600px;width:100%">
    <tr><td align="center" style="padding:16px 24px;${f};font-size:11px;line-height:1.6;color:${T.tinta3}">
      <b style="color:${T.tinta2}">${escaparHtml(MARCA.identidad)}</b><br>
      Le escribimos porque ${colegio || 'su establecimiento'} figura en el directorio público
      de establecimientos de MINEDUC.<br>
      Si prefiere no recibir más información, responda este correo con la palabra BAJA${bajaUrl
  ? ` o <a href="${bajaUrl}" style="color:${T.tinta3}">use este enlace</a>` : ''}.
    </td></tr></table>`;

  const cabezaHtml = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${ctx?.tema === 'oscuro' ? 'dark' : 'light'}"></head>`;

  const envolver = (interior) => `${cabezaHtml}
<body style="margin:0;padding:0;background:${T.fondo}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">
  ${gancho} &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.fondo}">
  <tr><td align="center" style="padding:26px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0"
           style="max-width:600px;width:100%;background:${T.tarjeta};border-radius:14px;overflow:hidden">
      <tr><td style="height:5px;background:${T.acento};font-size:0">&nbsp;</td></tr>
      ${interior}
    </table>
    ${pie}
  </td></tr>
</table>${pixel}</body></html>`;

  /* Un seguimiento va dentro del hilo del primer correo: quien lo abre ya
     vio la lámina completa. Repetirla se lee como ruido publicitario, así
     que el recordatorio es corto y sólo repone lo accionable. */
  if (breve) {
    return envolver(`
      ${fila(`<div style="${f};font-size:15px;line-height:1.65;color:${T.tinta}">${cuerpo}</div>`, 22)}
      ${chips ? fila(chips, 16) : ''}
      ${fila(botonWa, 18)}
      ${fila(`<div style="border-top:1px solid ${T.linea};font-size:0">&nbsp;</div>`, 20)}
      ${fila(firma, 12, 24)}`);
  }

  const bloques = [];
  bloques.push(fila(logo(P.cifras === 'linea' && P.beneficios === 'ninguno' ? 150 : 190), 24, 16));

  if (P.cifras === 'banda') bloques.push(fila(bloqueCifras(), 0, 20));

  bloques.push(fila(kicker, 0, 2));
  if (P.ilustracion) {
    bloques.push(fila(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle">${titular}</td>
      <td width="180" valign="middle" align="right">
        <img src="${img('ilustracion')}" width="172" alt=""
             style="display:block;border:0;max-width:172px"></td></tr></table>`, 6, 6));
  } else if (P.cifras !== 'banda') {
    bloques.push(fila(titular, 6, 6));
  }

  bloques.push(fila(`<div style="${f};font-size:15px;color:${T.tinta}">Estimado equipo directivo:</div>`, 8, 14));

  if (P.cifras !== 'banda') {
    const c = bloqueCifras();
    if (c) bloques.push(fila(c, 0, 18));
  }

  bloques.push(fila(`<div style="${f}">
    ${P.beneficios === 'ninguno' ? '' : `<div style="font-size:17px;font-weight:bold;
      color:${T.titulo};padding-bottom:8px">¿Qué es JUMP Math?</div>`}
    <div style="font-size:14.5px;line-height:1.65;color:${T.tinta}">${cuerpo}</div>
    ${evidencia ? `<div style="font-size:14px;padding-top:10px">
      <a href="${enlace(evidencia)}" style="color:${T.acento};font-weight:bold;text-decoration:none">
        Ver la evidencia en 2 minutos&nbsp;&#8250;</a></div>` : ''}
  </div>`, 0, 6));

  if (P.prueba) {
    bloques.push(fila(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="background:${T.pastilla};border-radius:999px">
      <tr><td align="center" style="padding:9px 18px;${f};font-size:12px;color:${T.tinta2}">
        Creado en Canadá &nbsp;·&nbsp; Ensayos controlados aleatorizados
        &nbsp;·&nbsp; Canadá, EE.&nbsp;UU. y España</td></tr></table>`, 14, 4));
  }

  const ben = bloqueBeneficios();
  if (ben) bloques.push(fila(ben, 16));

  if (P.reunion) {
    bloques.push(fila(`<div style="${f};font-size:16.5px;font-weight:bold;color:${T.titulo}">
      ¿Revisamos juntos cómo funciona${comuna ? ` en ${comuna}` : ''}?</div>`, 24));
    bloques.push(fila(`<div style="${f};font-size:14px;line-height:1.6;color:${T.tinta}">
      Podemos reunirnos 30 minutos para mostrarles cómo implementarlo
      y los resultados que han obtenido otros colegios.</div>`, 9));
    if (chips) bloques.push(fila(chips, 14));
  }

  bloques.push(fila(botonWa, 18));

  if (P.urgencia) {
    bloques.push(fila(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="background:${T.urgencia};border-radius:10px">
      <tr><td style="padding:14px 18px;${f};font-size:13px;line-height:1.55;color:${T.tinta}">
        Los programas que comienzan con el <b style="color:${T.acento}">año escolar 2027</b>
        se están definiendo durante estas semanas, por lo que este es un buen momento
        para evaluarlo.</td></tr></table>`, 18));
  }

  bloques.push(fila(`<div style="border-top:1px solid ${T.linea};font-size:0">&nbsp;</div>`, 22));
  bloques.push(fila(firma, 14, 28));
  return envolver(bloques.join(''));
}

/** RFC 2822 en base64url, que es lo que espera la API de Gmail. */
function mensajeCrudo({ para, asunto, html, texto, de, deNombre, bajaUrl }) {
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

  /* El nombre visible del remitente es lo primero que se lee en la
     bandeja. Si trae tildes o guiones largos hay que codificarlo igual
     que el asunto; si no, va entre comillas tal cual. */
  const nombreMime = (s) => (/[^\x20-\x7e]/.test(s) ? asuntoMime(s)
    : `"${String(s).replace(/["\\]/g, '')}"`);

  const cabeceras = [
    `From: ${deNombre ? `${nombreMime(deNombre)} <${de}>` : de}`,
    `To: ${para}`,
    `Subject: ${asuntoMime(asunto)}`,
    'MIME-Version: 1.0',
    /* Gmail exige la baja de un clic a quien envía en volumen, y premia
       tenerla: pinta su propio botón "Darse de baja", que la gente usa en
       vez de marcar como spam. */
    ...(bajaUrl
      ? [`List-Unsubscribe: <mailto:${de}?subject=BAJA>, <${bajaUrl}>`,
        'List-Unsubscribe-Post: List-Unsubscribe=One-Click']
      : [`List-Unsubscribe: <mailto:${de}?subject=BAJA>`]),
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
    asuntoB: campana.asuntoB || '',
    cuerpoB: campana.cuerpoB || '',
    seguimientoDe: campana.seguimientoDe || '',
    evidencia: Boolean(campana.evidencia),
    plantilla: campana.plantilla || 'lamina',
    tema: campana.tema || 'claro',
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
          // Un seguimiento hereda el hilo del correo original para poder
          // contestar dentro de él.
          ...(p.threadId ? { threadId: p.threadId } : {}),
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
  // Un seguimiento responde dentro del hilo original y con pieza breve.
  const esSeguimiento = Boolean(campana.seguimientoDe);
  // Con variante B el reparto es alternado, no por mitades: el segmento
  // llega ordenado por dolor o matrícula, y cortarlo en dos daría a cada
  // variante una población distinta.
  const usaB = Boolean(campana.asuntoB || campana.cuerpoB);
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

    const variante = usaB && i % 2 === 1 ? 'B' : 'A';
    const prospecto = ctx.prospectos.get(String(d.rbd)) || d;
    const asunto = aplicarVariables(
      variante === 'B' && campana.asuntoB ? campana.asuntoB : campana.asunto, prospecto, ctx);
    const texto = aplicarVariables(
      variante === 'B' && campana.cuerpoB ? campana.cuerpoB : campana.cuerpo, prospecto, ctx);
    const html = correoHtml({
      texto, prospecto, ctx, breve: esSeguimiento,
      base, campanaId: campana.id, rbd: d.rbd, track: campana.track,
    });

    try {
      const peticion = {
        raw: mensajeCrudo({
          para: d.email, asunto, html, texto, de: gmailCorreo(),
          deNombre: MARCA.remitenteNombre,
          bajaUrl: ctx.funcion ? urlBaja(base, campana.id, d.rbd) : '',
        }),
      };
      /* Con threadId, Gmail cuelga el mensaje del hilo anterior en vez de
         abrir una conversación nueva: el director ve el recordatorio bajo
         el correo que ya recibió, con todo el contexto a la vista. */
      if (esSeguimiento && d.threadId) peticion.threadId = d.threadId;

      const res = await gmail('/messages/send', { method: 'POST', body: JSON.stringify(peticion) });
      await marcar(db, campana.id, d.rbd, {
        estado: 'enviado',
        enviadoEn: serverTimestamp(),
        threadId: res.threadId || d.threadId || '',
        messageId: res.id || '',
        variante,
        error: '',
      });
      enviados += 1;
      await contarEnvio(db);
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

// ---------- calentamiento de la cuenta ----------
/* Una cuenta que nunca envió correo frío y arranca con 450 mensajes el
   primer día termina en spam o suspendida, y con ella se quema la base
   entera. El contador por día es lo que permite subir por escalones y
   saber cuánto queda de cupo hoy, aunque se envíe desde otro equipo. */
export function diaHoy(d = new Date()) {
  const dos = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
}

async function contarEnvio(db) {
  try {
    await setDoc(doc(db, 'envios', diaHoy()),
      { n: increment(1), actualizado: serverTimestamp() }, { merge: true });
  } catch { /* el contador nunca debe hacer fallar un envío real */ }
}

/** Envíos por día, del más reciente al más antiguo. */
export async function historialEnvios(db, dias = 21) {
  const s = await getDocs(query(collection(db, 'envios'),
    orderBy(documentId(), 'desc'), limit(dias)));
  return s.docs.map((d) => ({ dia: d.id, n: Number(d.get('n')) || 0 }));
}

/* Escalones de calentamiento: cada tanda nueva puede duplicar la mayor
   anterior, nunca más. Partir en 25 y llegar al tope en dos semanas es
   el ritmo que Gmail tolera sin castigar la reputación. */
const ESCALONES = [25, 50, 100, 200, 300, LIMITE_DIARIO];

export function tandaRecomendada(historial) {
  const hoy = diaHoy();
  const enviadosHoy = historial.find((h) => h.dia === hoy)?.n || 0;
  const anteriores = historial.filter((h) => h.dia !== hoy && h.n > 0);
  const maximo = anteriores.reduce((a, h) => Math.max(a, h.n), 0);
  const tope = anteriores.length
    ? (ESCALONES.find((e) => e > maximo) || LIMITE_DIARIO)
    : ESCALONES[0];
  return {
    enviadosHoy,
    diasActivos: anteriores.length,
    maximo,
    tope,
    resto: Math.max(0, tope - enviadosHoy),
  };
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
        deNombre: MARCA.remitenteNombre,
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
export async function revisarRespuestas(db, campanaId, alAvanzar, uid) {
  /* Los ya resueltos quedan fuera: un rebote o una baja que se vuelve a
     mirar se volvería a contar, y cada pasada inflaría los totales de la
     campaña con el mismo hilo de siempre. */
  const resueltos = ['respondido', 'rebotado', 'baja'];
  const dest = (await listarDestinatarios(db, campanaId))
    .filter((d) => d.threadId && !resueltos.includes(d.estado));
  let respuestas = 0;
  let rebotes = 0;
  let bajas = 0;
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
        /* El resumen del mensaje viene con la metadata, sin necesidad del
           permiso de lectura completa: alcanza para reconocer una baja
           pedida por respuesta y honrarla sin trabajo manual. */
        const pidioBaja = entrantes.some((m) => /\bbaja\b|desuscribir|no.{0,12}(escrib|contact)/i
          .test(String(m.snippet || '')));
        await marcar(db, campanaId, d.rbd, {
          estado: rebote ? 'rebotado' : pidioBaja ? 'baja' : 'respondido',
          respondidoEn: serverTimestamp(),
        });
        /* Un rebote duro y una baja valen lo mismo para la lista: no se
           les vuelve a escribir nunca, ni en la campaña siguiente. */
        if (rebote || pidioBaja) {
          await registrarBaja(db, d.rbd, {
            email: d.email, campanaId, motivo: rebote ? 'rebote' : 'pidio baja',
          });
        }
        /* Una respuesta que sólo se marca dentro de la campaña se pierde:
           el prospecto seguiría figurando como "contactado" y nadie
           sabría que hay alguien esperando al otro lado. Acá es donde el
           ciclo pasa de campaña a gestión comercial. */
        if (!rebote && !pidioBaja) {
          await avanzarProspecto(db, d.rbd, uid, {
            estadoCrm: 'respondio',
            respondioEn: serverTimestamp(),
          }, `Respondió el correo de la campaña`);
        }
        if (rebote) rebotes += 1;
        else if (pidioBaja) bajas += 1;
        else respuestas += 1;
      }
    } catch (e) {
      if (/401|403|expir/i.test(e.message)) throw e;
    }
    alAvanzar?.({ i: i + 1, total: dest.length });
  }

  if (respuestas || rebotes || bajas) {
    await updateDoc(doc(db, 'campanas', campanaId), {
      'totales.respuestas': increment(respuestas),
      'totales.rebotes': increment(rebotes),
      'totales.bajas': increment(bajas),
      actualizado: serverTimestamp(),
    });
  }
  return { respuestas, rebotes, bajas, revisados: dest.length };
}

/* Mueve el prospecto y deja la huella en la bitácora. Los dos van
   juntos a propósito: un estado que cambia sin decir por qué obliga a
   reconstruir la historia de memoria. */
async function avanzarProspecto(db, rbd, uid, campos, texto) {
  try {
    await setDoc(doc(db, 'prospectos', String(rbd)),
      { ...campos, actualizado: serverTimestamp() }, { merge: true });
    if (uid) {
      await setDoc(doc(collection(db, 'actividad')), {
        rbd: String(rbd), tipo: 'respuesta', texto, uid, creado: serverTimestamp(),
      });
    }
  } catch { /* la gestión no debe hacer fallar la revisión del buzón */ }
}

// ---------- lista de exclusión ----------
/* Quien pidió la baja o rebotó no vuelve a recibir correo, ni en esta
   campaña ni en las de octubre. La marca vive fuera de la campaña —en su
   propia colección, por RBD— porque una marca dentro de la campaña se
   pierde en cuanto se arma un segmento nuevo; además, honrar la baja es
   una obligación legal, no una cortesía. */
export async function registrarBaja(db, rbd, datos = {}) {
  await setDoc(doc(db, 'bajas', String(rbd)), {
    rbd: Number(rbd) || rbd,
    email: datos.email || '',
    motivo: datos.motivo || 'baja',
    campanaId: datos.campanaId || '',
    fecha: serverTimestamp(),
  }, { merge: true });
}

/** Los RBD que nunca deben recibir correo. Se carga una vez por sesión. */
export async function cargarBajas(db) {
  const s = await getDocs(query(collection(db, 'bajas'), limit(5000)));
  return new Set(s.docs.map((d) => d.id));
}

// ---------- envío programado ----------
/* El token de Gmail que usa la app dura una hora y muere al cerrar la
   pestaña: perfecto para enviar con alguien delante, inútil para que un
   correo salga el lunes a las 8. Para eso hace falta un permiso que
   sobreviva —un refresh token— y ese sólo se consigue con el flujo de
   código, que exige el secreto del cliente y por lo tanto un servidor.
   El navegador nunca ve ese secreto: sólo pasea el código de un lado a
   otro y deja que la función haga el canje. */

/** Abre el consentimiento de Google y deja el permiso guardado en el
 *  servidor. Devuelve la cuenta que quedó autorizada para enviar. */
export async function autorizarProgramado(auth, clientId, { leer = true } = {}) {
  if (!clientId) throw new Error('El envío programado no está configurado en el servidor.');
  const marca = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const redirectUri = `${location.origin}/oauth.html`;
  const alcance = [GMAIL_ENVIAR, ...(leer ? [GMAIL_LEER] : [])].join(' ');

  /* access_type=offline es lo que pide el permiso duradero, y
     prompt=consent lo que obliga a Google a entregarlo de nuevo: sin
     él, una segunda autorización devuelve un código que no sirve para
     renovar nada y el fallo aparecería recién el lunes. */
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: alcance,
    access_type: 'offline',
    prompt: 'consent',
    state: marca,
  })}`;

  const ventana = window.open(url, 'jm_oauth', 'width=520,height=660,menubar=no');
  if (!ventana) throw new Error('El navegador bloqueó la ventana de Google. Permite las ventanas emergentes de este sitio.');

  const code = await new Promise((resolve, rechazar) => {
    let listo = false;
    const cerrar = () => {
      listo = true;
      window.removeEventListener('message', alMensaje);
      clearInterval(vigia);
      clearTimeout(plazo);
    };
    const alMensaje = (ev) => {
      // Sólo se acepta lo que viene del propio origen y con la marca de
      // esta petición: un mensaje de cualquier otra pestaña se ignora.
      if (ev.origin !== location.origin) return;
      if (ev.data?.fuente !== 'jm-oauth' || ev.data.state !== marca) return;
      cerrar();
      if (ev.data.error) rechazar(new Error(`Google no concedió el permiso (${ev.data.error}).`));
      else if (!ev.data.code) rechazar(new Error('Google no devolvió el código de autorización.'));
      else resolve(ev.data.code);
    };
    window.addEventListener('message', alMensaje);
    const vigia = setInterval(() => {
      if (listo || !ventana.closed) return;
      cerrar();
      rechazar(new Error('Se cerró la ventana antes de conceder el permiso.'));
    }, 500);
    const plazo = setTimeout(() => {
      cerrar();
      try { ventana.close(); } catch { /* ya cerrada */ }
      rechazar(new Error('Se acabó el tiempo para autorizar.'));
    }, 3 * 60 * 1000);
  });

  const idToken = await auth.currentUser.getIdToken();
  const r = await fetch('/t/autorizar', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirectUri }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `No se pudo guardar la autorización (HTTP ${r.status}).`);
  return j;
}

/** Retira el permiso duradero y libera las campañas que esperaban. */
export async function desautorizarProgramado(auth) {
  const idToken = await auth.currentUser.getIdToken();
  const r = await fetch('/t/desautorizar', {
    method: 'POST', headers: { Authorization: `Bearer ${idToken}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'No se pudo retirar la autorización.');
  return j;
}

/**
 * Deja una campaña lista para salir sola a la hora indicada.
 *
 * Redacta acá los mensajes completos y los guarda ya armados. Podría
 * armarlos el servidor, pero entonces la plantilla, la firma y el
 * seguimiento vivirían dos veces y bastaría con que una copia quedara
 * atrás para que el correo del lunes no fuera el que se aprobó el
 * sábado. Lo que se programa es exactamente lo que se vio en la vista
 * previa.
 */
export async function programarCampana(db, campana, tanda, ctx, uid, cuando, alAvanzar) {
  const base = location.origin;
  const remitente = ctx.remitenteProgramado || gmailCorreo();
  if (!remitente) throw new Error('No hay una cuenta autorizada para enviar.');
  const esSeguimiento = Boolean(campana.seguimientoDe);
  const usaB = Boolean(campana.asuntoB || campana.cuerpoB);

  /* Nace como borrador y recién al final pasa a programada: si algo
     falla a mitad de la redacción, lo que queda es un borrador
     incompleto y no una campaña que va a salir a medias. */
  const id = await guardarCampana(db, { ...campana, estado: 'borrador' }, tanda, uid);

  let lote = writeBatch(db);
  let enLote = 0;
  let listos = 0;

  for (const [i, d] of tanda.entries()) {
    if (!d.email) continue;
    const variante = usaB && i % 2 === 1 ? 'B' : 'A';
    const prospecto = ctx.prospectos?.get(String(d.rbd)) || d;
    const asunto = aplicarVariables(
      variante === 'B' && campana.asuntoB ? campana.asuntoB : campana.asunto, prospecto, ctx);
    const texto = aplicarVariables(
      variante === 'B' && campana.cuerpoB ? campana.cuerpoB : campana.cuerpo, prospecto, ctx);
    const html = correoHtml({
      texto, prospecto, ctx, breve: esSeguimiento,
      base, campanaId: id, rbd: d.rbd, track: campana.track,
    });
    const crudo = mensajeCrudo({
      para: d.email, asunto, html, texto,
      de: remitente, deNombre: MARCA.remitenteNombre,
      bajaUrl: ctx.funcion ? urlBaja(base, id, d.rbd) : '',
    });

    lote.set(doc(db, 'campanas', id, 'destinatarios', String(d.rbd)),
      { crudo, variante, estado: 'pendiente', error: '' }, { merge: true });
    listos += 1;
    enLote += 1;
    // Lotes cortos a propósito: cada mensaje redactado pesa unos 20 KB y
    // un lote de 450 excedería el tamaño máximo de una escritura.
    if (enLote === 25) { await lote.commit(); lote = writeBatch(db); enLote = 0; }
    alAvanzar?.({ i: i + 1, total: tanda.length });
  }
  if (enLote) await lote.commit();
  if (!listos) throw new Error('Ningún destinatario de la tanda tiene correo.');

  await updateDoc(doc(db, 'campanas', id), {
    estado: 'programada',
    programadaPara: cuando,
    programadaPor: uid,
    remitenteProgramado: remitente,
    errorProgramado: '',
    'totales.destinatarios': listos,
    actualizado: serverTimestamp(),
  });
  return { id, listos };
}

/** Devuelve una campaña programada al estado de borrador. */
export async function cancelarProgramacion(db, id) {
  /* El campo se borra en vez de quedar en nulo: en Firestore un nulo
     sigue siendo menor que cualquier fecha, así que una campaña
     cancelada seguiría entrando en la consulta de "ya vencidas". */
  await updateDoc(doc(db, 'campanas', id), {
    estado: 'borrador',
    programadaPara: deleteField(),
    errorProgramado: '',
    actualizado: serverTimestamp(),
  });
}
