// ============================================================
// JUMP Math Chile — CRM de prospección
//
// Lee Firestore con el SDK web. Las reglas exigen usuario autenticado,
// así que todo pasa por el login de Google.
// ============================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';
import {
  getFirestore, collection, doc, getDocs, getDoc, query, where,
  orderBy, limit, startAfter, serverTimestamp, setDoc, getCountFromServer,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

import * as mail from './mailing.js';
import { ayudaHtml as ay, iniciarAyuda } from './ayuda.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCTmWjLoe2p78K6wng9SF9DKUoAKEoMf1M',
  /* El dominio de la propia app, no el firebaseapp.com por defecto.
     Chrome bloquea las cookies de terceros, y con authDomain en otro
     origen el popup de Google termina, se cierra y la promesa no se
     resuelve nunca: la pantalla queda pegada sin error. Hosting sirve
     el asistente de autenticación en /__/auth/ del mismo dominio. */
  authDomain: 'jmventas-aab3c.web.app',
  projectId: 'jmventas-aab3c',
  storageBucket: 'jmventas-aab3c.firebasestorage.app',
  messagingSenderId: '868229245128',
  appId: '1:868229245128:web:5e5dc094e7c782b7c05dfd',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const PAGINA = 300;
// Promedio de los 7.314 establecimientos con Simce Matemática 4º básico,
// medido sobre esta misma base. Es el número contra el que se calcula la
// brecha que se le menciona a cada colegio, así que es verificable.
const PROMEDIO_MATE = 253;

const $ = (id) => document.getElementById(id);
const numero = (n) => (Number(n) || 0).toLocaleString('es-CL');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normalizar = (s) => String(s ?? '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fecha = (t) => (t?.toDate ? t.toDate().toLocaleDateString('es-CL') : '—');

/* "respondio" se gana solo, al detectar la respuesta en el buzón: es el
   escalón que separa un envío de una conversación, y el que decide qué
   aparece mañana en la bandeja de trabajo. */
const ESTADOS = ['nuevo', 'contactado', 'respondio', 'reunion', 'propuesta',
  'ganado', 'descartado'];
const ETIQUETA_ESTADO = {
  nuevo: 'Nuevo', contactado: 'Contactado', respondio: 'Respondió',
  reunion: 'Reunión agendada', propuesta: 'Propuesta enviada',
  ganado: 'Ganado', descartado: 'Descartado',
  sin_web: 'Sin web', web_sin_mail: 'Web sin correo', contacto_ok: 'Contacto OK',
};

const LISTADOS = ['oportunidades', 'prospectos', 'cuentas', 'redes'];
const PAGINADAS = ['oportunidades', 'prospectos'];

const TITULOS = {
  hoy: ['Hoy', 'Lo que hay que atender ahora: quién respondió, qué se prometió y a quién llamar.'],
  panel: ['Panel', 'Cifras de toda la base, contadas en el servidor — no de la página cargada.'],
  oportunidades: ['Oportunidades', 'Colegios con problema de matemática documentado y posibilidad real de cierre.'],
  prospectos: ['Prospectos', 'Los 7.808 establecimientos con educación básica regular.'],
  cuentas: ['Cuentas', 'Cuentas de cabecera con contacto verificado.'],
  redes: ['Redes', 'Sostenedores con tres o más colegios: una reunión, N establecimientos.'],
  campanas: ['Campañas', 'Correos enviados desde tu cuenta de Gmail, con seguimiento por destinatario.'],
};

const estado = {
  vista: 'oportunidades',
  cuentas: [], redes: [], prospectos: [], oportunidades: [],
  ultimoDoc: null, hayMas: false, meta: null, cargando: false, peticion: 0,
  campanas: [], campanaActual: null, destinatarios: [], cancelar: false,
  // RBD que pidieron la baja o rebotaron: se excluyen de todo segmento.
  bajas: new Set(),
  // La función de seguimiento atiende el pixel, los clics y la baja de
  // un clic; si no está desplegada, el correo sale sin esas piezas.
  funcion: false,
  // Qué sabe el servidor sobre el envío programado: si está configurado,
  // con qué cuenta quedó autorizado y con qué id de cliente pedirlo.
  programado: { disponible: false, clientId: '', autorizacion: null },
  filtroDetalle: 'todos',
  // Filtros de varios valores: id -> conjunto de valores elegidos.
  multi: {},
  // id -> fila. Se guarda el dato completo, no sólo el id, para que la
  // selección sobreviva al cambio de filtros y a la paginación: si sólo
  // se guardara el id, al filtrar se perdería lo elegido antes.
  seleccion: new Map(),
};

const CAMPOS_FILTRO = ['buscar', 'f-tier', 'f-canal', 'f-region', 'f-ate',
  'f-estado', 'f-correo', 'f-orden', 'f-umbral'];

/* Filtros que aceptan varios valores a la vez. Un vendedor no trabaja "el
   tier 1": trabaja "tier 1 y 2 de la Metropolitana y Valparaíso". Obligar
   a elegir uno solo lo empujaba a exportar y cruzar en Excel.
   Los que quedan fuera son excluyentes por naturaleza: un colegio tiene o
   no tiene correo, y el orden es uno solo. */
const MULTI = ['f-tier', 'f-canal', 'f-region', 'f-estado'];
const ETIQUETA_FILTRO = {
  buscar: 'Búsqueda', 'f-tier': 'Tier', 'f-canal': 'Canal', 'f-region': 'Región',
  'f-ate': 'ATE', 'f-estado': 'Estado', 'f-correo': 'Correo', 'f-umbral': 'Dolor',
};

// ---------- presentación ----------
function distintivoTier(t) {
  if (!t) return '';
  return `<span class="tier t${t}">${t} · ${{ 1: 'Fácil', 2: 'Medio', 3: 'Difícil' }[t] || t}</span>`;
}

// El estado ATE lleva icono y texto; el color nunca va solo.
const distintivoAte = (r) => (r
  ? '<span class="ate si">● Requiere ATE</span>'
  : '<span class="ate no">✓ Sin ATE</span>');

function celdaMate(p) {
  if (!p.categoriaDesempeno && p.dolorMate == null) return '<span class="sin-contacto">—</span>';
  const d = Number(p.dolorMate);
  const nivel = !Number.isFinite(d) ? ''
    : d >= 85 ? 'critico' : d >= 60 ? 'serio' : d >= 35 ? 'medio' : 'bajo';
  const simce = p.simceMate
    ? `<div class="sub">SIMCE ${Math.round(p.simceMate)}${p.simceAnio ? ` · ${p.simceAnio}` : ''}</div>` : '';
  return `<div class="mate ${nivel}"><i></i>${esc(p.categoriaDesempeno || `dolor ${d}`)}</div>${simce}`;
}

/* Oportunidad = mitad dolor documentado, mitad facilidad de cierre. Un
   colegio en crisis al que no se le puede vender hasta 2028 no es una
   oportunidad, y uno fácil de cerrar que ya rinde bien tampoco; el valor
   está en la intersección. `puntaje` ya condensa matrícula, red, fricción
   de compra y copago. */
function oportunidadDe(p) {
  const dolor = Number(p.dolorMate);
  const facilidad = Number(p.puntaje);
  if (!Number.isFinite(dolor) || !Number.isFinite(facilidad)) return null;
  return Math.round(0.5 * dolor + 0.5 * facilidad);
}

/* Sólo lo que no se lee en otra columna: el tier y el requisito ATE ya
   tienen su distintivo al lado. */
function porQue(p) {
  const r = [];
  const brecha = Number.isFinite(Number(p.simceMate))
    ? Math.round(PROMEDIO_MATE - Number(p.simceMate)) : null;
  if (brecha > 0) r.push(`${brecha} pts bajo el promedio`);
  if (p.eeEnRed > 2) r.push(`red de ${numero(p.eeEnRed)} colegios`);
  if (/MAS DE|100\.000/.test(p.copago || '')) r.push('copago alto');
  return r.join(' · ');
}

function celdaContacto(correos, telefonos) {
  const c = (correos || []).filter(Boolean);
  const t = (telefonos || []).filter(Boolean);
  if (!c.length && !t.length) return '<span class="sin-contacto">—</span>';
  return [
    ...c.map((x) => `<a href="mailto:${esc(x)}">${esc(x)}</a>`),
    ...t.map((x) => `<a href="tel:${esc(x.replace(/\s/g, ''))}">${esc(x)}</a>`),
  ].join('');
}

function selectorEstado(col, id, actual) {
  const extra = ESTADOS.includes(actual) ? ''
    : `<option value="${esc(actual)}" selected>${esc(ETIQUETA_ESTADO[actual] || actual)}</option>`;
  const ops = ESTADOS.map((e) => `<option value="${e}"${e === actual ? ' selected' : ''}>`
    + `${ETIQUETA_ESTADO[e]}</option>`).join('');
  return `<select class="estado" data-col="${col}" data-id="${esc(id)}">${extra}${ops}</select>`;
}

function mostrarError(e) {
  const caja = $('error');
  const enlace = (e.message || '').match(/https:\/\/console\.firebase\.google\.com\S+/);
  caja.innerHTML = enlace
    ? `Falta un índice para esta combinación de filtros. Créalo y reintenta:<br>
       <a href="${esc(enlace[0])}" target="_blank" rel="noopener">${esc(enlace[0])}</a>`
    : esc(e.message || String(e));
  caja.classList.remove('oculto');
}
const limpiarError = () => $('error').classList.add('oculto');

/* Un "guardado" no es un error, y sacarlo por la caja roja enseña a
   ignorarla. Los avisos de que algo salió bien pasan y se van solos. */
let avisoTemporizador;
function avisar(texto) {
  let caja = $('aviso-flotante');
  if (!caja) {
    caja = document.createElement('div');
    caja.id = 'aviso-flotante';
    caja.className = 'aviso-flotante';
    caja.setAttribute('role', 'status');
    document.body.appendChild(caja);
  }
  caja.textContent = texto;
  caja.classList.add('visible');
  clearTimeout(avisoTemporizador);
  avisoTemporizador = setTimeout(() => caja.classList.remove('visible'), 3200);
}

// ---------- carga de listados ----------
async function cargarFijos() {
  const [cuentas, redes, meta, bajas] = await Promise.all([
    getDocs(query(collection(db, 'cuentas'), orderBy('prioridad'))),
    getDocs(query(collection(db, 'redes'), orderBy('matBasica', 'desc'), limit(400))),
    getDoc(doc(db, 'meta', 'carga')).catch(() => null),
    mail.cargarBajas(db).catch(() => new Set()),
  ]);
  estado.cuentas = cuentas.docs.map((d) => ({ id: d.id, ...d.data() }));
  estado.redes = redes.docs.map((d) => ({ id: d.id, ...d.data() }));
  estado.meta = meta?.exists() ? meta.data() : null;
  estado.bajas = bajas;
}

/* Firestore no combina filtros arbitrarios sin un índice por combinación.
   En vez de declarar esa explosión, se manda al servidor el filtro más
   selectivo y el resto se afina en el cliente sobre la página traída. El
   contador siempre dice cuántos registros se revisaron. */
/* Firestore admite un solo operador de conjunto por consulta y hasta 30
   valores. Con varios valores en un filtro se usa `in`, que aprovecha el
   mismo índice que la igualdad; si hay más de un filtro con valores, sólo
   el primero viaja al servidor y el resto se afina en el cliente. */
const CAMPO_SERVIDOR = {
  'f-tier': ['tierNum', (v) => Number(v)],
  'f-canal': ['canal', (v) => v],
  'f-region': ['region', (v) => v],
  'f-estado': ['estadoCrm', (v) => v],
};

function condicionMulti(ids) {
  for (const id of ids) {
    const vals = seleccionados(id);
    if (!vals.length || vals.length > 30) continue;
    const [campo, convertir] = CAMPO_SERVIDOR[id];
    return vals.length === 1
      ? where(campo, '==', convertir(vals[0]))
      : where(campo, 'in', vals.map(convertir));
  }
  return null;
}

function consultaProspectos(desde) {
  const partes = [collection(db, 'prospectos')];

  if (estado.vista === 'oportunidades') {
    // Una desigualdad obliga a ordenar primero por ese mismo campo, así
    // que el ranking por oportunidad se arma en el cliente.
    partes.push(where('dolorMate', '>=', Number($('f-umbral').value) || 60));
    const cond = condicionMulti(['f-tier', 'f-canal', 'f-region']);
    if (cond) partes.push(cond);
    partes.push(orderBy('dolorMate', 'desc'));
  } else {
    const texto = normalizar($('buscar').value).trim();
    const palabra = texto.split(/\s+/).filter((p) => p.length >= 3)[0];
    const cond = condicionMulti(['f-tier', 'f-canal', 'f-region', 'f-estado']);
    if (palabra) partes.push(where('tokens', 'array-contains', palabra));
    else if (cond) partes.push(cond);
    else if ($('f-ate').value) partes.push(where('requiereAte', '==', $('f-ate').value === 'si'));
    partes.push(orderBy($('f-orden').value || 'matBasica', 'desc'));
  }

  if (desde) partes.push(startAfter(desde));
  partes.push(limit(PAGINA));
  return query(...partes);
}

async function cargarProspectos({ continuar = false } = {}) {
  const mio = ++estado.peticion;
  const vista = estado.vista;
  estado.cargando = true;
  // Se conserva la tabla anterior atenuada en vez de vaciarla: un
  // esqueleto parpadeando obliga a releer la pantalla en cada tecla.
  document.querySelector('#vista-listado .envoltura').classList.add('recargando');
  $('cargando').classList.toggle('oculto', estado[vista].length > 0);
  try {
    const snap = await getDocs(consultaProspectos(continuar ? estado.ultimoDoc : null));
    if (mio !== estado.peticion) return;
    const filas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (vista === 'oportunidades') for (const f of filas) f._oport = oportunidadDe(f);
    estado[vista] = continuar ? estado[vista].concat(filas) : filas;
    estado.ultimoDoc = snap.docs[snap.docs.length - 1] || null;
    estado.hayMas = snap.docs.length === PAGINA;
    limpiarError();
  } catch (e) {
    if (mio === estado.peticion) mostrarError(e);
  } finally {
    if (mio === estado.peticion) {
      estado.cargando = false;
      $('cargando').classList.add('oculto');
      document.querySelector('#vista-listado .envoltura').classList.remove('recargando');
      pintar();
    }
  }
}

function filtrar(filas) {
  const texto = normalizar($('buscar').value).trim();
  const [ate, correo] = ['f-ate', 'f-correo'].map((i) => $(i).value);
  // Un conjunto vacío no filtra: significa "todos", no "ninguno".
  const tier = estado.multi['f-tier'];
  const canal = estado.multi['f-canal'];
  const region = estado.multi['f-region'];
  const est = estado.multi['f-estado'];
  return filas.filter((f) => {
    if (tier.size && !tier.has(String(f.tierNum ?? ''))) return false;
    if (canal.size && !canal.has(f.canal)) return false;
    if (region.size && !region.has(f.region)) return false;
    if (ate && f.requiereAte !== (ate === 'si')) return false;
    if (est.size && !est.has(f.estadoCrm || 'nuevo')) return false;
    if (correo) {
      const tiene = Boolean(String(f.email || '').trim() || (f.emails || []).length);
      if (tiene !== (correo === 'si')) return false;
    }
    if (texto) {
      const heno = normalizar([f.establecimiento, f.cuenta, f.comuna, f.region,
        f.establecimientoMayor, f.rutSostenedor, f.nombreContacto,
        (f.emails || []).join(' '), f.email].filter(Boolean).join(' '));
      if (!texto.split(/\s+/).every((p) => heno.includes(p))) return false;
    }
    return true;
  });
}

// ---------- tablas ----------
/* Cada columna lleva su clave de ayuda al lado: el título solo no dice
   de dónde sale el número. */
const COLUMNAS = {
  oportunidades: [['Oport.', 'col-oport'], ['Establecimiento', 'col-establecimiento'],
    ['Por qué', 'col-porque'], ['Matemática', 'col-matematica'], ['Tier', 'col-tier'],
    ['Matrícula', 'col-matricula'], ['Contacto', 'col-contacto'], ['Estado', 'col-estado']],
  prospectos: [['Tier', 'col-tier'], ['Establecimiento', 'col-establecimiento'],
    ['Canal', 'col-canal'], ['ATE', 'col-ate'], ['Matemática', 'col-matematica'],
    ['Matrícula', 'col-matricula'], ['Red', 'col-red'], ['Contacto', 'col-contacto'],
    ['Estado', 'col-estado']],
  cuentas: [['Prio.', 'col-prioridad'], ['Cuenta', 'col-cuenta'], ['Canal', 'col-canal'],
    ['ATE', 'col-ate'], ['Colegios', 'col-colegios'], ['Matrícula', 'col-matricula'],
    ['Contacto', 'col-contacto'], ['Confianza', 'col-confianza'], ['Estado', 'col-estado']],
  redes: [['Sostenedor', 'col-sostenedor'], ['Comuna principal', 'col-comuna-ppal'],
    ['ATE', 'col-ate'], ['Colegios', 'col-colegios'], ['Matrícula', 'col-matricula'],
    ['Regiones', 'col-regiones'], ['Estado', 'col-estado']],
};
const NUMERICAS = {
  oportunidades: [0, 5], prospectos: [5, 6], cuentas: [4, 5], redes: [3, 4, 5],
};

const partes = (s) => String(s || '').split(';').map((x) => x.trim()).filter(Boolean);

/* Un colegio traspasado ya no lo compra su municipio: lo compra el
   servicio local, y con quién se negocia es media venta. */
const administra = (p) => (p.slep ? `SLEP ${p.slep}` : p.dependencia || p.canal || '');

const FILA = {
  oportunidades: (p) => `
    <td class="num"><span class="oport">${p._oport ?? '—'}</span></td>
    <td><div class="nombre">${esc(p.establecimiento)}</div>
      <div class="sub">RBD ${esc(p.rbd)} · ${esc(p.comuna)}, ${esc(p.region)} · ${esc(administra(p))}</div></td>
    <td class="porque">${esc(porQue(p)) || '—'}</td>
    <td>${celdaMate(p)}</td>
    <td>${distintivoTier(p.tierNum)}<div class="sub">${distintivoAte(p.requiereAte)}</div></td>
    <td class="num">${numero(p.matBasica)}</td>
    <td class="contacto">${celdaContacto(partes(p.email), partes(p.telefono))}</td>
    <td>${selectorEstado('prospectos', p.id, p.estadoCrm)}</td>`,

  prospectos: (p) => `
    <td>${distintivoTier(p.tierNum)}</td>
    <td><div class="nombre">${esc(p.establecimiento)}</div>
      <div class="sub">RBD ${esc(p.rbd)} · ${esc(p.comuna)}, ${esc(p.region)} · ${esc(administra(p))}</div></td>
    <td>${esc(p.canal)}</td>
    <td>${distintivoAte(p.requiereAte)}</td>
    <td>${celdaMate(p)}</td>
    <td class="num">${numero(p.matBasica)}</td>
    <td class="num">${p.eeEnRed > 1 ? `${numero(p.eeEnRed)} EE` : '—'}</td>
    <td class="contacto">${celdaContacto(partes(p.email), partes(p.telefono))}</td>
    <td>${selectorEstado('prospectos', p.id, p.estadoCrm)}</td>`,

  cuentas: (c) => `
    <td><span class="prio${c.prioridad === 1 ? ' p1' : ''}">${c.prioridad ?? '—'}</span></td>
    <td><div class="nombre">${esc(c.cuenta)}</div>
      <div class="sub">${esc(c.tipo)}${c.nombreContacto ? ` · ${esc(c.nombreContacto)}` : ''}</div>
      ${c.proximoPaso ? `<div class="sub">→ ${esc(c.proximoPaso)}</div>` : ''}</td>
    <td>${esc(c.canal)}</td>
    <td>${distintivoAte(c.requiereAte)}</td>
    <td class="num">${c.eeBasica ? numero(c.eeBasica) : '—'}</td>
    <td class="num">${c.matBasica ? numero(c.matBasica) : '—'}</td>
    <td class="contacto">${celdaContacto(c.emails, c.telefonos)}</td>
    <td>${esc(c.confianza || '—')}</td>
    <td>${selectorEstado('cuentas', c.id, c.estadoCrm)}</td>`,

  redes: (r) => `
    <td><div class="nombre">${esc(r.rutSostenedor)}</div>
      <div class="sub">${esc(r.establecimientoMayor || '')}</div></td>
    <td>${esc(r.comunaPrincipal || '—')}</td>
    <td>${distintivoAte(r.requiereAte)}</td>
    <td class="num">${numero(r.eeBasica)}</td>
    <td class="num">${numero(r.matBasica)}</td>
    <td class="num">${numero(r.nRegiones)}</td>
    <td>${selectorEstado('redes', r.id, r.estadoCrm)}</td>`,
};

function pintarKpis() {
  const m = estado.meta;
  const conContacto = estado.cuentas.filter((c) => c.tieneContacto).length;
  const sinAte = estado.cuentas.filter((c) => !c.requiereAte)
    .reduce((a, c) => a + (c.matBasica || 0), 0);
  const tiles = [
    { e: 'Establecimientos', v: numero(m?.prospectos ?? 0), n: 'con básica regular' },
    { e: 'Matrícula básica', v: numero(m?.matBasicaTotal ?? 0), n: 'alumnos alcanzables' },
    { e: 'Redes', v: numero(estado.redes.length), n: '1 reunión = N colegios' },
    { e: 'Cuentas con contacto', v: String(conContacto), n: `de ${estado.cuentas.length} de cabecera` },
    { e: 'Alcanzable sin ATE', v: numero(sinAte), n: 'alumnos, contrato directo' },
  ];
  $('kpis').innerHTML = tiles.map((t) => `<div class="kpi">
    <div class="etiqueta">${esc(t.e)}</div><div class="valor">${esc(t.v)}</div>
    <div class="nota">${esc(t.n)}</div></div>`).join('');
}

function pintar() {
  const v = estado.vista;
  if (!LISTADOS.includes(v)) return;

  const orden = v === 'oportunidades' ? '_oport' : ($('f-orden').value || 'matBasica');
  const filas = filtrar(estado[v])
    .sort((a, b) => (Number(b[orden]) || 0) - (Number(a[orden]) || 0));

  const seleccionable = PAGINADAS.includes(v);
  const todasMarcadas = seleccionable && filas.length
    && filas.every((f) => estado.seleccion.has(claveFila(f)));

  $('cabecera-tabla').innerHTML =
    (seleccionable ? `<th class="sel"><input type="checkbox" id="sel-todos"`
      + `${todasMarcadas ? ' checked' : ''} aria-label="Seleccionar todo lo visible">`
      + `${ay('sel-todos')}</th>` : '')
    + COLUMNAS[v].map(([c, clave], i) => `<th${NUMERICAS[v].includes(i) ? ' class="num"' : ''}>`
      + `${esc(c)}${ay(clave)}</th>`).join('')
    + (seleccionable ? `<th>${ay('accion-fila')}</th>` : '');

  $('cuerpo').innerHTML = filas.map((f) => {
    const celdas = FILA[v](f);
    if (!seleccionable) return `<tr>${celdas}</tr>`;
    const marcada = estado.seleccion.has(claveFila(f));
    const conCorreo = String(f.email || '').trim();
    return `<tr class="${marcada ? 'marcada' : ''}" data-id="${esc(f.id)}">`
      + `<td class="sel"><input type="checkbox" data-marcar="${esc(f.id)}"`
      + `${marcada ? ' checked' : ''} aria-label="Seleccionar"></td>`
      + celdas
      + `<td>${conCorreo ? `<button class="accion-fila" data-solo="${esc(f.id)}"`
        + ` title="Escribirle sólo a este colegio">✉</button>` : ''}</td></tr>`;
  }).join('');

  $('vacio').classList.toggle('oculto', filas.length > 0 || estado.cargando);
  $('caja-mas').classList.toggle('oculto', !(PAGINADAS.includes(v) && estado.hayMas));
  // Se esconde la caja completa —control y su "?"— y no sólo el select.
  $('caja-umbral').classList.toggle('oculto', v !== 'oportunidades');
  $('caja-orden').classList.toggle('oculto', v === 'oportunidades');

  $(`n-${v}`).textContent = numero(filas.length);
  pintarChips();
  pintarSeleccion();

  if (v === 'oportunidades') {
    const alumnos = filas.reduce((a, f) => a + (Number(f.matBasica) || 0), 0);
    const sinAte = filas.filter((f) => !f.requiereAte).length;
    $('resultado').textContent = `${numero(filas.length)} colegios · ${numero(alumnos)} alumnos · `
      + `${sinAte} sin requisito ATE${estado.hayMas ? ' · hay más' : ''}`;
  } else {
    $('resultado').textContent = PAGINADAS.includes(v)
      ? `${numero(filas.length)} de ${numero(estado[v].length)} revisados${estado.hayMas ? ' · hay más' : ''}`
      : `${numero(filas.length)} de ${numero(estado[v].length)}`;
  }
  actualizarAcciones();
}

/* Los filtros sobreviven a la recarga: quien está trabajando un segmento
   no debería tener que rearmarlo cada vez que vuelve. */
function guardarFiltros() {
  const v = {};
  for (const id of CAMPOS_FILTRO) {
    v[id] = MULTI.includes(id) ? seleccionados(id) : $(id).value;
  }
  try { localStorage.setItem('jm.filtros', JSON.stringify(v)); } catch { /* modo privado */ }
}

function restaurarFiltros() {
  try {
    const v = JSON.parse(localStorage.getItem('jm.filtros') || '{}');
    for (const id of CAMPOS_FILTRO) {
      if (v[id] == null) continue;
      if (MULTI.includes(id)) {
        // Puede venir guardado de la versión de un solo valor: se acepta igual.
        estado.multi[id] = new Set(Array.isArray(v[id]) ? v[id] : [v[id]].filter(Boolean));
        refrescarMulti(id);
      } else if ($(id).querySelector?.(`option[value="${CSS.escape(v[id])}"]`) !== null) {
        $(id).value = v[id];
      }
    }
  } catch { /* nada que restaurar */ }
}

function pintarChips() {
  const activos = [];
  for (const id of CAMPOS_FILTRO) {
    if (id === 'f-orden') continue;
    if (id === 'f-umbral' && estado.vista !== 'oportunidades') continue;
    const etiqueta = ETIQUETA_FILTRO[id];
    // No repetir la etiqueta si la opción ya la dice: "ATE: Sin requisito ATE"
    const rotular = (texto) => (normalizar(texto).includes(normalizar(etiqueta))
      ? texto : `${etiqueta}: ${texto}`);

    if (MULTI.includes(id)) {
      // Una ficha por valor: así se puede quitar uno sin perder el resto.
      for (const v of seleccionados(id)) {
        activos.push({ id, valor: v, texto: rotular(etiquetaOpcion(id, v)) });
      }
      continue;
    }
    const el = $(id);
    if (!el.value) continue;
    const texto = el.tagName === 'SELECT' ? el.options[el.selectedIndex].text : el.value;
    activos.push({ id, texto: rotular(texto) });
  }
  $('chips').innerHTML = activos.map((a) => `<span class="chip">${esc(a.texto)}`
    + `<button data-limpiar="${esc(a.id)}"${a.valor !== undefined
      ? ` data-valor="${esc(a.valor)}"` : ''} title="Quitar">×</button></span>`).join('');
  $('caja-limpiar').classList.toggle('oculto', activos.length === 0);

  /* Los KPI son cifras globales y fijas. Sirven al entrar, pero una vez
     que hay un segmento en juego sólo empujan la tabla hacia abajo: los
     números que importan ahí son los del segmento, que ya están en la
     línea de resultado y en la barra de selección. */
  $('kpis').classList.toggle('oculto', activos.length > 0 || estado.seleccion.size > 0);
}

// ---------- selección ----------
function claveFila(f) { return `${estado.vista}:${f.id}`; }

function pintarSeleccion() {
  const n = estado.seleccion.size;
  $('barra-seleccion').classList.toggle('oculto', n === 0);
  if (!n) return;
  const filas = [...estado.seleccion.values()];
  const alumnos = filas.reduce((a, f) => a + (Number(f.matBasica) || 0), 0);
  const conCorreo = filas.filter((f) => String(f.email || '').trim()).length;
  $('sel-conteo').textContent = `${numero(n)} seleccionado${n === 1 ? '' : 's'}`;
  $('sel-detalle').textContent = `${numero(alumnos)} alumnos · ${numero(conCorreo)} con correo`;
  $('sel-campana').disabled = conCorreo === 0;
}

function poblarFiltros() {
  const universo = [...estado.prospectos, ...estado.oportunidades];
  for (const [sel, campo] of [['f-canal', 'canal'], ['f-region', 'region']]) {
    const el = $(sel);
    if (el.options.length > 1) continue;
    for (const v of [...new Set(universo.map((p) => p[campo]).filter(Boolean))].sort()) {
      el.add(new Option(v, v));
    }
    refrescarMulti(sel);
  }
}

// ---------- filtros de varios valores ----------
/* El <select> original se queda en el documento como lista de opciones y
   como origen de las etiquetas: así `poblarFiltros` sigue igual y la
   accesibilidad no depende de reinventar un desplegable. Encima se dibuja
   un control propio con casillas, y lo elegido vive en un conjunto. */
const seleccionados = (id) => [...(estado.multi[id] || [])];
const etiquetaOpcion = (id, v) => ($(id).querySelector(`option[value="${CSS.escape(v)}"]`)
  ?.textContent || v);

function montarMulti() {
  for (const id of MULTI) {
    estado.multi[id] = new Set();
    const sel = $(id);
    sel.classList.add('oculto');
    sel.setAttribute('aria-hidden', 'true');
    sel.tabIndex = -1;

    const caja = document.createElement('div');
    caja.className = 'multi';
    caja.dataset.para = id;
    caja.innerHTML = `<button type="button" class="multi-boton" aria-expanded="false"
        aria-haspopup="true"></button>
      <div class="multi-panel oculto" role="group"></div>`;
    sel.after(caja);
    refrescarMulti(id);
  }
}

function refrescarMulti(id) {
  const caja = document.querySelector(`.multi[data-para="${id}"]`);
  if (!caja) return;
  const sel = $(id);
  const elegidos = estado.multi[id];
  const opciones = [...sel.options].filter((o) => o.value);

  caja.querySelector('.multi-panel').innerHTML = opciones.map((o) => `
    <label class="multi-op">
      <input type="checkbox" value="${esc(o.value)}"${elegidos.has(o.value) ? ' checked' : ''}>
      <span>${esc(o.textContent)}</span>
    </label>`).join('')
    + (elegidos.size ? '<button type="button" class="multi-nada">Quitar todos</button>' : '');

  const boton = caja.querySelector('.multi-boton');
  // El botón dice lo elegido, no "3 seleccionados": el valor concreto
  // ahorra abrir el panel para recordar qué se filtró.
  boton.textContent = elegidos.size === 0 ? sel.options[0].textContent
    : elegidos.size === 1 ? etiquetaOpcion(id, seleccionados(id)[0])
      : `${ETIQUETA_FILTRO[id]}: ${elegidos.size}`;
  boton.classList.toggle('activo', elegidos.size > 0);
}

function alternarMulti(id, valor, marcado) {
  const s = estado.multi[id];
  if (marcado) s.add(valor); else s.delete(valor);
  refrescarMulti(id);
  guardarFiltros();
  alFiltrar({ inmediato: true });
}

const cerrarPaneles = () => {
  for (const c of document.querySelectorAll('.multi')) {
    c.querySelector('.multi-panel').classList.add('oculto');
    c.querySelector('.multi-boton').setAttribute('aria-expanded', 'false');
  }
};

// ---------- panel ----------
/* Cada barra sale de un conteo agregado en el servidor, así que cubre
   los 7.808 aunque la tabla sólo tenga cargada una página. Un conteo
   cuesta una lectura por cada mil documentos que calzan: la visita
   completa al panel son ~15 consultas, centavos. */
async function contarProspectos(...conds) {
  const s = await getCountFromServer(query(collection(db, 'prospectos'), ...conds));
  return s.data().count;
}

function pintarBarras(el, items) {
  const max = Math.max(...items.map((i) => i.n), 1);
  $(el).innerHTML = items.map((i) => `<div class="fila-barra">
    <span class="fb-label" title="${esc(i.l)}">${esc(i.l)}</span>
    <div class="fb-pista"><i style="width:${(i.n / max * 100).toFixed(1)}%"></i></div>
    <span class="fb-num">${numero(i.n)}</span></div>`).join('');
}

async function cargarPanel() {
  for (const g of ['g-estado', 'g-dolor', 'g-tier']) $(g).textContent = 'Contando…';
  $('kpis-panel').innerHTML = '';
  try {
    const total = estado.meta?.prospectos || 7808;
    const ESTADOS_PANEL = ['nuevo', 'contacto_ok', 'contactado', 'respondio',
      'reunion', 'propuesta', 'ganado', 'descartado'];

    const [porEstado, dolores, tiers, sinAte] = await Promise.all([
      Promise.all(ESTADOS_PANEL.map((e) => contarProspectos(where('estadoCrm', '==', e)))),
      Promise.all([
        contarProspectos(where('dolorMate', '>=', 85)),
        contarProspectos(where('dolorMate', '>=', 60), where('dolorMate', '<', 85)),
        contarProspectos(where('dolorMate', '>=', 35), where('dolorMate', '<', 60)),
        contarProspectos(where('dolorMate', '>=', 0), where('dolorMate', '<', 35)),
      ]),
      Promise.all([1, 2, 3].map((n) => contarProspectos(where('tierNum', '==', n)))),
      contarProspectos(where('requiereAte', '==', false)),
    ]);

    const enGestion = porEstado[2] + porEstado[3] + porEstado[4];
    $('kpis-panel').innerHTML = [
      { e: 'Establecimientos', v: numero(total), n: 'con básica regular' },
      { e: 'Matrícula básica', v: numero(estado.meta?.matBasicaTotal), n: 'alumnos alcanzables' },
      { e: 'Sin requisito ATE', v: numero(sinAte), n: 'colegios de venta directa' },
      { e: 'En gestión', v: numero(enGestion), n: 'contactado → propuesta' },
      { e: 'Ganados', v: numero(porEstado[5]), n: 'contratos cerrados' },
    ].map((k) => `<div class="kpi"><div class="etiqueta">${esc(k.e)}</div>
      <div class="valor">${esc(k.v)}</div><div class="nota">${esc(k.n)}</div></div>`).join('');

    pintarBarras('g-estado', ESTADOS_PANEL.map((e, i) => ({
      l: ETIQUETA_ESTADO[e] || e, n: porEstado[i] })));
    pintarBarras('g-dolor', [
      { l: 'Crítico (85+)', n: dolores[0] },
      { l: 'Serio (60–84)', n: dolores[1] },
      { l: 'Medio (35–59)', n: dolores[2] },
      { l: 'Bajo (0–34)', n: dolores[3] },
      { l: 'Sin medición', n: Math.max(0, total - dolores.reduce((a, b) => a + b, 0)) },
    ]);
    pintarBarras('g-tier', [
      { l: '1 · Fácil', n: tiers[0] },
      { l: '2 · Medio', n: tiers[1] },
      { l: '3 · Difícil', n: tiers[2] },
    ]);
  } catch (e) { mostrarError(e); }
}

// ---------- exportación ----------
const EXPORTS = {
  prospectos: [
    ['RBD', (f) => f.rbd], ['ESTABLECIMIENTO', (f) => f.establecimiento],
    ['COMUNA', (f) => f.comuna], ['REGION', (f) => f.region],
    ['TIER', (f) => f.tierNum], ['CANAL', (f) => f.canal],
    ['DEPENDENCIA', (f) => f.dependencia],
    ['REQUIERE_ATE', (f) => (f.requiereAte ? 'SI' : 'NO')],
    ['SIMCE_MATE', (f) => f.simceMate], ['SIMCE_ANIO', (f) => f.simceAnio],
    ['DOLOR', (f) => f.dolorMate], ['MAT_BASICA', (f) => f.matBasica],
    ['EMAIL', (f) => f.email], ['TELEFONO', (f) => f.telefono],
    ['WEB', (f) => f.web], ['CONTACTO', (f) => f.contacto],
    ['ESTADO', (f) => f.estadoCrm || 'nuevo'],
  ],
  cuentas: [
    ['CUENTA', (f) => f.cuenta], ['PRIORIDAD', (f) => f.prioridad],
    ['TIPO', (f) => f.tipo], ['CANAL', (f) => f.canal],
    ['REQUIERE_ATE', (f) => (f.requiereAte ? 'SI' : 'NO')],
    ['COLEGIOS', (f) => f.eeBasica], ['MAT_BASICA', (f) => f.matBasica],
    ['CONTACTO', (f) => f.nombreContacto], ['CARGO', (f) => f.cargo],
    ['EMAILS', (f) => (f.emails || []).join('; ')],
    ['TELEFONOS', (f) => (f.telefonos || []).join('; ')],
    ['CONFIANZA', (f) => f.confianza], ['PROXIMO_PASO', (f) => f.proximoPaso],
    ['ESTADO', (f) => f.estadoCrm || 'nuevo'],
  ],
  redes: [
    ['RUT_SOSTENEDOR', (f) => f.rutSostenedor],
    ['ESTABLECIMIENTO_MAYOR', (f) => f.establecimientoMayor],
    ['COMUNA_PRINCIPAL', (f) => f.comunaPrincipal],
    ['REQUIERE_ATE', (f) => (f.requiereAte ? 'SI' : 'NO')],
    ['COLEGIOS', (f) => f.eeBasica], ['MAT_BASICA', (f) => f.matBasica],
    ['REGIONES', (f) => f.nRegiones], ['ESTADO', (f) => f.estadoCrm || 'nuevo'],
  ],
};
EXPORTS.oportunidades = [['OPORTUNIDAD', (f) => f._oport], ...EXPORTS.prospectos];

/* Separador punto y coma y BOM: el Excel en configuración chilena usa la
   coma como decimal, así que un CSV separado por comas abre en una sola
   columna. El BOM es lo que hace que las tildes sobrevivan. */
function exportarCsv() {
  const v = estado.vista;
  const usarSeleccion = estado.seleccion.size > 0 && PAGINADAS.includes(v);
  const filas = usarSeleccion ? [...estado.seleccion.values()] : filtrar(estado[v]);
  if (!filas.length) { mostrarError({ message: 'Nada que exportar con estos filtros.' }); return; }

  const cols = EXPORTS[v];
  const celda = (x) => {
    const s = String(x ?? '');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [cols.map(([h]) => h).join(';'),
    ...filas.map((f) => cols.map(([, fn]) => celda(fn(f))).join(';'))];

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + lineas.join('\r\n')],
    { type: 'text/csv;charset=utf-8' }));
  a.download = `jumpmath-${v}${usarSeleccion ? '-seleccion' : ''}-`
    + `${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- navegación ----------
function irA(vista) {
  estado.vista = vista;
  for (const b of document.querySelectorAll('button.nav')) {
    b.setAttribute('aria-current', String(b.dataset.vista === vista));
  }
  const [t, s] = TITULOS[vista] || [vista, ''];
  $('titulo').textContent = t;
  $('subtitulo').textContent = s;

  $('vista-listado').classList.toggle('oculto', !LISTADOS.includes(vista));
  $('vista-hoy').classList.toggle('oculto', vista !== 'hoy');
  $('vista-panel').classList.toggle('oculto', vista !== 'panel');
  $('vista-campanas').classList.toggle('oculto', vista !== 'campanas');
  $('vista-editor').classList.add('oculto');
  $('vista-detalle').classList.add('oculto');
  actualizarAcciones();
}

// ============================================================
// Hoy — la bandeja de trabajo
//
// El resto de la app responde "a quién le escribo". Esta responde la
// pregunta que viene después y que hasta ahora no contestaba nadie: qué
// hay que hacer ahora, con quién, y por qué. Sin esto, una respuesta
// puede quedarse una semana sin que nadie se entere.
// ============================================================
const hoyISO = () => mail.diaHoy();

/* Una fecha en crudo obliga a calcular mentalmente si ya pasó. La app
   sabe qué día es: que lo diga ella. */
const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function cuandoPaso(iso) {
  if (!iso) return 'sin fecha';
  const dias = Math.round((new Date(`${iso}T00:00`) - new Date(`${hoyISO()}T00:00`)) / 864e5);
  const [, m, d] = iso.split('-');
  const legible = `${Number(d)} ${MES_CORTO[Number(m) - 1] || ''}`;
  if (dias === 0) return 'vence hoy';
  if (dias === -1) return 'venció ayer';
  if (dias < -1) return `atrasado ${Math.abs(dias)} días · ${legible}`;
  return legible;
}

/** Hace cuánto pasó algo, en palabras. */
function desdeEntonces(t) {
  const ms = t?.toMillis?.();
  if (!ms) return '';
  const dias = Math.floor((Date.now() - ms) / 864e5);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  return `hace ${dias} días`;
}

/* El número del menú se cuenta en el servidor: sirve para que, al entrar,
   se vea que hay gente esperando sin tener que abrir la vista. */
async function contarHoy() {
  try {
    const [r, p] = await Promise.all([
      getCountFromServer(query(collection(db, 'prospectos'),
        where('estadoCrm', '==', 'respondio'))),
      getCountFromServer(query(collection(db, 'prospectos'),
        where('proximoPasoEn', '<=', hoyISO()))),
    ]);
    const n = r.data().count + p.data().count;
    $('n-hoy').textContent = n ? numero(n) : '';
    if (n) $('n-hoy').classList.add('urgente');
  } catch { /* sin permisos o sin índice: el contador es prescindible */ }
}

async function cargarHoy() {
  const caja = $('pilas-hoy');
  caja.innerHTML = '<div class="cargando">Revisando…</div>';
  try {
    const [respondieron, pendientes, calientes] = await Promise.all([
      getDocs(query(collection(db, 'prospectos'),
        where('estadoCrm', '==', 'respondio'), limit(60))),
      getDocs(query(collection(db, 'prospectos'),
        where('proximoPasoEn', '<=', hoyISO()), orderBy('proximoPasoEn'), limit(60))),
      getDocs(query(collection(db, 'prospectos'),
        where('aperturasCorreo', '>=', 2), orderBy('aperturasCorreo', 'desc'), limit(60))),
    ]);
    const filas = (s) => s.docs.map((d) => ({ id: d.id, ...d.data() }));
    /* Quien ya respondió o está más adelante en el embudo no es un
       "caliente": es un caso en curso, y mezclarlos haría que la lista
       de llamadas repita trabajo hecho. */
    const enCurso = ['respondio', 'reunion', 'propuesta', 'ganado', 'descartado'];
    const tibios = filas(calientes).filter((p) => !enCurso.includes(p.estadoCrm)).slice(0, 20);

    estado.hoy = {
      respondieron: filas(respondieron),
      pendientes: filas(pendientes),
      calientes: tibios,
      seguimientos: campanasQueTocanSeguimiento(),
    };
    pintarHoy();
  } catch (e) {
    caja.innerHTML = '';
    mostrarError(e);
  }
}

/* Un correo sin respuesta a los tres días no está rechazado: está
   sepultado. El recordatorio es la acción de mayor retorno de toda la
   operación, y la más fácil de olvidar. */
const DIAS_SEGUIMIENTO = 3;

function campanasQueTocanSeguimiento() {
  const limite = Date.now() - DIAS_SEGUIMIENTO * 864e5;
  const conSeguimiento = new Set(estado.campanas.map((c) => c.seguimientoDe).filter(Boolean));
  return estado.campanas.filter((c) => {
    if (c.estado !== 'enviada' || c.seguimientoDe || conSeguimiento.has(c.id)) return false;
    const cuando = c.actualizado?.toMillis?.() || c.creado?.toMillis?.() || 0;
    const t = c.totales || {};
    return cuando < limite && (t.enviados || 0) > (t.respuestas || 0);
  });
}

function pintarHoy() {
  const h = estado.hoy || {};
  const total = (h.respondieron?.length || 0) + (h.pendientes?.length || 0);
  $('n-hoy').textContent = total ? numero(total) : '';
  $('n-hoy').classList.toggle('urgente', total > 0);

  const ficha = (p, extra) => `<li>
      <button class="hoy-fila" data-ficha="${esc(p.id)}">
        <span class="nombre">${esc(p.establecimiento || p.id)}</span>
        <span class="sub">${esc(p.comuna || '')}${extra ? ` · ${extra}` : ''}</span>
      </button></li>`;

  const pilas = [
    {
      t: 'Respondieron y esperan', c: 'urgente', a: 'hoy-respondieron',
      d: 'Contestaron el correo y nadie los ha movido todavía. Responder en menos de dos horas hábiles es lo que separa una reunión de un correo perdido.',
      items: (h.respondieron || []).map((p) => ficha(p,
        `respondió ${desdeEntonces(p.respondioEn) || 'hace poco'}`)),
      vacio: 'Ninguna respuesta pendiente. Cuando alguien conteste, aparece acá.',
    },
    {
      t: 'Próximos pasos de hoy', c: 'aviso', a: 'hoy-pendientes',
      d: 'Lo que quedó comprometido en la ficha de cada colegio, y ya vence.',
      items: (h.pendientes || []).map((p) => ficha(p,
        `${esc(p.proximoPaso || 'sin descripción')} · ${esc(cuandoPaso(p.proximoPasoEn))}`)),
      vacio: 'Nada agendado para hoy. Los próximos pasos se fijan en la ficha del colegio.',
    },
    {
      t: 'Abrieron y no contestaron', c: '', a: 'hoy-calientes',
      d: 'Dos aperturas o más sin respuesta: interesa, pero no se atrevió a escribir. Es la lista de llamadas del día.',
      items: (h.calientes || []).map((p) => ficha(p, `${numero(p.aperturasCorreo)} aperturas`)),
      vacio: 'Todavía no hay aperturas repetidas. Requiere campañas con seguimiento activado.',
    },
    {
      t: 'Campañas que tocan seguimiento', c: '', a: 'hoy-seguimientos',
      d: `Enviadas hace más de ${DIAS_SEGUIMIENTO} días con gente que no ha contestado.`,
      items: (h.seguimientos || []).map((c) => `<li>
        <button class="hoy-fila" data-campana="${esc(c.id)}">
          <span class="nombre">${esc(c.nombre)}</span>
          <span class="sub">${numero((c.totales?.enviados || 0) - (c.totales?.respuestas || 0))} sin responder</span>
        </button></li>`),
      vacio: 'Ninguna campaña pide recordatorio.',
    },
  ];

  $('pilas-hoy').innerHTML = pilas.map((p) => `
    <section class="pila ${p.c}">
      <h3>${esc(p.t)}${ay(p.a)} <span class="cuenta">${p.items.length ? numero(p.items.length) : ''}</span></h3>
      <p class="sub">${esc(p.d)}</p>
      ${p.items.length ? `<ol class="hoy-lista">${p.items.join('')}</ol>`
    : `<p class="vacio-pila">${esc(p.vacio)}</p>`}
    </section>`).join('');
}

// ============================================================
// Ficha del establecimiento
//
// El dato de un colegio vivía repartido entre la tabla de prospectos y
// los destinatarios de cada campaña, sin ningún lugar donde juntarlo.
// Acá se ve todo lo que se sabe y todo lo que ha pasado, y es donde se
// escribe lo único que la máquina no puede saber: qué se acordó.
// ============================================================
const TIPO_ACTIVIDAD = {
  envio: ['✉', 'Correo'], respuesta: ['↩', 'Respuesta'], llamada: ['☎', 'Llamada'],
  reunion: ['👥', 'Reunión'], propuesta: ['📄', 'Propuesta'], nota: ['✎', 'Nota'],
  estado: ['→', 'Estado'],
};

async function abrirFicha(id) {
  const ficha = $('ficha');
  ficha.classList.remove('oculto');
  ficha.setAttribute('aria-hidden', 'false');
  $('velo').classList.remove('oculto');
  $('ficha-nombre').textContent = 'Cargando…';
  $('ficha-datos').innerHTML = '';
  $('ficha-historial').innerHTML = '';
  estado.fichaId = id;

  try {
    const d = await getDoc(doc(db, 'prospectos', String(id)));
    if (!d.exists()) { mostrarError({ message: 'No se encontró ese establecimiento.' }); return; }
    const p = { id: d.id, ...d.data() };
    estado.ficha = p;
    pintarFicha(p);
    await cargarHistorial(id);
    $('ficha-cerrar').focus();
  } catch (e) { mostrarError(e); }
}

function cerrarFicha() {
  $('ficha').classList.add('oculto');
  $('ficha').setAttribute('aria-hidden', 'true');
  $('velo').classList.add('oculto');
  estado.fichaId = null;
}

function pintarFicha(p) {
  $('ficha-nombre').textContent = mail.titulo(p.establecimiento || p.id);
  $('ficha-sub').textContent = [`RBD ${p.id}`, mail.titulo(p.comuna || ''),
    mail.titulo(p.region || ''), administra(p)].filter(Boolean).join(' · ');

  const brecha = Number.isFinite(Number(p.simceMate))
    ? Math.round(PROMEDIO_MATE - Number(p.simceMate)) : null;
  const dato = (e, v, n = '') => `<div class="dato">
    <div class="etiqueta">${esc(e)}</div><div class="valor">${v}</div>
    ${n ? `<div class="nota">${esc(n)}</div>` : ''}</div>`;

  $('ficha-datos').innerHTML = [
    dato('Oportunidad', oportunidadDe(p) ?? '—', 'dolor + facilidad'),
    dato('Matemática', p.simceMate ? Math.round(p.simceMate) : '—',
      brecha > 0 ? `${brecha} pts bajo el promedio` : 'SIMCE 4º básico'),
    dato('Tier', p.tierNum ? `${p.tierNum} · ${{ 1: 'Fácil', 2: 'Medio', 3: 'Difícil' }[p.tierNum]}` : '—',
      p.canal || ''),
    dato('Matrícula', numero(p.matBasica), p.requiereAte ? 'requiere ATE' : 'sin ATE'),
  ].join('');

  const correos = partes(p.email);
  const telefonos = partes(p.telefono);
  const wa = telefonos.map((t) => t.replace(/\D/g, '')).find((t) => t.length >= 9);
  $('ficha-contacto').innerHTML = [
    ...correos.map((c) => `<a class="pastilla" href="mailto:${esc(c)}">✉ ${esc(c)}</a>`),
    ...telefonos.map((t) => `<a class="pastilla" href="tel:${esc(t.replace(/\s/g, ''))}">☎ ${esc(t)}</a>`),
    wa ? `<a class="pastilla wa" target="_blank" rel="noopener"
      data-wa="${wa.length === 9 ? `56${wa}` : wa}"
      href="https://wa.me/${wa.length === 9 ? `56${wa}` : wa}">WhatsApp</a>` : '',
    p.web ? `<a class="pastilla" href="${esc(p.web)}" target="_blank" rel="noopener">Sitio</a>` : '',
    correos.length ? `<button class="pastilla" id="ficha-escribir">Escribirle sólo a este</button>` : '',
  ].filter(Boolean).join('');

  $('ficha-estado').innerHTML = ESTADOS.map((e) => `<option value="${e}"`
    + `${(p.estadoCrm || 'nuevo') === e ? ' selected' : ''}>${ETIQUETA_ESTADO[e]}</option>`).join('');
  $('ficha-responsable').value = p.responsable || '';
  $('ficha-paso').value = p.proximoPaso || '';
  $('ficha-paso-fecha').value = p.proximoPasoEn || '';
  $('ficha-notas').value = p.notas || '';
  $('ficha-guardado').textContent = '';
}

async function cargarHistorial(id) {
  const caja = $('ficha-historial');
  caja.innerHTML = '<li class="sub">Cargando…</li>';
  try {
    const s = await getDocs(query(collection(db, 'actividad'),
      where('rbd', '==', String(id)), orderBy('creado', 'desc'), limit(50)));
    if (s.empty) {
      caja.innerHTML = '<li class="sub">Sin movimientos todavía. Lo que registres acá '
        + 'queda para el resto del equipo.</li>';
      return;
    }
    caja.innerHTML = s.docs.map((d) => {
      const a = d.data();
      const [icono, etiqueta] = TIPO_ACTIVIDAD[a.tipo] || ['·', a.tipo];
      return `<li class="hito">
        <span class="hito-ic" aria-hidden="true">${icono}</span>
        <div><div class="hito-txt">${esc(a.texto || etiqueta)}</div>
        <div class="sub">${etiqueta} · ${fechaHora(a.creado)}</div></div></li>`;
    }).join('');
  } catch (e) {
    caja.innerHTML = `<li class="sub">${esc(e.message)}</li>`;
  }
}

const fechaHora = (t) => (t?.toDate
  ? t.toDate().toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })
  : 'recién');

async function guardarFicha() {
  const p = estado.ficha;
  if (!p) return;
  const cambios = {
    estadoCrm: $('ficha-estado').value,
    responsable: $('ficha-responsable').value.trim(),
    proximoPaso: $('ficha-paso').value.trim(),
    proximoPasoEn: $('ficha-paso-fecha').value || '',
    notas: $('ficha-notas').value.trim(),
    actualizado: serverTimestamp(),
  };
  $('ficha-guardar').disabled = true;
  try {
    await setDoc(doc(db, 'prospectos', String(p.id)), cambios, { merge: true });
    // Un cambio de estado sin rastro obliga a reconstruir la historia de
    // memoria; con rastro, cualquiera del equipo la lee.
    if (cambios.estadoCrm !== (p.estadoCrm || 'nuevo')) {
      await anotar(p.id, 'estado', `Pasa a ${ETIQUETA_ESTADO[cambios.estadoCrm]}`);
    }
    Object.assign(p, cambios);
    const enLista = estado[estado.vista]?.find((x) => x.id === p.id);
    if (enLista) Object.assign(enLista, cambios);
    $('ficha-guardado').textContent = 'Guardado';
    avisar(`${mail.titulo(p.establecimiento || p.id)}: gestión guardada.`);
    await cargarHistorial(p.id);
    if (LISTADOS.includes(estado.vista)) pintar();
  } catch (e) { mostrarError(e); } finally { $('ficha-guardar').disabled = false; }
}

/* Intenta la aplicación de WhatsApp y cae a la web si no responde. El
   esquema whatsapp:// es lo único que despierta la aplicación instalada;
   wa.me, en un computador, termina casi siempre en la web con un código
   QR. Si la aplicación toma el enlace, esta pestaña deja de estar a la
   vista y entonces no hay que mandar a nadie a ninguna parte. */
function abrirWhatsApp(numero, texto, web) {
  let salio = false;
  const marcar = () => { if (document.hidden) salio = true; };
  document.addEventListener('visibilitychange', marcar, { once: true });

  /* El intento va por un marco oculto y no por location: si nadie tiene
     registrado el esquema, el navegador se llevaría el CRM entero a una
     pantalla de error. Dentro del marco, ese fallo no se nota. */
  const marco = document.createElement('iframe');
  marco.style.display = 'none';
  marco.src = `whatsapp://send?phone=${numero}`
    + (texto ? `&text=${encodeURIComponent(texto)}` : '');
  document.body.appendChild(marco);

  setTimeout(() => {
    document.removeEventListener('visibilitychange', marcar);
    marco.remove();
    if (!salio && !document.hidden) window.open(web, '_blank', 'noopener');
  }, 1600);
}

async function anotar(rbd, tipo, texto) {
  await setDoc(doc(collection(db, 'actividad')), {
    rbd: String(rbd), tipo, texto,
    uid: auth.currentUser?.uid || '',
    autor: auth.currentUser?.email || '',
    creado: serverTimestamp(),
  });
}

function actualizarAcciones() {
  const v = estado.vista;
  const caja = $('acciones-vista');
  if (LISTADOS.includes(v)) {
    const n = estado.seleccion.size || filtrar(estado[v]).length;
    const que = estado.seleccion.size ? 'selección' : 'CSV';
    caja.innerHTML = `<button id="exportar">Exportar ${que} (${numero(n)})</button>${ay('exportar')}`
      + (PAGINADAS.includes(v)
        ? ` <button class="primario" id="crear-campana">Crear campaña con este segmento</button>${ay('crear-campana')}`
        : '');
    $('exportar').onclick = exportarCsv;
    if (PAGINADAS.includes(v)) $('crear-campana').onclick = abrirEditorDesdeSegmento;
  } else if (v === 'campanas') {
    caja.innerHTML = '<button class="primario" id="nueva-campana">Nueva campaña</button>';
    $('nueva-campana').onclick = () => {
      estado.vista = 'prospectos';
      irA('oportunidades');
      // Es una instrucción, no un fallo: por la caja roja enseñaría a
      // ignorar la caja roja.
      avisar('Elige el segmento con los filtros y pulsa “Crear campaña con este segmento”.');
    };
  } else {
    caja.innerHTML = '';
  }
}

// ============================================================
// Campañas
// ============================================================
function descripcionSegmento() {
  if (estado.seleccion.size) {
    return `${estado.seleccion.size} colegio${estado.seleccion.size === 1 ? '' : 's'}`
      + ' elegido a mano'.replace('elegido', estado.seleccion.size === 1 ? 'elegido' : 'elegidos');
  }
  const p = [];
  const lista = (id, fn) => {
    const v = seleccionados(id);
    if (v.length) p.push(v.map(fn).join(' + '));
  };
  lista('f-tier', (v) => `Tier ${v}`);
  lista('f-canal', (v) => v);
  lista('f-region', (v) => v);
  if ($('f-ate').value) p.push($('f-ate').value === 'no' ? 'sin ATE' : 'requiere ATE');
  lista('f-estado', (v) => ETIQUETA_ESTADO[v] || v);
  if (estado.vista === 'oportunidades') p.push(`dolor ${$('f-umbral').value}+`);
  return p.length ? p.join(' · ') : 'Todos los prospectos cargados';
}

/* Volver a escribirle a alguien a los pocos días de haberlo hecho no es
   insistencia, es descuido: para insistir está el seguimiento, que va
   dentro del hilo anterior. */
const DIAS_RECONTACTO = 30;

/* La selección manual gana sobre el filtro: si alguien marcó colegios
   uno por uno, eso es lo que quiere enviar, no lo que quedó en pantalla.
   Sobre eso se aplican tres podas que protegen la reputación del
   remitente, y que se informan para que nada desaparezca en silencio. */
function segmentoActual() {
  const base = estado.seleccion.size
    ? [...estado.seleccion.values()]
    : filtrar(estado[estado.vista]);
  const conCorreo = base
    .filter((p) => mail.primerCorreo(p.email))
    .map((p) => ({ ...p, rbd: p.rbd ?? Number(p.id) }));

  const podas = { baja: 0, repetido: 0, reciente: 0 };
  const porCasilla = new Map();
  const limite = Date.now() - DIAS_RECONTACTO * 864e5;

  for (const p of conCorreo) {
    if (estado.bajas.has(String(p.rbd))) { podas.baja += 1; continue; }
    if ((p.ultimoContacto?.toMillis?.() || 0) > limite) { podas.reciente += 1; continue; }

    const casilla = mail.primerCorreo(p.email).toLowerCase();
    const previo = porCasilla.get(casilla);
    if (!previo) { porCasilla.set(casilla, p); continue; }
    /* Muchos municipales comparten la casilla del DAEM. Quince correos
       casi iguales el mismo día a la misma dirección es autodenunciarse
       como spam: va uno solo, el del colegio más grande, que es el que
       mejor abre la conversación. */
    podas.repetido += 1;
    if ((Number(p.matBasica) || 0) > (Number(previo.matBasica) || 0)) {
      porCasilla.set(casilla, p);
    }
  }
  return { lista: [...porCasilla.values()], podas };
}

function abrirEditorDesdeSegmento() {
  const { lista, podas } = segmentoActual();
  estado.campanaActual = {
    id: null, nombre: '', asunto: '', cuerpo: PLANTILLA,
    segmento: { desc: descripcionSegmento() }, track: false,
  };
  estado.destinatarios = lista;
  estado.podas = podas;
  abrirEditor();
}

/* El diseño ya trae el saludo, el dato SIMCE, la propuesta de reunión y
   la firma: este texto alimenta sólo la sección "¿Qué es JUMP Math?". */
const PLANTILLA = `Es un método de enseñanza de la matemática con evidencia de impacto en estudios controlados. Entrega a los docentes una secuencia de clases estructurada que descompone cada objetivo en pasos que todo el curso puede seguir.

Para 2027 vamos a acompañar de cerca a un grupo acotado de colegios en la implementación, y {{comuna}} es una de las comunas donde queremos partir.`;

function abrirEditor() {
  const c = estado.campanaActual;
  $('c-nombre').value = c.nombre || '';
  $('c-cuerpo').value = c.cuerpo || '';
  $('c-cuerpo-b').value = c.cuerpoB || '';
  $('c-track-aperturas').checked = Boolean(c.track);
  $('c-evidencia').checked = Boolean(c.evidencia);
  delete $('c-tanda').dataset.tocado;
  restaurarContacto();
  pintarDisenio();
  pintarProgramar();
  $('segmento-desc').textContent = c.segmento?.desc || '—';
  resumenSegmento();
  pintarTanda();
  previsualizar();

  $('vista-listado').classList.add('oculto');
  $('vista-campanas').classList.add('oculto');
  $('vista-detalle').classList.add('oculto');
  $('vista-editor').classList.remove('oculto');
  $('titulo').textContent = c.id ? 'Editar campaña' : 'Nueva campaña';
  $('subtitulo').textContent = 'El correo sale desde tu cuenta de Gmail, uno por uno.';
  $('acciones-vista').innerHTML = '';
}

function resumenSegmento() {
  const d = estado.destinatarios;
  const alumnos = d.reduce((a, p) => a + (Number(p.matBasica) || 0), 0);
  const conDolor = d.filter((p) => Number(p.dolorMate) >= 60).length;
  const podas = estado.podas || {};
  const excluidos = [
    podas.baja ? `${numero(podas.baja)} dados de baja` : '',
    podas.repetido ? `${numero(podas.repetido)} que comparten casilla` : '',
    podas.reciente ? `${numero(podas.reciente)} contactados hace menos de ${DIAS_RECONTACTO} días` : '',
  ].filter(Boolean);

  $('segmento-resumen').innerHTML = `
    <span><b>${numero(d.length)}</b> destinatarios</span>
    <span><b>${numero(alumnos)}</b> alumnos</span>
    <span><b>${numero(conDolor)}</b> con dolor 60+</span>
    <span><b>${numero(d.filter((p) => !p.requiereAte).length)}</b> sin ATE</span>`
    + (excluidos.length
      ? `<span class="sub" style="flex-basis:100%">Fuera del envío: ${excluidos.join(' · ')}.</span>`
      : '');
}

/* ---------- calentamiento ----------
   El ritmo importa tanto como el mensaje: una cuenta nueva que dispara
   450 correos el primer día no llega a bandeja de entrada, llega a
   spam, y de ahí no vuelve. */
async function pintarTanda() {
  const nota = $('tanda-nota');
  let plan;
  try {
    plan = mail.tandaRecomendada(await mail.historialEnvios(db));
  } catch {
    nota.textContent = 'No se pudo leer el historial de envíos; se usará el máximo diario.';
    return;
  }
  estado.plan = plan;
  const campo = $('c-tanda');
  // Sólo se propone: si alguien ya escribió un número a mano, se respeta.
  if (!campo.dataset.tocado) campo.value = Math.min(plan.resto, estado.destinatarios.length) || plan.resto;

  nota.innerHTML = plan.diasActivos === 0
    ? `<b>Primera tanda.</b> Parte con ${plan.tope} correos: una cuenta sin
       historial que dispara cientos de mensajes termina en spam. Si mañana
       los rebotes son bajos, el tope sube solo.`
    : `Hoy llevas <b>${numero(plan.enviadosHoy)}</b> enviados de un tope
       recomendado de <b>${numero(plan.tope)}</b> (tu mayor día fue
       ${numero(plan.maximo)}). Quedan <b>${numero(plan.resto)}</b>.`;
  nota.classList.toggle('error-texto', plan.resto === 0);
  if (plan.resto === 0) {
    nota.innerHTML = `<b>Cupo del día agotado.</b> Llevas ${numero(plan.enviadosHoy)}
      envíos. Seguir hoy es lo que gatilla los bloqueos: retoma mañana con
      un tope de ${numero(Math.min(plan.tope * 2, mail.LIMITE_DIARIO))}.`;
  }
}

/* Un correo en frío que llega el sábado o a medianoche se lee como
   automático. La ventana buena en colegios es martes a jueves temprano,
   antes de que parta la jornada. */
function avisoMomento(ahora = new Date()) {
  const dia = ahora.getDay();
  const hora = ahora.getHours();
  const mes = ahora.getMonth();
  const nd = ahora.getDate();
  if (dia === 0 || dia === 6) return 'Es fin de semana: el correo quedará sepultado bajo el del lunes.';
  if (mes === 8 && nd >= 15 && nd <= 19) return 'Semana de Fiestas Patrias: los colegios están en otra. Mejor la semana siguiente.';
  if (mes === 1 && nd <= 20) return 'Los colegios aún están en vacaciones: casi nadie leerá el correo.';
  if (hora < 7 || hora >= 19) return 'Fuera de horario: un correo a esta hora se lee como envío automático.';
  if (dia === 1 && hora < 10) return 'Lunes a primera hora es cuando más correo compite. Después de las 10 rinde más.';
  if (dia === 5 && hora >= 15) return 'Viernes por la tarde: la respuesta se pierde en el fin de semana.';
  return '';
}

/* El contacto configurado sobrevive entre sesiones: el número de
   WhatsApp no debería teclearse en cada campaña. */
function ctxCorreo(extra = {}) {
  return {
    promedio: PROMEDIO_MATE,
    whatsapp: $('c-whatsapp').value.trim(),
    sitio: $('c-sitio').value.trim(),
    horarios: $('c-horarios').value.trim(),
    remitente: mail.gmailCorreo() || '',
    // La cuenta que despacha lo programado puede no ser la conectada.
    remitenteProgramado: estado.programado?.autorizacion?.correo || '',
    evidencia: $('c-evidencia').checked,
    funcion: estado.funcion,
    plantilla: estado.campanaActual?.plantilla || 'lamina',
    tema: estado.campanaActual?.tema || 'claro',
    ...extra,
  };
}

function guardarContacto() {
  try {
    localStorage.setItem('jm.contacto', JSON.stringify({
      whatsapp: $('c-whatsapp').value, sitio: $('c-sitio').value,
      horarios: $('c-horarios').value,
    }));
  } catch { /* modo privado */ }
}

function restaurarContacto() {
  try {
    const v = JSON.parse(localStorage.getItem('jm.contacto') || '{}');
    if (v.whatsapp) $('c-whatsapp').value = v.whatsapp;
    if (v.sitio) $('c-sitio').value = v.sitio;
    /* Los bloques guardados caducan solos: proponer una fecha que ya pasó
       es peor que no proponer ninguna. */
    if (v.horarios) {
      $('c-horarios').value = String(v.horarios).split(',')
        .map((s) => s.trim()).filter(Boolean).filter(vigente).join(', ');
    }
  } catch { /* nada guardado */ }
  derivarAgenda(slotsElegidos());
  pintarAgenda();
}

/* ---------- agenda de horarios ----------
   Proponer día y hora concretos consigue muchas más respuestas que un
   "cuando usted pueda", pero teclearlos es lento y se presta a erratas.
   La agenda arma el texto; el correo lo sigue leyendo como una lista
   separada por comas, así que el resto del sistema no cambia. */
const DIAS_SEM = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const HORAS = ['08:30', '09:00', '10:00', '11:00', '12:00', '15:00', '16:00', '17:00'];
/* Tres bloques es lo que mejor convierte —elegir entre tres es fácil, entre
   seis es una tarea—, pero a veces hay que abrir el abanico. */
const MAX_HORARIOS = 6;
const POR_PAGINA = 5;

/* Los días y las horas se marcan por separado y se cruzan: "martes y
   jueves, a las 10 y a las 15" son cuatro bloques con cuatro clics, no
   ocho. `excluidos` guarda los que se quitaron a mano, para que el cruce
   no los vuelva a meter; `sueltos` conserva bloques antiguos escritos sin
   fecha, que no salen de ningún cruce. */
const agenda = {
  pagina: 0,
  dias: new Set(),
  horas: new Set(),
  excluidos: new Set(),
  sueltos: [],
};

/** Los próximos días hábiles, desde mañana: nadie agenda para hoy. */
function diasHabiles() {
  const dias = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  while (dias.length < POR_PAGINA * 4) {
    if (d.getDay() !== 0 && d.getDay() !== 6) dias.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return dias;
}

const mayus = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const textoSlot = (d, hora) =>
  `${mayus(DIAS_SEM[d.getDay()])} ${d.getDate()} ${MESES[d.getMonth()]} · ${hora}`;

const slotsElegidos = () => $('c-horarios').value
  .split(',').map((s) => s.trim()).filter(Boolean);

/** El cruce de los días por las horas, menos lo quitado a mano. */
function slotsDelCruce() {
  const porFecha = new Map(diasHabiles().map((d) => [d.toDateString(), d]));
  const salida = [];
  for (const clave of agenda.dias) {
    const d = porFecha.get(clave);
    if (!d) continue;
    for (const h of agenda.horas) {
      const t = textoSlot(d, h);
      if (!agenda.excluidos.has(t)) salida.push(t);
    }
  }
  return [...agenda.sueltos, ...salida];
}

function ponerSlots(lista) {
  // Ordenados por fecha y hora: proponer las 15:00 antes que las 09:00
  // del mismo día se lee como descuido.
  const unicos = [...new Set(lista)].sort((a, b) => orden(a) - orden(b));
  $('c-horarios').value = unicos.slice(0, MAX_HORARIOS).join(', ');
  guardarContacto();
  pintarAgenda();
  previsualizar();
}

/** Recalcula el cruce y lo deja en el campo. */
const recalcularAgenda = () => ponerSlots(slotsDelCruce());

/* Al volver a abrir el editor hay una lista de bloques, no una selección
   de días y horas. Se deduce cuáles marcar, y lo que el cruce añadiría de
   más se da por quitado: así lo que se ve es exactamente lo que se había
   guardado, ni un bloque más. */
function derivarAgenda(lista) {
  agenda.dias = new Set();
  agenda.horas = new Set();
  agenda.excluidos = new Set();
  agenda.sueltos = [];
  for (const t of lista) {
    const f = fechaSlot(t);
    const h = String(t).match(/\d{1,2}:\d{2}/)?.[0];
    if (!f || !h) { agenda.sueltos.push(t); continue; }
    agenda.dias.add(f.toDateString());
    agenda.horas.add(h);
  }
  for (const t of slotsDelCruce()) {
    if (!lista.includes(t)) agenda.excluidos.add(t);
  }
}

/** Momento del bloque en milisegundos, para ordenarlos. Un texto sin
 *  fecha reconocible se queda al principio, en el orden en que estaba. */
function orden(texto) {
  const f = fechaSlot(texto);
  if (!f) return 0;
  const h = String(texto).match(/(\d{1,2}):(\d{2})/);
  return f.getTime() + (h ? (Number(h[1]) * 60 + Number(h[2])) * 60000 : 0);
}

/** La fecha que nombra el bloque, o null si no lleva ninguna. */
function fechaSlot(texto) {
  const m = String(texto).match(/(\d{1,2})\s+([a-z]{3})/i);
  if (!m) return null;
  const mes = MESES.indexOf(m[2].toLowerCase());
  if (mes < 0) return null;
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const f = new Date(hoy.getFullYear(), mes, Number(m[1]));
  // Los bloques no llevan año: diciembre visto en enero es del año
  // pasado, y enero visto en diciembre es del que viene.
  const medioAno = 180 * 864e5;
  if (f - hoy > medioAno) f.setFullYear(f.getFullYear() - 1);
  else if (hoy - f > medioAno) f.setFullYear(f.getFullYear() + 1);
  return f;
}

/** ¿El bloque sigue por venir? Un texto antiguo sin fecha ("Martes
 *  10:00") se da por válido: no hay nada que caduque. */
function vigente(texto) {
  const f = fechaSlot(texto);
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  return !f || f >= hoy;
}

function pintarAgenda() {
  const dias = diasHabiles();
  const pagina = dias.slice(agenda.pagina * POR_PAGINA, (agenda.pagina + 1) * POR_PAGINA);

  $('ag-mes').textContent = pagina.length
    ? mayus(pagina[0].toLocaleDateString('es-CL', { month: 'long', year: 'numeric' })) : '';
  $('ag-antes').disabled = agenda.pagina === 0;
  $('ag-despues').disabled = (agenda.pagina + 1) * POR_PAGINA >= dias.length;

  // Un día marcado en otra semana sigue contando aunque no se vea: el
  // recuento lo dice para que no parezca que se perdió.
  const fuera = [...agenda.dias].filter((c) => !pagina.some((d) => d.toDateString() === c)).length;

  $('ag-dias').innerHTML = pagina.map((d) => `
    <button type="button" class="ag-dia" data-fecha="${d.toDateString()}"
            aria-pressed="${agenda.dias.has(d.toDateString())}">
      ${DIAS_SEM[d.getDay()].slice(0, 3)}<b>${d.getDate()}</b>
    </button>`).join('');

  $('ag-horas').innerHTML = HORAS.map((h) => `
    <button type="button" class="ag-hora" data-hora="${h}"
            aria-pressed="${agenda.horas.has(h)}">${h}</button>`).join('');

  const elegidos = slotsElegidos();
  const cruce = slotsDelCruce().length;
  const pista = !agenda.dias.size
    ? 'Marca uno o varios días.'
    : !agenda.horas.size
      ? 'Ahora marca las horas: se aplican a todos los días marcados.'
      : cruce > MAX_HORARIOS
        ? `${cruce} bloques para ${agenda.dias.size} días × ${agenda.horas.size} horas: `
          + `el correo mostrará los primeros ${MAX_HORARIOS}.`
        : fuera
          ? `Incluye ${fuera} día${fuera === 1 ? '' : 's'} de otra semana.`
          : '';

  $('ag-elegidos').innerHTML = (elegidos.length
    ? elegidos.map((t, i) => `<span class="chip">${esc(t)}`
      + `<button data-quitar="${i}" title="Quitar">×</button></span>`).join('')
    : '<span class="ag-vacio">Sin bloques: el correo sólo invitará a responder.</span>')
    + (pista ? `<span class="ag-vacio">${esc(pista)}</span>` : '');
}

/* ---------- diseño del correo ----------
   El contenido es el mismo en las cinco plantillas: cambia qué bloques
   aparecen y con qué forma. Poder probarlas es lo que permite descubrir
   cuál abre más en esta base, en vez de discutirlo. */
function pintarDisenio() {
  const c = estado.campanaActual || {};
  $('c-tema').innerHTML = Object.entries(mail.TEMAS).map(([id, t]) => `
    <button type="button" data-tema="${id}"
            aria-pressed="${(c.tema || 'claro') === id}">${esc(t.nombre)}</button>`).join('');

  $('c-plantilla').innerHTML = Object.entries(mail.PLANTILLAS).map(([id, p]) => `
    <button type="button" class="plantilla" data-plantilla="${id}"
            aria-pressed="${(c.plantilla || 'lamina') === id}">
      <span class="nombre">${esc(p.nombre)}</span>
      <span class="sub">${esc(p.idea)}</span>
    </button>`).join('');
}

$('c-tema').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tema]');
  if (!b) return;
  estado.campanaActual.tema = b.dataset.tema;
  pintarDisenio();
  previsualizar();
});

$('c-plantilla').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-plantilla]');
  if (!b) return;
  estado.campanaActual.plantilla = b.dataset.plantilla;
  pintarDisenio();
  previsualizar();
});

/* Las seis versiones, con la del destinatario de la vista previa
   marcada. No se elige ninguna: se muestran para que quien manda sepa
   exactamente qué va a aparecer en la bandeja, que es distinto de
   poder cambiarlo. */
function pintarAsuntos() {
  const caja = $('lista-asuntos');
  if (!caja) return;
  const ejemplo = estado.destinatarios[0];
  const ctx = ctxCorreo();
  const suya = ejemplo ? mail.asuntoDe(ejemplo, ctx).variante : -2;
  caja.innerHTML = mail.ASUNTOS.map((plantilla, i) => {
    const texto = ejemplo
      ? mail.aplicarVariables(plantilla, ejemplo, ctx)
      : plantilla;
    return `<li class="${i === suya ? 'suya' : ''}">${esc(texto)}${
      i === suya ? '<span class="marca">la de este colegio</span>' : ''}</li>`;
  }).join('');
}

function previsualizar() {
  const ejemplo = estado.destinatarios[0];
  const caja = $('previsualizacion');
  pintarAsuntos();
  pintarResumenes();
  if (!ejemplo) { caja.textContent = 'Sin destinatarios en el segmento.'; return; }
  const ctx = ctxCorreo();
  const asunto = mail.asuntoDe(ejemplo, ctx).texto;
  const texto = mail.aplicarVariables($('c-cuerpo').value, ejemplo, ctx);

  caja.innerHTML = `<span class="asunto">${esc(asunto)}</span>`
    + `<div class="sub">Para: ${esc(mail.primerCorreo(ejemplo.email))} · ${esc(ejemplo.establecimiento)}</div>`;
  // El correo real es un documento completo con sus propios estilos: se
  // muestra en un iframe para que no choque con los de la app.
  const marco = document.createElement('iframe');
  marco.style.cssText = 'width:100%;height:460px;border:0;border-radius:8px;margin-top:8px;background:#eef1f5';
  marco.srcdoc = mail.correoHtml({
    texto, prospecto: ejemplo, ctx, base: location.origin, track: false,
    // Un seguimiento sale en pieza breve: la vista previa tiene que
    // mostrar lo que de verdad va a llegar.
    breve: Boolean(estado.campanaActual?.seguimientoDe),
  });
  caja.appendChild(marco);
}

async function pintarCampanas() {
  estado.campanas = await mail.listarCampanas(db);
  $('n-campanas').textContent = numero(estado.campanas.length);
  $('campanas-vacio').classList.toggle('oculto', estado.campanas.length > 0);
  $('cuerpo-campanas').innerHTML = estado.campanas.map((c) => {
    const t = c.totales || {};
    const chip = { enviada: 'enviado', programada: 'programado', error: 'malo' }[c.estado]
      || 'pendiente';
    return `<tr>
      <td><div class="nombre">${esc(c.nombre)}</div><div class="sub">${esc(c.asunto || 'Asunto automático')}</div></td>
      <td><span class="env ${chip}">${esc(c.estado)}</span>${
        c.estado === 'programada' && c.programadaPara
          ? `<div class="sub">${esc(cuandoSale(c.programadaPara))}</div>` : ''}${
        c.errorProgramado ? `<div class="sub malo">${esc(c.errorProgramado)}</div>` : ''}</td>
      <td class="num">${numero(t.destinatarios)}</td>
      <td class="num">${numero(t.enviados)}</td>
      <td class="num">${numero(t.respuestas)}</td>
      <td class="num">${c.track ? numero(t.aperturas) : '—'}</td>
      <td>${fecha(c.creado)}</td>
      <td><button data-abrir="${esc(c.id)}">Ver</button></td></tr>`;
  }).join('');
}

/* Cada corte responde a una acción distinta: "calientes" es la lista de
   llamadas del día —abrieron el correo y no contestaron—, "problemas"
   es la limpieza de la base. */
const FILTROS_DETALLE = {
  todos: () => true,
  calientes: (d) => (d.aperturas || 0) > 0
    && !['respondido', 'rebotado', 'baja', 'error', 'pendiente'].includes(d.estado),
  respondieron: (d) => d.estado === 'respondido',
  'sin-abrir': (d) => d.estado === 'enviado' && !(d.aperturas > 0),
  problemas: (d) => ['error', 'rebotado', 'baja'].includes(d.estado),
};

const porcentaje = (parte, total) => (total ? Math.round((parte / total) * 100) : 0);

/* Umbrales de una campaña en frío a colegios. Sirven para saber qué
   corregir: apertura baja es problema de asunto o de remitente; respuesta
   baja con apertura alta es problema del mensaje. */
function tono(valor, bueno, malo, invertido = false) {
  if (invertido) return valor <= bueno ? 'ok' : valor > malo ? 'critico' : 'aviso';
  return valor >= bueno ? 'ok' : valor < malo ? 'critico' : 'aviso';
}

async function abrirDetalle(id) {
  estado.campanaActual = await mail.leerCampana(db, id);
  $('vista-listado').classList.add('oculto');
  $('vista-campanas').classList.add('oculto');
  $('vista-editor').classList.add('oculto');
  $('vista-detalle').classList.remove('oculto');
  $('titulo').textContent = estado.campanaActual?.nombre || 'Campaña';
  $('subtitulo').textContent = estado.campanaActual?.asunto || '';
  $('acciones-vista').innerHTML = '';
  $('detalle-cargando').classList.remove('oculto');

  const dest = await mail.listarDestinatarios(db, id);
  estado.destinatarios = dest;
  const c = estado.campanaActual;
  const t = c?.totales || {};
  const pendientes = dest.filter((d) => d.estado === 'pendiente').length;
  const enviados = dest.filter((d) => !['pendiente', 'error'].includes(d.estado)).length;
  const abiertos = dest.filter((d) => (d.aperturas || 0) > 0).length;
  const respondieron = dest.filter((d) => d.estado === 'respondido').length;
  const problemas = dest.filter((d) => ['error', 'rebotado', 'baja'].includes(d.estado)).length;
  $('caja-reanudar').classList.toggle('oculto', pendientes === 0);
  $('d-seguimiento').classList.toggle('oculto',
    enviados === 0 || Boolean(c?.seguimientoDe));

  const tasaApertura = porcentaje(abiertos, enviados);
  const tasaRespuesta = porcentaje(respondieron, enviados);
  const tasaProblema = porcentaje(problemas, enviados);

  $('kpis-campana').innerHTML = [
    { e: 'Destinatarios', v: numero(dest.length), n: 'con correo' },
    { e: 'Enviados', v: numero(enviados), n: pendientes ? `${numero(pendientes)} pendientes` : 'tanda completa' },
    c?.track
      ? { e: 'Abrieron', v: `${tasaApertura}%`, t: tono(tasaApertura, 35, 20), a: 'kpi-apertura',
        n: tasaApertura >= 35 ? `${numero(abiertos)} de ${numero(enviados)}`
          : 'bajo el objetivo (35%): revisa el asunto y el remitente' }
      : { e: 'Aperturas', v: '—', n: 'seguimiento desactivado', a: 'kpi-apertura' },
    { e: 'Respuestas', v: `${tasaRespuesta}%`, t: tono(tasaRespuesta, 3, 1), a: 'kpi-respuesta',
      n: tasaRespuesta >= 3 ? `${numero(respondieron)} respuestas · la métrica que importa`
        : 'bajo el objetivo (3%): revisa el mensaje y la propuesta' },
    { e: 'Rebotes y bajas', v: `${tasaProblema}%`, t: tono(tasaProblema, 3, 6, true), a: 'kpi-rebotes',
      n: tasaProblema > 3 ? 'alto: depura la lista antes de la próxima tanda'
        : `${numero(problemas)} de ${numero(enviados)}` },
  ].map((k) => `<div class="kpi ${k.t || ''}">
      <div class="etiqueta">${esc(k.e)}${k.a ? ay(k.a) : ''}</div>
      <div class="valor">${esc(k.v)}</div><div class="nota">${esc(k.n)}</div></div>`).join('');

  pintarComparacion(dest, c);
  pintarDestinatarios();
  $('detalle-cargando').classList.add('oculto');
}

/* Sin esta tabla, una prueba A/B es sólo dos correos distintos: lo que
   convierte el experimento en decisión es ver las dos columnas juntas. */
function pintarComparacion(dest, campana) {
  const caja = $('ab-comparacion');
  const hayB = dest.some((d) => d.variante === 'B');
  const porAsunto = comparacionAsuntos(dest, campana);
  caja.classList.toggle('oculto', !hayB && !porAsunto);
  if (!hayB && !porAsunto) return;
  if (!hayB) { caja.innerHTML = porAsunto; return; }

  const fila = (nombre, asunto, filas) => {
    const env = filas.filter((d) => !['pendiente', 'error'].includes(d.estado)).length;
    const abr = filas.filter((d) => (d.aperturas || 0) > 0).length;
    const res = filas.filter((d) => d.estado === 'respondido').length;
    return `<tr>
      <td><b>${nombre}</b><div class="sub">${esc(asunto || '(igual que A)')}</div></td>
      <td class="num">${numero(env)}</td>
      <td class="num">${campana?.track ? `${porcentaje(abr, env)}%` : '—'}</td>
      <td class="num">${porcentaje(res, env)}%</td>
      <td class="num">${numero(res)}</td></tr>`;
  };
  caja.innerHTML = `<div class="envoltura">
    <table>
      <thead><tr><th>Variante</th><th class="num">Enviados</th>
        <th class="num">Abrieron</th><th class="num">Respuesta</th>
        <th class="num">Respuestas</th></tr></thead>
      <tbody>
        ${fila('A', 'mensaje original', dest.filter((d) => d.variante !== 'B'))}
        ${fila('B', 'mensaje alternativo', dest.filter((d) => d.variante === 'B'))}
      </tbody>
    </table>
    <p class="sub" style="padding:8px 14px 12px">Con menos de 30 envíos por
      variante la diferencia todavía es azar; sirve para descartar un desastre,
      no para elegir ganador.</p>
  </div>` + porAsunto;
}

/* Qué asunto abrió mejor. Es el sentido de rotar seis: sin esta tabla,
   la rotación sólo sería variedad. Se ordena por tasa de apertura, que
   es lo que el asunto controla —lo que pase después ya es del mensaje. */
function comparacionAsuntos(dest, campana) {
  const enviados = dest.filter((d) => !['pendiente', 'error'].includes(d.estado)
    && Number.isInteger(d.asuntoVariante));
  if (!campana?.track || enviados.length < 2) return '';

  const grupos = new Map();
  for (const d of enviados) {
    const g = grupos.get(d.asuntoVariante) || { texto: d.asunto || '', env: 0, abr: 0, res: 0 };
    g.env += 1;
    if ((d.aperturas || 0) > 0) g.abr += 1;
    if (d.estado === 'respondido') g.res += 1;
    grupos.set(d.asuntoVariante, g);
  }
  if (grupos.size < 2) return '';

  const filas = [...grupos.values()]
    .sort((a, b) => (b.abr / b.env) - (a.abr / a.env))
    .map((g, i) => `<tr>
      <td>${i === 0 && g.abr ? '<b>▲</b> ' : ''}${esc(g.texto)}</td>
      <td class="num">${numero(g.env)}</td>
      <td class="num">${porcentaje(g.abr, g.env)}%</td>
      <td class="num">${numero(g.res)}</td></tr>`).join('');

  return `<h3 style="margin:18px 0 8px">Qué asunto se abre más</h3>
    <div class="envoltura"><table>
      <thead><tr><th>Asunto</th><th class="num">Enviados</th>
        <th class="num">Abrieron</th><th class="num">Respuestas</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <p class="sub" style="padding:8px 14px 12px">Los asuntos rotan solos, uno por
      colegio. Con pocas decenas de envíos por versión esto todavía es ruido;
      después de dos o tres tandas empieza a significar algo.</p>
  </div>`;
}

function pintarDestinatarios() {
  const filtro = FILTROS_DETALLE[estado.filtroDetalle] || FILTROS_DETALLE.todos;
  // Quien más veces abrió, primero: en una lista de llamadas el orden es
  // la mitad del trabajo.
  const filas = estado.destinatarios.filter(filtro)
    .sort((a, b) => (b.aperturas || 0) - (a.aperturas || 0));
  const conVariantes = estado.destinatarios.some((d) => d.variante === 'B');

  for (const b of $('filtros-detalle').querySelectorAll('button[data-filtro]')) {
    b.setAttribute('aria-pressed', String(b.dataset.filtro === estado.filtroDetalle));
  }

  $('cuerpo-destinatarios').innerHTML = filas.map((d) => `<tr>
    <td><div class="nombre">${esc(d.establecimiento)}</div>
      <div class="sub">RBD ${esc(d.rbd)} · ${esc(d.comuna)}${
  conVariantes ? ` · variante ${esc(d.variante || 'A')}` : ''}</div></td>
    <td>${d.email ? `<a href="mailto:${esc(d.email)}">${esc(d.email)}</a>` : '<span class="sin-contacto">sin correo</span>'}</td>
    <td><span class="env ${esc(d.estado)}">${esc(d.estado)}</span></td>
    <td>${fecha(d.enviadoEn)}</td>
    <td class="num">${numero(d.aperturas)}</td>
    <td class="sub">${esc(d.error || '')}</td></tr>`).join('');
  $('vacio-detalle')?.remove();
  if (!filas.length) {
    $('cuerpo-destinatarios').innerHTML = `<tr id="vacio-detalle"><td colspan="6" class="sub"
      style="padding:18px">Nadie en este corte todavía.</td></tr>`;
  }
}

/* El seguimiento es la mejora de mayor retorno de toda la operación: un
   solo toque en frío deja la mayoría de las respuestas sobre la mesa.
   Va dentro del hilo original, a quien no contestó, y nunca a quien
   rebotó o pidió la baja. */
const PLANTILLA_SEGUIMIENTO = `Le escribo por si el correo anterior quedó sepultado: sé cómo son las bandejas en época de matrícula.

Sigue en pie la reunión de 30 minutos para mostrarles cómo se implementa JUMP Math y qué resultados han tenido otros colegios. Si prefiere, respóndame con una hora y yo me acomodo.`;

function crearSeguimiento() {
  const original = estado.campanaActual;
  const pendientes = estado.destinatarios.filter(
    (d) => d.estado === 'enviado' || d.estado === 'abierto');
  if (!pendientes.length) {
    mostrarError({ message: 'No quedan destinatarios sin responder en esta campaña.' });
    return;
  }
  estado.campanaActual = {
    id: null,
    nombre: `${original.nombre} · seguimiento`,
    // El "Re:" es lo que hace que Gmail lo muestre como continuación.
    asunto: /^re:/i.test(original.asunto) ? original.asunto : `Re: ${original.asunto}`,
    cuerpo: PLANTILLA_SEGUIMIENTO,
    seguimientoDe: original.id,
    segmento: { desc: `Sin respuesta en “${original.nombre}”` },
    track: Boolean(original.track),
  };
  estado.destinatarios = pendientes;
  estado.podas = {};
  abrirEditor();
  $('subtitulo').textContent = 'Sale dentro del hilo del primer correo, en pieza breve.';
}

function progreso(txt) {
  const p = $('c-progreso');
  p.classList.remove('oculto');
  p.textContent = txt;
}

async function enviar() {
  const c = estado.campanaActual;
  if (c.estado === 'programada') {
    mostrarError({ message: 'Esta campaña ya está programada y saldrá sola. Si '
      + 'quieres mandarla ahora, cancela primero la programación.' });
    return;
  }
  if (!mail.gmailConectado()) { mostrarError({ message: 'Conecta Gmail antes de enviar.' }); return; }
  if (!estado.destinatarios.length) { mostrarError({ message: 'El segmento no tiene destinatarios con correo.' }); return; }

  // El cupo del día manda: pasarlo es lo que gatilla los bloqueos.
  await pintarTanda();
  const pedidos = Number($('c-tanda').value) || estado.plan?.resto || mail.LIMITE_DIARIO;
  const cupo = Math.min(estado.plan?.resto ?? mail.LIMITE_DIARIO, mail.LIMITE_DIARIO);
  const tanda = estado.destinatarios.slice(0, Math.min(pedidos, cupo));
  if (!tanda.length) {
    mostrarError({ message: 'Se acabó el cupo de hoy. Retoma mañana con el doble.' });
    return;
  }

  const momento = avisoMomento();
  const restantes = estado.destinatarios.length - tanda.length;
  // El remitente puede venir del permiso guardado en el servidor: sin
  // este respaldo la confirmación decía "se enviarán 7 correos desde ."
  const desde = mail.gmailCorreo() || estado.programado?.autorizacion?.correo
    || 'tu cuenta conectada';
  if (!confirm(`Se enviarán ${tanda.length} correos desde ${desde}.\n`
    + (restantes ? `Quedan ${restantes} para las próximas tandas.\n` : '')
    + ($('c-cuerpo-b').value.trim()
      ? 'La mitad recibirá la variante B.\n' : '')
    + (momento ? `\n⚠ ${momento}\n` : '')
    + '\nCada uno es un mensaje real. ¿Continuar?')) return;

  Object.assign(c, {
    nombre: $('c-nombre').value.trim() || 'Sin nombre',
    cuerpo: $('c-cuerpo').value,
    cuerpoB: $('c-cuerpo-b').value.trim(),
    evidencia: $('c-evidencia').checked,
    track: $('c-track-aperturas').checked,
  });
  c.id = await mail.guardarCampana(db, c, estado.destinatarios, auth.currentUser.uid);

  estado.cancelar = false;
  $('c-enviar').disabled = true;
  const prospectos = new Map(estado.destinatarios.map((p) => [String(p.rbd), p]));
  /* Sólo los que de verdad salieron: marcar la tanda completa pondría
     ultimoContacto a quien dio error o quedó sin intentar por un corte,
     y la guardia de 30 días lo escondería de la próxima campaña sin que
     nadie le haya escrito nunca. */
  const exitosos = new Set();
  try {
    const r = await mail.enviarCampana(db, c, tanda,
      ctxCorreo({ prospectos, cancelado: () => estado.cancelar }),
      ({ i, total, d, error }) => {
        if (!error) exitosos.add(String(d.rbd));
        progreso(`${i}/${total} · ${d.establecimiento || d.rbd}${error ? ` — ERROR: ${error}` : ''}`);
      });
    progreso(`Listo: ${r.enviados} enviados, ${r.errores} con error.`);
    avisar(`${r.enviados} correos enviados. En 48 horas, pulsa "Revisar respuestas".`);
    await marcarContactados(tanda.filter((d) => exitosos.has(String(d.rbd))), c);
    await pintarCampanas();
    await abrirDetalle(c.id);
  } catch (e) {
    mostrarError(e);
  } finally {
    $('c-enviar').disabled = false;
  }
}

/* Un correo enviado cambia el estado del prospecto en el CRM: si no, la
   próxima campaña volvería a incluirlo como si nunca se le hubiera
   escrito. */
async function marcarContactados(destinatarios, campana) {
  // En lotes y no uno por uno: con 450 destinatarios, una escritura por
  // vuelta deja la pantalla congelada minutos después de terminar el
  // envío, que es justo cuando uno cree que ya acabó.
  for (let i = 0; i < destinatarios.length; i += 200) {
    const b = writeBatch(db);
    for (const d of destinatarios.slice(i, i + 200)) {
      b.set(doc(db, 'prospectos', String(d.rbd)), {
        estadoCrm: 'contactado',
        // La fecha es lo que impide que la campaña de la semana próxima
        // vuelva a escribirle a quien ya recibió este correo.
        ultimoContacto: serverTimestamp(),
        actualizado: serverTimestamp(),
      }, { merge: true });
      // El envío también es historia del colegio, no sólo de la campaña.
      b.set(doc(collection(db, 'actividad')), {
        rbd: String(d.rbd),
        tipo: 'envio',
        texto: `Correo enviado · ${campana?.nombre || 'campaña'}`,
        uid: auth.currentUser?.uid || '',
        creado: serverTimestamp(),
      });
    }
    try {
      await b.commit();
    } catch { /* el estado del CRM no debe hacer fallar el envío */ }
  }
}

// ---------- eventos ----------
let temporizador;
function alFiltrar({ inmediato = false } = {}) {
  clearTimeout(temporizador);
  const correr = async () => {
    if (PAGINADAS.includes(estado.vista)) {
      estado.ultimoDoc = null;
      await cargarProspectos();
    } else pintar();
  };
  if (inmediato) correr(); else temporizador = setTimeout(correr, 280);
}

document.querySelector('.lateral').addEventListener('click', async (e) => {
  const b = e.target.closest('button.nav');
  if (!b) return;
  const v = b.dataset.vista;
  irA(v);
  if (v === 'hoy') { await cargarHoy(); return; }
  if (v === 'panel') { await cargarPanel(); return; }
  if (v === 'campanas') { await pintarCampanas(); return; }
  if (PAGINADAS.includes(v) && !estado[v].length) { await cargarProspectos(); poblarFiltros(); }
  else pintar();
});

// --- selección de filas ---
$('cuerpo').addEventListener('click', (e) => {
  const marcar = e.target.closest('input[data-marcar]');
  if (marcar) {
    const fila = estado[estado.vista].find((f) => f.id === marcar.dataset.marcar);
    if (!fila) return;
    const k = claveFila(fila);
    if (marcar.checked) estado.seleccion.set(k, fila); else estado.seleccion.delete(k);
    marcar.closest('tr').classList.toggle('marcada', marcar.checked);
    pintarSeleccion();
    return;
  }
  const solo = e.target.closest('button[data-solo]');
  if (solo) {
    const fila = estado[estado.vista].find((f) => f.id === solo.dataset.solo);
    if (!fila) return;
    estado.seleccion.clear();
    estado.seleccion.set(claveFila(fila), fila);
    pintarSeleccion();
    abrirEditorDesdeSegmento();
    return;
  }
  /* Cualquier otro punto de la fila abre la ficha. Los controles —casilla,
     selector de estado, correo— siguen haciendo lo suyo: si hacer clic en
     un enlace abriera además un panel, nadie volvería a hacer clic. */
  if (e.target.closest('input, select, a, button')) return;
  const tr = e.target.closest('tr[data-id]');
  if (tr && PAGINADAS.includes(estado.vista)) abrirFicha(tr.dataset.id);
});

$('cabecera-tabla').addEventListener('change', (e) => {
  if (e.target.id !== 'sel-todos') return;
  // Marca sólo lo visible tras los filtros, no los 7.808 de la base.
  const visibles = filtrar(estado[estado.vista]);
  for (const f of visibles) {
    const k = claveFila(f);
    if (e.target.checked) estado.seleccion.set(k, f); else estado.seleccion.delete(k);
  }
  pintar();
});

$('sel-limpiar').addEventListener('click', () => { estado.seleccion.clear(); pintar(); });

$('sel-copiar').addEventListener('click', async () => {
  const correos = [...new Set([...estado.seleccion.values()]
    .map((f) => mail.primerCorreo(f.email)).filter(Boolean))];
  if (!correos.length) { mostrarError({ message: 'La selección no tiene correos.' }); return; }
  try {
    await navigator.clipboard.writeText(correos.join(', '));
    $('sel-copiar').textContent = `Copiados ${correos.length}`;
    setTimeout(() => { $('sel-copiar').textContent = 'Copiar correos'; }, 1800);
  } catch (e) { mostrarError(e); }
});
$('sel-campana').addEventListener('click', abrirEditorDesdeSegmento);

// --- filtros ---
$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-limpiar]');
  if (!b) return;
  const id = b.dataset.limpiar;
  if (MULTI.includes(id)) {
    // Quitar la ficha de un valor no borra los demás valores del filtro.
    if (b.dataset.valor !== undefined) estado.multi[id].delete(b.dataset.valor);
    else estado.multi[id].clear();
    refrescarMulti(id);
  } else {
    $(id).value = '';
  }
  guardarFiltros();
  alFiltrar({ inmediato: true });
});

function limpiarFiltros() {
  for (const id of CAMPOS_FILTRO) {
    if (id === 'f-orden') continue;
    if (id === 'f-umbral') { $(id).value = '60'; continue; }
    if (MULTI.includes(id)) { estado.multi[id].clear(); refrescarMulti(id); continue; }
    $(id).value = '';
  }
  guardarFiltros();
  alFiltrar({ inmediato: true });
}
$('limpiar-filtros').addEventListener('click', limpiarFiltros);
// Un estado vacío sin salida deja al usuario mirando una tabla en blanco.
$('vacio-limpiar').addEventListener('click', limpiarFiltros);

// "/" enfoca la búsqueda, como en cualquier herramienta de trabajo diario
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    e.preventDefault();
    $('buscar').focus();
  }
  if (e.key === 'Escape' && estado.seleccion.size) { estado.seleccion.clear(); pintar(); }
});

$('buscar').addEventListener('input', () => { guardarFiltros(); alFiltrar(); });
// ---------- filtros de varios valores ----------
document.addEventListener('click', (e) => {
  const boton = e.target.closest('.multi-boton');
  const dentro = e.target.closest('.multi-panel');
  if (!boton && !dentro) { cerrarPaneles(); return; }
  if (!boton) return;
  const panel = boton.nextElementSibling;
  const abierto = !panel.classList.contains('oculto');
  cerrarPaneles();
  if (abierto) return;
  panel.classList.remove('oculto');
  boton.setAttribute('aria-expanded', 'true');
});

$('filtros').addEventListener('change', (e) => {
  const casilla = e.target.closest('.multi-panel input[type="checkbox"]');
  if (!casilla) return;
  alternarMulti(casilla.closest('.multi').dataset.para, casilla.value, casilla.checked);
});

$('filtros').addEventListener('click', (e) => {
  const nada = e.target.closest('.multi-nada');
  if (!nada) return;
  const id = nada.closest('.multi').dataset.para;
  estado.multi[id].clear();
  refrescarMulti(id);
  guardarFiltros();
  alFiltrar({ inmediato: true });
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarPaneles(); });

for (const id of ['f-ate', 'f-correo', 'f-orden', 'f-umbral']) {
  $(id).addEventListener('change', () => { guardarFiltros(); alFiltrar({ inmediato: true }); });
}
$('mas').addEventListener('click', () => cargarProspectos({ continuar: true }));

// Las reglas sólo permiten tocar los campos de gestión comercial.
$('cuerpo').addEventListener('change', async (e) => {
  const sel = e.target.closest('select.estado');
  if (!sel) return;
  const { col, id } = sel.dataset;
  const previo = estado[col === 'prospectos' ? estado.vista : col]?.find((x) => x.id === id)?.estadoCrm;
  sel.disabled = true;
  try {
    await setDoc(doc(db, col, id),
      { estadoCrm: sel.value, actualizado: serverTimestamp() }, { merge: true });
    limpiarError();
  } catch (err) {
    sel.value = previo || 'nuevo';
    mostrarError(err);
  } finally { sel.disabled = false; }
});

$('cuerpo-campanas').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-abrir]');
  if (b) abrirDetalle(b.dataset.abrir);
});

async function conectar(leer) {
  try {
    // Si el permiso ya está guardado en el servidor no hay nada que
    // preguntarle a Google: pedir consentimiento otra vez sería hacerle
    // repetir un trámite que ya hizo.
    const r = await mail.conectarPorServidor(auth)
      .catch(() => mail.conectarGmail(auth, { leer }));
    pintarEstadoGmail(r.correo, r.leer);
    limpiarError();
  } catch (e) { mostrarError(e); }
}
$('conectar-gmail').addEventListener('click', () => conectar(true));
$('conectar-solo-envio').addEventListener('click', () => conectar(false));

/* Conectar solo al abrir la app. Sin esto, el permiso guardado seguiría
   ahí pero habría que pulsar un botón para usarlo, que es justo la
   molestia que se quería quitar. */
async function conectarSolo() {
  if (!estado.programado?.autorizacion) return;
  try {
    const r = await mail.conectarPorServidor(auth);
    pintarEstadoGmail(r.correo, r.leer);
  } catch { /* el camino largo sigue disponible en el botón */ }
}

// Y renovar el token en silencio cuando venza a mitad de faena.
mail.alRenovarToken(() => mail.conectarPorServidor(auth));

/* La casilla de aperturas sólo sirve si la función está desplegada.
   Preguntar por ella evita una opción que promete algo que no ocurre. */
async function comprobarSeguimiento() {
  const nota = $('track-aviso');
  const casilla = $('c-track-aperturas');
  try {
    const r = await fetch('/t/estado', { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    if (!j?.ok) throw new Error('sin servicio');
    estado.funcion = true;
    estado.programado = {
      disponible: Boolean(j.programado),
      clientId: j.clientId || '',
      autorizacion: j.autorizacion || null,
    };
    casilla.disabled = false;
    casilla.checked = true;
    nota.textContent = 'Seguimiento activo. Las aperturas registradas en los primeros '
      + '15 segundos se marcan como escáner y no cuentan: los filtros antispam cargan '
      + 'las imágenes al recibir, no al leer.';
  } catch {
    estado.funcion = false;
    estado.programado = { disponible: false, clientId: '', autorizacion: null };
    casilla.disabled = true;
    casilla.checked = false;
    nota.textContent = 'La función de seguimiento no está desplegada, así que no se '
      + 'registrarán aperturas ni clics, y el correo saldrá sin el enlace de baja de '
      + 'un clic que Gmail premia. Envíos, errores, rebotes y respuestas sí se miden. '
      + 'Para activarla: firebase deploy --only functions';
  }
}

// ---------- envío programado ----------
/* Programar no es una comodidad: la hora a la que llega un correo frío
   decide si se lee. Un martes a las 8 de la mañana el director abre la
   bandeja y el mensaje está arriba; el mismo correo enviado un viernes
   a las 19 aparece bajo cuarenta más y ya nadie vuelve. */

const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function cuandoSale(t) {
  const d = t?.toDate?.() || (t instanceof Date ? t : null);
  if (!d) return '';
  const dos = (n) => String(n).padStart(2, '0');
  return `${DIAS_ES[d.getDay()]} ${d.getDate()} ${MESES_ES[d.getMonth()]} · `
    + `${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

/* El próximo momento razonable para que un correo caiga arriba en la
   bandeja: día hábil y temprano. El fin de semana se salta entero. */
function proximoHabil(hora = 8) {
  const d = new Date();
  if (d.getHours() >= hora) d.setDate(d.getDate() + 1);
  d.setHours(hora, 0, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

function ponerCuando(d) {
  const dos = (n) => String(n).padStart(2, '0');
  $('c-fecha').value = `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
  $('c-hora').value = `${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

function leerCuando() {
  const [f, h] = [$('c-fecha').value, $('c-hora').value];
  if (!f || !h) return null;
  const [a, m, dia] = f.split('-').map(Number);
  const [hh, mm] = h.split(':').map(Number);
  const d = new Date(a, m - 1, dia, hh, mm, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* Un permiso de Google para una app sin verificar caduca a los siete
   días. Avisarlo antes vale más que descubrirlo el lunes por un correo
   que nunca salió. */
const DIAS_PERMISO = 7;

function pintarProgramar() {
  const nota = $('programar-nota');
  const boton = $('c-programar');
  const autorizar = $('c-autorizar');
  const p = estado.programado || {};
  const c = estado.campanaActual || {};
  if (!leerCuando()) ponerCuando(proximoHabil());

  /* Autorizado y "sabemos con qué cuenta" son cosas distintas. Atarlas
     costó caro una vez: el permiso quedaba bien guardado, la dirección
     no llegaba, y la pantalla insistía en que faltaba autorizar mientras
     el botón seguía muerto. */
  const autorizado = Boolean(p.autorizacion);
  const cuenta = p.autorizacion?.correo || '';
  const quien = cuenta || 'la cuenta autorizada';

  /* Una campaña que ya está programada no puede tener al lado un botón
     que la mande ahora: los correos ya están redactados y esperando, y
     pulsarlo un sábado los suelta un sábado. Para enviar ya, primero se
     cancela la programación, que es una decisión consciente. */
  const enviarYa = $('c-enviar');
  const ahora = $('c-cuando-ahora');
  const luego = $('c-cuando-luego');
  const programada = c.estado === 'programada';
  const dias = p.autorizacion?.desde
    ? Math.floor((Date.now() - p.autorizacion.desde) / 864e5) : null;

  autorizar.classList.toggle('oculto', !p.disponible);
  autorizar.textContent = autorizado ? 'Volver a autorizar' : 'Autorizar envío automático';

  /* Por qué no se puede programar, dicho una sola vez. Antes cada motivo
     era una salida temprana distinta y el orden de las comprobaciones
     decidía el mensaje; así se lee de arriba abajo. */
  let impedimento = '';
  if (!estado.funcion) {
    impedimento = 'Necesita la función desplegada: firebase deploy --only functions';
  } else if (!p.disponible) {
    impedimento = 'Falta configurar las credenciales del envío programado en el '
      + 'servidor. Está explicado en docs/campana.md, sección "Programar el envío".';
  } else if (!autorizado) {
    impedimento = 'Falta autorizar una vez para que el correo pueda salir con el '
      + 'navegador cerrado. Es el mismo permiso de Gmail, pero guardado en el servidor.';
  } else if (!cuenta) {
    impedimento = 'La autorización guardada es de una versión anterior y no registró '
      + 'la cuenta de envío. Pulsa "Volver a autorizar" una vez.';
  }

  // Una campaña ya programada no admite elección: ya está decidida.
  if (programada) luego.checked = true;
  ahora.disabled = programada;
  luego.disabled = Boolean(impedimento) && !programada;
  $('opcion-luego').classList.toggle('apagada', luego.disabled);
  if (luego.disabled && luego.checked) ahora.checked = true;

  const difiere = luego.checked;
  $('bloque-cuando').classList.toggle('oculto', !difiere || programada);
  enviarYa.classList.toggle('oculto', difiere);
  boton.classList.toggle('oculto', !difiere);
  enviarYa.disabled = programada;
  boton.dataset.modo = programada ? 'cancelar' : 'programar';
  boton.textContent = programada ? 'Cancelar programación' : 'Programar';
  boton.disabled = !programada && Boolean(impedimento);

  nota.className = 'sub';
  if (programada) {
    nota.textContent = `Sale ${cuandoSale(c.programadaPara)} desde `
      + `${c.remitenteProgramado || quien}. Para cambiar el texto hay que `
      + 'cancelar primero: lo que va a salir ya está redactado.';
    return;
  }
  if (!difiere) {
    // Enviar ahora también tiene su hora, y conviene decirla antes del
    // clic y no dentro de la ventana de confirmación.
    const hoy = avisoMomento();
    nota.textContent = hoy || (impedimento ? `Programar: ${impedimento}` : '');
    if (hoy) nota.className = 'sub malo';
    return;
  }
  if (impedimento) {
    nota.className = 'sub malo';
    nota.textContent = impedimento;
    return;
  }

  /* El aviso se evalúa sobre la hora elegida y no sobre ahora: al
     programar, lo único que importa es cómo se va a leer el correo
     cuando llegue. */
  const momento = avisoMomento(leerCuando());
  const avisos = [momento, `Saldrá desde ${quien}.`].filter(Boolean);
  if (momento) nota.className = 'sub malo';
  /* El remitente del correo programado es la cuenta autorizada, no la
     conectada ahora: si no coinciden, el que firma no es el que se ve
     arriba en la pantalla y conviene decirlo antes y no después. */
  if (cuenta && mail.gmailCorreo() && cuenta !== mail.gmailCorreo()) {
    avisos.push(`Ojo: ahora estás conectado como ${mail.gmailCorreo()}, `
      + 'pero el envío programado usa la cuenta autorizada.');
  }
  if (dias !== null && dias >= DIAS_PERMISO - 1) {
    avisos.push('El permiso está por caducar (Google los caduca a los siete días '
      + 'mientras la aplicación no esté verificada): vuelve a autorizar.');
  }
  nota.textContent = avisos.join(' ');
}

/* Lo que dice cada sección plegada sin abrirla. Una tarjeta cerrada que
   no cuenta cómo está obliga a abrirla para comprobarlo, y entonces
   plegarla no sirvió de nada. */
function pintarResumenes() {
  const c = estado.campanaActual || {};
  const plantilla = mail.PLANTILLAS[c.plantilla || 'lamina']?.nombre || '—';
  $('resumen-disenio').textContent = `${plantilla} · ${c.tema === 'oscuro' ? 'oscuro' : 'claro'}`;

  const wa = $('c-whatsapp').value.trim();
  const slots = ($('c-horarios').value || '').split('|').filter(Boolean).length;
  $('resumen-contacto').textContent = [
    wa ? 'WhatsApp' : 'sin WhatsApp',
    slots ? `${slots} horario${slots === 1 ? '' : 's'}` : 'sin horarios',
  ].join(' · ');

  $('resumen-seguimiento').textContent = [
    $('c-track-aperturas').checked ? 'aperturas' : 'sin aperturas',
    $('c-evidencia').checked ? 'evidencia' : 'sin evidencia',
  ].join(' · ');

  $('resumen-ab').textContent = $('c-cuerpo-b').value.trim()
    ? 'con variante B' : 'sin variante';
}

async function autorizarProgramado() {
  const b = $('c-autorizar');
  b.disabled = true;
  try {
    const r = await mail.autorizarProgramado(auth, estado.programado.clientId,
      { leer: mail.puedeLeer() });
    estado.programado.autorizacion = { correo: r.correo || '', desde: Date.now() };
    /* La sesión del navegador tiene que salir del permiso recién
       guardado. Sin esto se queda con la anterior —o sin ninguna— y el
       envío manual termina diciendo "se enviarán 7 correos desde ." */
    await mail.conectarPorServidor(auth)
      .then((s) => pintarEstadoGmail(s.correo, s.leer))
      .catch(() => { /* el botón de conectar sigue estando */ });
    avisar(`Envío automático autorizado${r.correo ? ` para ${r.correo}` : ''}.`);
    pintarProgramar();
  } catch (e) { mostrarError(e); } finally { b.disabled = false; }
}

async function programar() {
  const c = estado.campanaActual;
  const cuenta = estado.programado?.autorizacion?.correo || '';
  if (!estado.programado?.autorizacion) {
    mostrarError({ message: 'Primero autoriza el envío automático.' });
    return;
  }
  /* Una autorización anterior a que se pidiera el permiso de identidad
     quedó sin dirección, y el remitente no se puede adivinar: el correo
     tiene que salir firmado por la misma cuenta que lo despacha. */
  if (!cuenta) {
    mostrarError({ message: 'La autorización guardada no registró con qué cuenta '
      + 'enviar. Pulsa "Volver a autorizar" una vez y vuelve a intentarlo.' });
    return;
  }
  const cuando = leerCuando();
  if (!cuando) { mostrarError({ message: 'Elige el día y la hora.' }); return; }
  if (cuando.getTime() < Date.now() + 60000) {
    mostrarError({ message: 'Esa hora ya pasó. Elige un momento futuro.' });
    return;
  }
  if (!estado.destinatarios.length) {
    mostrarError({ message: 'El segmento no tiene destinatarios con correo.' });
    return;
  }

  await pintarTanda();
  const pedidos = Number($('c-tanda').value) || mail.LIMITE_DIARIO;
  const tanda = estado.destinatarios.slice(0, Math.min(pedidos, mail.LIMITE_DIARIO));
  const restantes = estado.destinatarios.length - tanda.length;

  const momento = avisoMomento(cuando);
  if (!confirm(`Se programarán ${tanda.length} correos para el `
    + `${cuandoSale(cuando)}, desde ${cuenta}.\n`
    + (restantes ? `Quedan ${restantes} para tandas posteriores.\n` : '')
    + (momento ? `\n⚠ ${momento}\n` : '')
    + '\nSaldrán solos, aunque tengas el navegador cerrado. ¿Continuar?')) return;

  Object.assign(c, {
    nombre: $('c-nombre').value.trim() || 'Sin nombre',
    cuerpo: $('c-cuerpo').value,
    cuerpoB: $('c-cuerpo-b').value.trim(),
    evidencia: $('c-evidencia').checked,
    track: $('c-track-aperturas').checked,
  });

  $('c-programar').disabled = true;
  try {
    const prospectos = new Map(estado.destinatarios.map((p) => [String(p.rbd), p]));
    const r = await mail.programarCampana(db, c, tanda,
      ctxCorreo({ prospectos, remitente: cuenta, remitenteProgramado: cuenta }),
      auth.currentUser.uid, cuando,
      ({ i, total }) => progreso(`Redactando ${i}/${total}…`));
    c.id = r.id;
    c.estado = 'programada';
    c.programadaPara = cuando;
    c.remitenteProgramado = cuenta;
    progreso(`${r.listos} correos listos y programados.`);
    avisar(`Programado: ${r.listos} correos saldrán el ${cuandoSale(cuando)}.`);
    pintarProgramar();
    await pintarCampanas();
  } catch (e) {
    mostrarError(e);
  } finally { $('c-programar').disabled = false; }
}

async function cancelarProgramacion() {
  const c = estado.campanaActual;
  if (!confirm('La campaña vuelve a borrador y no saldrá sola. ¿Cancelar la programación?')) return;
  try {
    await mail.cancelarProgramacion(db, c.id);
    c.estado = 'borrador';
    delete c.programadaPara;
    avisar('Programación cancelada. La campaña queda como borrador.');
    pintarProgramar();
    await pintarCampanas();
  } catch (e) { mostrarError(e); }
}

$('c-autorizar').addEventListener('click', autorizarProgramado);

/* Dos atajos y no uno: el lunes a las 8 es el que la gente pide, pero
   compite con todo el correo del fin de semana; el martes a la misma
   hora llega a una bandeja vacía. Están los dos a la vista y el aviso
   dice cuál es cuál, en vez de esconder la opción peor. */
function atajoDia(diaSemana) {
  const d = new Date();
  d.setDate(d.getDate() + ((diaSemana + 7 - d.getDay()) % 7 || 7));
  d.setHours(8, 0, 0, 0);
  ponerCuando(d);
  pintarProgramar();
}
$('c-lunes').addEventListener('click', () => atajoDia(1));
$('c-martes').addEventListener('click', () => atajoDia(2));
for (const id of ['c-fecha', 'c-hora', 'c-cuando-ahora', 'c-cuando-luego']) {
  $(id).addEventListener('change', pintarProgramar);
}
$('c-programar').addEventListener('click', () => (
  $('c-programar').dataset.modo === 'cancelar' ? cancelarProgramacion() : programar()));

function pintarEstadoGmail(correo, conLectura) {
  const caja = $('gmail-estado');
  if (!correo) return;
  caja.classList.add('ok');
  /* Un @gmail.com funciona, pero llega peor y se lee peor: el director
     de un colegio decide en dos segundos si el remitente es una
     institución o alguien escribiendo desde su cuenta personal. */
  const personal = /@gmail\.com$/i.test(correo);
  const guardado = Boolean(estado.programado?.autorizacion);
  caja.innerHTML = `<div><strong>Gmail conectado:</strong> ${esc(correo)}.
    Los correos saldrán desde esta cuenta.`
    + (guardado
      ? ' La conexión se renueva sola: no hay que volver a pasar por Google '
        + 'cada hora ni al abrir la app.'
      : ' La sesión dura una hora.')
    + (conLectura
      ? ' Se detectarán respuestas y rebotes automáticamente.'
      : ' <em>Sin permiso de lectura: las respuestas habrá que revisarlas '
        + 'a mano en la bandeja.</em>')
    + (personal
      ? '<br><em>Estás enviando desde una cuenta personal. Un remitente '
        + '@jumpmath.cl (Google Workspace) entra mejor a bandeja de entrada '
        + 'y da más confianza a quien recibe.</em>'
      : '')
    + '</div>';
  $('d-revisar').disabled = !conLectura;
}

$('c-ver-grande').addEventListener('click', () => {
  const ejemplo = estado.destinatarios[0];
  if (!ejemplo) { mostrarError({ message: 'El segmento no tiene destinatarios.' }); return; }
  const ctx = ctxCorreo();
  const html = mail.correoHtml({
    texto: mail.aplicarVariables($('c-cuerpo').value, ejemplo, ctx),
    prospecto: ejemplo, ctx, base: location.origin, track: false,
    breve: Boolean(estado.campanaActual?.seguimientoDe),
  });
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});

for (const id of ['c-track-aperturas', 'c-evidencia']) {
  $(id).addEventListener('change', pintarResumenes);
}
$('c-cuerpo-b').addEventListener('input', pintarResumenes);

for (const [id, fn] of [
  ['c-cuerpo', previsualizar],
  ['c-whatsapp', () => { guardarContacto(); previsualizar(); }],
  ['c-sitio', () => { guardarContacto(); previsualizar(); }],
]) $(id).addEventListener('input', fn);

$('c-evidencia').addEventListener('change', previsualizar);
$('c-tanda').addEventListener('input', (e) => { e.target.dataset.tocado = '1'; });

$('filtros-detalle').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-filtro]');
  if (!b) return;
  estado.filtroDetalle = b.dataset.filtro;
  pintarDestinatarios();
});

/* La lista de calientes vale sobre todo fuera de la app: se pega en el
   teléfono y se llama. */
$('d-copiar').addEventListener('click', async () => {
  const filtro = FILTROS_DETALLE[estado.filtroDetalle] || FILTROS_DETALLE.todos;
  const correos = estado.destinatarios.filter(filtro).map((d) => d.email).filter(Boolean);
  try {
    await navigator.clipboard.writeText(correos.join(', '));
    $('d-copiar').textContent = `${correos.length} copiados`;
    setTimeout(() => { $('d-copiar').textContent = 'Copiar correos de la lista'; }, 1800);
  } catch {
    mostrarError({ message: 'El navegador no dejó copiar al portapapeles.' });
  }
});

$('d-seguimiento').addEventListener('click', crearSeguimiento);

$('ag-dias').addEventListener('click', (e) => {
  const b = e.target.closest('.ag-dia');
  if (!b) return;
  const f = b.dataset.fecha;
  if (agenda.dias.has(f)) agenda.dias.delete(f); else agenda.dias.add(f);
  recalcularAgenda();
});

$('ag-horas').addEventListener('click', (e) => {
  const b = e.target.closest('.ag-hora');
  if (!b) return;
  const h = b.dataset.hora;
  if (agenda.horas.has(h)) agenda.horas.delete(h); else agenda.horas.add(h);
  recalcularAgenda();
});

$('ag-elegidos').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-quitar]');
  if (!b) return;
  const lista = slotsElegidos();
  const [quitado] = lista.splice(Number(b.dataset.quitar), 1);
  // Sin esto, el cruce lo volvería a poner en el siguiente clic.
  if (quitado) {
    agenda.excluidos.add(quitado);
    agenda.sueltos = agenda.sueltos.filter((t) => t !== quitado);
  }
  ponerSlots(lista);
});

$('ag-antes').addEventListener('click', () => {
  agenda.pagina = Math.max(0, agenda.pagina - 1);
  pintarAgenda();
});
$('ag-despues').addEventListener('click', () => {
  agenda.pagina += 1;
  pintarAgenda();
});

$('c-recalcular').addEventListener('click', () => {
  const { lista, podas } = segmentoActual();
  estado.destinatarios = lista;
  estado.podas = podas;
  estado.campanaActual.segmento = { desc: descripcionSegmento() };
  $('segmento-desc').textContent = estado.campanaActual.segmento.desc;
  resumenSegmento(); previsualizar();
});

$('c-guardar').addEventListener('click', async () => {
  const c = estado.campanaActual;
  Object.assign(c, {
    nombre: $('c-nombre').value.trim() || 'Sin nombre',
    cuerpo: $('c-cuerpo').value,
    cuerpoB: $('c-cuerpo-b').value.trim(),
    evidencia: $('c-evidencia').checked,
    track: $('c-track-aperturas').checked,
  });
  try {
    c.id = await mail.guardarCampana(db, c, estado.destinatarios, auth.currentUser.uid);
    progreso('Borrador guardado.');
    avisar('Borrador guardado.');
    await pintarCampanas();
    comprobarSeguimiento();
  } catch (e) { mostrarError(e); }
});

/* Antes de escribirle a un colegio real conviene ver el correo como le
   va a llegar: en su cliente, con las variables resueltas y el remitente
   puesto. La vista previa del editor no muestra cómo lo trata Gmail. */
$('c-prueba').addEventListener('click', async () => {
  if (!mail.gmailConectado()) { mostrarError({ message: 'Conecta Gmail primero.' }); return; }
  const ejemplo = estado.destinatarios[0];
  if (!ejemplo) { mostrarError({ message: 'El segmento no tiene destinatarios.' }); return; }

  $('c-prueba').disabled = true;
  try {
    await mail.enviarPrueba(
      { cuerpo: $('c-cuerpo').value },
      ejemplo, ctxCorreo());
    progreso(`Prueba enviada a ${mail.gmailCorreo()} con los datos de `
      + `${ejemplo.establecimiento}. Revísala antes de enviar la campaña.`);
    limpiarError();
  } catch (e) { mostrarError(e); } finally { $('c-prueba').disabled = false; }
});

$('c-enviar').addEventListener('click', enviar);
$('c-volver').addEventListener('click', () => { irA('campanas'); pintarCampanas(); });
$('d-volver').addEventListener('click', () => { irA('campanas'); pintarCampanas(); });

$('d-revisar').addEventListener('click', async () => {
  if (!mail.gmailConectado()) { mostrarError({ message: 'Conecta Gmail para revisar respuestas.' }); return; }
  if (!mail.puedeLeer()) {
    mostrarError({ message: 'La conexión actual sólo permite enviar. Vuelve a '
      + 'conectar con "Conectar Gmail" para detectar respuestas.' });
    return;
  }
  $('d-revisar').disabled = true;
  try {
    const r = await mail.revisarRespuestas(db, estado.campanaActual.id,
      null, auth.currentUser?.uid);
    // Las bajas y los rebotes detectados tienen que salir del segmento en
    // el acto, no en la próxima sesión.
    if (r.bajas || r.rebotes) estado.bajas = await mail.cargarBajas(db).catch(() => estado.bajas);
    await abrirDetalle(estado.campanaActual.id);
    contarHoy();
    if (!r.revisados) mostrarError({ message: 'No hay envíos que revisar todavía.' });
    else if (r.respuestas) {
      avisar(`${r.respuestas} respondieron. Están esperando en “Hoy”.`);
    } else {
      avisar('Sin respuestas nuevas por ahora.');
    }
  } catch (e) { mostrarError(e); } finally { $('d-revisar').disabled = false; }
});

$('d-reanudar').addEventListener('click', async () => {
  const pendientes = await mail.listarDestinatarios(db, estado.campanaActual.id, true);
  estado.destinatarios = pendientes;
  abrirEditor();
});

// Insertar variables en el punto donde está el cursor
$('lista-variables').innerHTML = Object.keys(mail.VARIABLES)
  .map((v) => `<button data-var="${v}">${v}</button>`).join('');
$('lista-variables').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-var]');
  if (!b) return;
  const t = $('c-cuerpo');
  const i = t.selectionStart ?? t.value.length;
  t.value = t.value.slice(0, i) + b.dataset.var + t.value.slice(t.selectionEnd ?? i);
  t.focus();
  t.selectionStart = t.selectionEnd = i + b.dataset.var.length;
  previsualizar();
});

// ---------- sesión ----------
$('entrar').addEventListener('click', async () => {
  const b = $('entrar');
  const aviso = $('acceso-error');
  b.disabled = true;
  b.textContent = 'Abriendo ventana de Google…';
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
    return;                       // onAuthStateChanged toma el control
  } catch (e) {
    if (e.code === 'auth/popup-blocked') {
      // El navegador no dejó abrir la ventana: se sigue en esta misma
      // pestaña, y getRedirectResult completa el acceso al volver.
      await signInWithRedirect(auth, new GoogleAuthProvider());
      return;
    }
    aviso.textContent = {
      'auth/operation-not-allowed':
        'Falta habilitar el proveedor Google: Firebase Console → Authentication → Sign-in method → Google.',
      'auth/unauthorized-domain':
        'Este dominio no está autorizado en Authentication → Settings → Authorized domains.',
      'auth/popup-closed-by-user':
        'La ventana se cerró antes de completar el acceso. Intenta de nuevo.',
      'auth/cancelled-popup-request':
        'Había otra ventana de acceso abierta. Intenta de nuevo.',
    }[e.code] || `${e.code || ''} ${e.message || e}`.trim();
    aviso.classList.remove('oculto');
  } finally {
    b.disabled = false;
    b.textContent = 'Entrar con Google';
  }
});

// Completa el acceso cuando el flujo fue por redirección.
getRedirectResult(auth).catch((e) => {
  const aviso = $('acceso-error');
  aviso.textContent = e.message || String(e);
  aviso.classList.remove('oculto');
});
$('salir').addEventListener('click', () => signOut(auth));

// ---------- ficha y bandeja de trabajo ----------
$('ficha-cerrar').addEventListener('click', cerrarFicha);
$('velo').addEventListener('click', cerrarFicha);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('ficha').classList.contains('oculto')) cerrarFicha();
});
$('ficha-guardar').addEventListener('click', guardarFicha);

$('ficha-tipos').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tipo]');
  if (!b) return;
  for (const x of $('ficha-tipos').querySelectorAll('button')) {
    x.setAttribute('aria-pressed', String(x === b));
  }
  $('ficha-texto').focus();
});

async function registrarActividad() {
  const p = estado.ficha;
  const texto = $('ficha-texto').value.trim();
  if (!p || !texto) { $('ficha-texto').focus(); return; }
  const tipo = $('ficha-tipos').querySelector('[aria-pressed="true"]')?.dataset.tipo || 'nota';
  $('ficha-registrar').disabled = true;
  try {
    await anotar(p.id, tipo, texto);
    $('ficha-texto').value = '';
    await cargarHistorial(p.id);
    avisar('Registrado en el historial.');
  } catch (e) { mostrarError(e); } finally { $('ficha-registrar').disabled = false; }
}
$('ficha-registrar').addEventListener('click', registrarActividad);
$('ficha-texto').addEventListener('keydown', (e) => { if (e.key === 'Enter') registrarActividad(); });

/* Desde la ficha se puede escribir a ese colegio sin volver al listado:
   el camino corto entre "acabo de hablar con ellos" y "les mando la
   propuesta" es lo que hace que el CRM se use. */
/* WhatsApp abre la aplicación, no la web. El enlace wa.me es correcto y
   se deja en el href para que copiarlo siga funcionando, pero al hacer
   clic se intenta primero el esquema que despierta la aplicación
   instalada; si no aparece, se sigue a la web. */
$('ficha-contacto').addEventListener('click', (e) => {
  const wa = e.target.closest('a[data-wa]');
  if (wa) {
    e.preventDefault();
    abrirWhatsApp(wa.dataset.wa, `Hola, le escribo de JUMP Math Chile por ${
      mail.titulo(estado.ficha?.establecimiento || 'su colegio')}.`, wa.href);
    return;
  }
  if (!e.target.closest('#ficha-escribir')) return;
  const p = estado.ficha;
  if (!p) return;
  cerrarFicha();
  estado.seleccion.clear();
  estado.seleccion.set(`${estado.vista}:${p.id}`, { ...p, rbd: p.rbd ?? Number(p.id) });
  pintarSeleccion();
  abrirEditorDesdeSegmento();
});

$('pilas-hoy').addEventListener('click', (e) => {
  const f = e.target.closest('button[data-ficha]');
  if (f) { abrirFicha(f.dataset.ficha); return; }
  const c = e.target.closest('button[data-campana]');
  if (c) abrirDetalle(c.dataset.campana);
});

/* Las escuchas de la ayuda son delegadas en el documento: los "?" de las
   tablas se recrean en cada repintado, así que engancharlos uno a uno los
   dejaría muertos a la primera. */
iniciarAyuda();
// Los filtros de varios valores se montan sobre los <select> del documento
// antes de restaurar lo que había guardado.
montarMulti();

onAuthStateChanged(auth, async (u) => {
  $('acceso').classList.toggle('oculto', Boolean(u));
  $('app').classList.toggle('oculto', !u);
  if (!u) return;
  $('avatar').src = u.photoURL || '';
  $('correo').textContent = u.email || '';
  try {
    await cargarFijos();
    pintarKpis();
    $('n-cuentas').textContent = numero(estado.cuentas.length);
    $('n-redes').textContent = numero(estado.redes.length);
    restaurarFiltros();
    irA('oportunidades');
    await cargarProspectos();
    poblarFiltros();
    await pintarCampanas();
    await comprobarSeguimiento();
    conectarSolo();
    contarHoy();
  } catch (e) {
    $('cargando').classList.add('oculto');
    mostrarError(e);
  }
});
