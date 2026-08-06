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
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

import * as mail from './mailing.js';

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

const ESTADOS = ['nuevo', 'contactado', 'reunion', 'propuesta', 'ganado', 'descartado'];
const ETIQUETA_ESTADO = {
  nuevo: 'Nuevo', contactado: 'Contactado', reunion: 'Reunión agendada',
  propuesta: 'Propuesta enviada', ganado: 'Ganado', descartado: 'Descartado',
  sin_web: 'Sin web', web_sin_mail: 'Web sin correo', contacto_ok: 'Contacto OK',
};

const LISTADOS = ['oportunidades', 'prospectos', 'cuentas', 'redes'];
const PAGINADAS = ['oportunidades', 'prospectos'];

const TITULOS = {
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
  // id -> fila. Se guarda el dato completo, no sólo el id, para que la
  // selección sobreviva al cambio de filtros y a la paginación: si sólo
  // se guardara el id, al filtrar se perdería lo elegido antes.
  seleccion: new Map(),
};

const CAMPOS_FILTRO = ['buscar', 'f-tier', 'f-canal', 'f-region', 'f-ate',
  'f-estado', 'f-correo', 'f-orden', 'f-umbral'];
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

// ---------- carga de listados ----------
async function cargarFijos() {
  const [cuentas, redes, meta] = await Promise.all([
    getDocs(query(collection(db, 'cuentas'), orderBy('prioridad'))),
    getDocs(query(collection(db, 'redes'), orderBy('matBasica', 'desc'), limit(400))),
    getDoc(doc(db, 'meta', 'carga')).catch(() => null),
  ]);
  estado.cuentas = cuentas.docs.map((d) => ({ id: d.id, ...d.data() }));
  estado.redes = redes.docs.map((d) => ({ id: d.id, ...d.data() }));
  estado.meta = meta?.exists() ? meta.data() : null;
}

/* Firestore no combina filtros arbitrarios sin un índice por combinación.
   En vez de declarar esa explosión, se manda al servidor el filtro más
   selectivo y el resto se afina en el cliente sobre la página traída. El
   contador siempre dice cuántos registros se revisaron. */
function consultaProspectos(desde) {
  const partes = [collection(db, 'prospectos')];

  if (estado.vista === 'oportunidades') {
    // Una desigualdad obliga a ordenar primero por ese mismo campo, así
    // que el ranking por oportunidad se arma en el cliente.
    partes.push(where('dolorMate', '>=', Number($('f-umbral').value) || 60));
    if ($('f-tier').value) partes.push(where('tierNum', '==', Number($('f-tier').value)));
    else if ($('f-canal').value) partes.push(where('canal', '==', $('f-canal').value));
    else if ($('f-region').value) partes.push(where('region', '==', $('f-region').value));
    partes.push(orderBy('dolorMate', 'desc'));
  } else {
    const texto = normalizar($('buscar').value).trim();
    const palabra = texto.split(/\s+/).filter((p) => p.length >= 3)[0];
    if (palabra) partes.push(where('tokens', 'array-contains', palabra));
    else if ($('f-tier').value) partes.push(where('tierNum', '==', Number($('f-tier').value)));
    else if ($('f-canal').value) partes.push(where('canal', '==', $('f-canal').value));
    else if ($('f-region').value) partes.push(where('region', '==', $('f-region').value));
    else if ($('f-estado').value) partes.push(where('estadoCrm', '==', $('f-estado').value));
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
  const [tier, canal, region, ate, est, correo] =
    ['f-tier', 'f-canal', 'f-region', 'f-ate', 'f-estado', 'f-correo'].map((i) => $(i).value);
  return filas.filter((f) => {
    if (tier && String(f.tierNum ?? '') !== tier) return false;
    if (canal && f.canal !== canal) return false;
    if (region && f.region !== region) return false;
    if (ate && f.requiereAte !== (ate === 'si')) return false;
    if (est && (f.estadoCrm || 'nuevo') !== est) return false;
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
const COLUMNAS = {
  oportunidades: ['Oport.', 'Establecimiento', 'Por qué', 'Matemática', 'Tier', 'Matrícula', 'Contacto', 'Estado'],
  prospectos: ['Tier', 'Establecimiento', 'Canal', 'ATE', 'Matemática', 'Matrícula', 'Red', 'Contacto', 'Estado'],
  cuentas: ['Prio.', 'Cuenta', 'Canal', 'ATE', 'Colegios', 'Matrícula', 'Contacto', 'Confianza', 'Estado'],
  redes: ['Sostenedor', 'Comuna principal', 'ATE', 'Colegios', 'Matrícula', 'Regiones', 'Estado'],
};
const NUMERICAS = {
  oportunidades: [0, 5], prospectos: [5, 6], cuentas: [4, 5], redes: [3, 4, 5],
};

const partes = (s) => String(s || '').split(';').map((x) => x.trim()).filter(Boolean);

const FILA = {
  oportunidades: (p) => `
    <td class="num"><span class="oport">${p._oport ?? '—'}</span></td>
    <td><div class="nombre">${esc(p.establecimiento)}</div>
      <div class="sub">RBD ${esc(p.rbd)} · ${esc(p.comuna)}, ${esc(p.region)} · ${esc(p.canal)}</div></td>
    <td class="porque">${esc(porQue(p)) || '—'}</td>
    <td>${celdaMate(p)}</td>
    <td>${distintivoTier(p.tierNum)}<div class="sub">${distintivoAte(p.requiereAte)}</div></td>
    <td class="num">${numero(p.matBasica)}</td>
    <td class="contacto">${celdaContacto(partes(p.email), partes(p.telefono))}</td>
    <td>${selectorEstado('prospectos', p.id, p.estadoCrm)}</td>`,

  prospectos: (p) => `
    <td>${distintivoTier(p.tierNum)}</td>
    <td><div class="nombre">${esc(p.establecimiento)}</div>
      <div class="sub">RBD ${esc(p.rbd)} · ${esc(p.comuna)}, ${esc(p.region)} · ${esc(p.dependencia)}</div></td>
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
      + `${todasMarcadas ? ' checked' : ''} title="Seleccionar todo lo visible"></th>` : '')
    + COLUMNAS[v].map((c, i) => `<th${NUMERICAS[v].includes(i) ? ' class="num"' : ''}>${esc(c)}</th>`).join('')
    + (seleccionable ? '<th></th>' : '');

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
  $('mas').classList.toggle('oculto', !(PAGINADAS.includes(v) && estado.hayMas));
  $('f-umbral').classList.toggle('oculto', v !== 'oportunidades');
  $('f-orden').classList.toggle('oculto', v === 'oportunidades');

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
  for (const id of CAMPOS_FILTRO) v[id] = $(id).value;
  try { localStorage.setItem('jm.filtros', JSON.stringify(v)); } catch { /* modo privado */ }
}

function restaurarFiltros() {
  try {
    const v = JSON.parse(localStorage.getItem('jm.filtros') || '{}');
    for (const id of CAMPOS_FILTRO) {
      if (v[id] != null && $(id).querySelector?.(`option[value="${CSS.escape(v[id])}"]`) !== null) {
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
    const el = $(id);
    if (!el.value) continue;
    const texto = el.tagName === 'SELECT'
      ? el.options[el.selectedIndex].text : el.value;
    // No repetir la etiqueta si la opción ya la dice: "ATE: Sin requisito ATE"
    const etiqueta = ETIQUETA_FILTRO[id];
    const redundante = normalizar(texto).includes(normalizar(etiqueta));
    activos.push({ id, texto: redundante ? texto : `${etiqueta}: ${texto}` });
  }
  $('chips').innerHTML = activos.map((a) => `<span class="chip">${esc(a.texto)}`
    + `<button data-limpiar="${a.id}" title="Quitar">×</button></span>`).join('');
  $('limpiar-filtros').classList.toggle('oculto', activos.length === 0);

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
  }
}

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
    const ESTADOS_PANEL = ['nuevo', 'contacto_ok', 'contactado', 'reunion',
      'propuesta', 'ganado', 'descartado'];

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
  $('vista-panel').classList.toggle('oculto', vista !== 'panel');
  $('vista-campanas').classList.toggle('oculto', vista !== 'campanas');
  $('vista-editor').classList.add('oculto');
  $('vista-detalle').classList.add('oculto');
  actualizarAcciones();
}

function actualizarAcciones() {
  const v = estado.vista;
  const caja = $('acciones-vista');
  if (LISTADOS.includes(v)) {
    const n = estado.seleccion.size || filtrar(estado[v]).length;
    const que = estado.seleccion.size ? 'selección' : 'CSV';
    caja.innerHTML = `<button id="exportar">Exportar ${que} (${numero(n)})</button>`
      + (PAGINADAS.includes(v)
        ? ' <button class="primario" id="crear-campana">Crear campaña con este segmento</button>'
        : '');
    $('exportar').onclick = exportarCsv;
    if (PAGINADAS.includes(v)) $('crear-campana').onclick = abrirEditorDesdeSegmento;
  } else if (v === 'campanas') {
    caja.innerHTML = '<button class="primario" id="nueva-campana">Nueva campaña</button>';
    $('nueva-campana').onclick = () => {
      estado.vista = 'prospectos';
      irA('oportunidades');
      mostrarError({ message: 'Elige el segmento con los filtros y pulsa "Crear campaña con este segmento".' });
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
  if ($('f-tier').value) p.push(`Tier ${$('f-tier').value}`);
  if ($('f-canal').value) p.push($('f-canal').value);
  if ($('f-region').value) p.push($('f-region').value);
  if ($('f-ate').value) p.push($('f-ate').value === 'no' ? 'sin ATE' : 'requiere ATE');
  if ($('f-estado').value) p.push(ETIQUETA_ESTADO[$('f-estado').value] || $('f-estado').value);
  if (estado.vista === 'oportunidades') p.push(`dolor ${$('f-umbral').value}+`);
  return p.length ? p.join(' · ') : 'Todos los prospectos cargados';
}

/* La selección manual gana sobre el filtro: si alguien marcó colegios
   uno por uno, eso es lo que quiere enviar, no lo que quedó en pantalla. */
function segmentoActual() {
  const base = estado.seleccion.size
    ? [...estado.seleccion.values()]
    : filtrar(estado[estado.vista]);
  return base
    .filter((p) => mail.primerCorreo(p.email))
    .map((p) => ({ ...p, rbd: p.rbd ?? Number(p.id) }));
}

function abrirEditorDesdeSegmento() {
  const dest = segmentoActual();
  estado.campanaActual = {
    id: null, nombre: '', asunto: '', cuerpo: PLANTILLA,
    segmento: { desc: descripcionSegmento() }, track: false,
  };
  estado.destinatarios = dest;
  abrirEditor();
}

/* El diseño ya trae el saludo, el dato SIMCE, la propuesta de reunión y
   la firma: este texto alimenta sólo la sección "¿Qué es JUMP Math?". */
const PLANTILLA = `Es un método de enseñanza de la matemática con evidencia de impacto en estudios controlados. Entrega a los docentes una secuencia de clases estructurada que descompone cada objetivo en pasos que todo el curso puede seguir.`;

function abrirEditor() {
  const c = estado.campanaActual;
  $('c-nombre').value = c.nombre || '';
  $('c-asunto').value = c.asunto || '';
  $('c-cuerpo').value = c.cuerpo || '';
  $('c-track-aperturas').checked = Boolean(c.track);
  restaurarContacto();
  $('segmento-desc').textContent = c.segmento?.desc || '—';
  resumenSegmento();
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
  $('segmento-resumen').innerHTML = `
    <span><b>${numero(d.length)}</b> con correo</span>
    <span><b>${numero(alumnos)}</b> alumnos</span>
    <span><b>${numero(conDolor)}</b> con dolor 60+</span>
    <span><b>${numero(d.filter((p) => !p.requiereAte).length)}</b> sin ATE</span>`;
  if (d.length > mail.LIMITE_DIARIO) {
    $('segmento-resumen').innerHTML += `<span class="error-texto">Gmail corta cerca de `
      + `${mail.LIMITE_DIARIO} correos al día: se enviarán por tandas.</span>`;
  }
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
const MAX_HORARIOS = 3;
const POR_PAGINA = 5;
const agenda = { pagina: 0, dia: null };

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

function ponerSlots(lista) {
  // Ordenados por fecha y hora: proponer las 15:00 antes que las 09:00
  // del mismo día se lee como descuido.
  const unicos = [...new Set(lista)].sort((a, b) => orden(a) - orden(b));
  $('c-horarios').value = unicos.slice(0, MAX_HORARIOS).join(', ');
  guardarContacto();
  pintarAgenda();
  previsualizar();
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
  // Al cambiar de página el día elegido puede quedar fuera de vista;
  // mostrar horas de un día que no se ve confunde.
  if (!pagina.some((d) => d.toDateString() === agenda.dia)) {
    agenda.dia = pagina[0]?.toDateString() || null;
  }
  const dia = pagina.find((d) => d.toDateString() === agenda.dia);

  $('ag-mes').textContent = pagina.length
    ? mayus(pagina[0].toLocaleDateString('es-CL', { month: 'long', year: 'numeric' })) : '';
  $('ag-antes').disabled = agenda.pagina === 0;
  $('ag-despues').disabled = (agenda.pagina + 1) * POR_PAGINA >= dias.length;

  $('ag-dias').innerHTML = pagina.map((d) => `
    <button type="button" class="ag-dia" data-fecha="${d.toDateString()}"
            aria-pressed="${d.toDateString() === agenda.dia}">
      ${DIAS_SEM[d.getDay()].slice(0, 3)}<b>${d.getDate()}</b>
    </button>`).join('');

  const elegidos = slotsElegidos();
  $('ag-horas').innerHTML = dia ? HORAS.map((h) => {
    const t = textoSlot(dia, h);
    const puesto = elegidos.includes(t);
    const lleno = elegidos.length >= MAX_HORARIOS;
    return `<button type="button" class="ag-hora" data-hora="${h}"
      ${puesto || lleno ? 'disabled' : ''}
      title="${puesto ? 'Ya está propuesto' : lleno ? 'Máximo 3 bloques' : esc(t)}">${h}</button>`;
  }).join('') : '';

  $('ag-elegidos').innerHTML = (elegidos.length
    ? elegidos.map((t, i) => `<span class="chip">${esc(t)}`
      + `<button data-quitar="${i}" title="Quitar">×</button></span>`).join('')
    : '<span class="ag-vacio">Sin bloques: el correo sólo invitará a responder.</span>')
    + (elegidos.length >= MAX_HORARIOS
      ? '<span class="ag-vacio">Máximo 3 · quita uno para cambiarlo.</span>' : '');
}

function previsualizar() {
  const ejemplo = estado.destinatarios[0];
  const caja = $('previsualizacion');
  if (!ejemplo) { caja.textContent = 'Sin destinatarios en el segmento.'; return; }
  const ctx = ctxCorreo();
  const asunto = mail.aplicarVariables($('c-asunto').value, ejemplo, ctx);
  const texto = mail.aplicarVariables($('c-cuerpo').value, ejemplo, ctx);

  caja.innerHTML = `<span class="asunto">${esc(asunto)}</span>`
    + `<div class="sub">Para: ${esc(mail.primerCorreo(ejemplo.email))} · ${esc(ejemplo.establecimiento)}</div>`;
  // El correo real es un documento completo con sus propios estilos: se
  // muestra en un iframe para que no choque con los de la app.
  const marco = document.createElement('iframe');
  marco.style.cssText = 'width:100%;height:460px;border:0;border-radius:8px;margin-top:8px;background:#eef1f5';
  marco.srcdoc = mail.correoHtml({
    texto, prospecto: ejemplo, ctx, base: location.origin, track: false,
  });
  caja.appendChild(marco);
}

async function pintarCampanas() {
  estado.campanas = await mail.listarCampanas(db);
  $('n-campanas').textContent = numero(estado.campanas.length);
  $('campanas-vacio').classList.toggle('oculto', estado.campanas.length > 0);
  $('cuerpo-campanas').innerHTML = estado.campanas.map((c) => {
    const t = c.totales || {};
    return `<tr>
      <td><div class="nombre">${esc(c.nombre)}</div><div class="sub">${esc(c.asunto)}</div></td>
      <td><span class="env ${c.estado === 'enviada' ? 'enviado' : 'pendiente'}">${esc(c.estado)}</span></td>
      <td class="num">${numero(t.destinatarios)}</td>
      <td class="num">${numero(t.enviados)}</td>
      <td class="num">${numero(t.respuestas)}</td>
      <td class="num">${c.track ? numero(t.aperturas) : '—'}</td>
      <td>${fecha(c.creado)}</td>
      <td><button data-abrir="${esc(c.id)}">Ver</button></td></tr>`;
  }).join('');
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
  const t = estado.campanaActual?.totales || {};
  const pendientes = dest.filter((d) => d.estado === 'pendiente').length;
  $('d-reanudar').classList.toggle('oculto', pendientes === 0);

  $('kpis-campana').innerHTML = [
    { e: 'Destinatarios', v: numero(dest.length), n: 'con correo' },
    { e: 'Enviados', v: numero(dest.filter((d) => d.estado !== 'pendiente' && d.estado !== 'error').length), n: `${pendientes} pendientes` },
    { e: 'Respuestas', v: numero(dest.filter((d) => d.estado === 'respondido').length), n: 'la métrica que importa' },
    { e: 'Errores y rebotes', v: numero(dest.filter((d) => ['error', 'rebotado'].includes(d.estado)).length), n: 'correo inválido o rechazado' },
    { e: 'Aperturas', v: estado.campanaActual?.track ? numero(t.aperturas) : '—',
      n: estado.campanaActual?.track
        ? `${numero(t.aperturasBot)} descartadas como escáner`
        : 'seguimiento desactivado' },
  ].map((k) => `<div class="kpi"><div class="etiqueta">${esc(k.e)}</div>
      <div class="valor">${esc(k.v)}</div><div class="nota">${esc(k.n)}</div></div>`).join('');

  $('cuerpo-destinatarios').innerHTML = dest.map((d) => `<tr>
    <td><div class="nombre">${esc(d.establecimiento)}</div><div class="sub">RBD ${esc(d.rbd)} · ${esc(d.comuna)}</div></td>
    <td>${d.email ? `<a href="mailto:${esc(d.email)}">${esc(d.email)}</a>` : '<span class="sin-contacto">sin correo</span>'}</td>
    <td><span class="env ${esc(d.estado)}">${esc(d.estado)}</span></td>
    <td>${fecha(d.enviadoEn)}</td>
    <td class="num">${numero(d.aperturas)}</td>
    <td class="sub">${esc(d.error || '')}</td></tr>`).join('');
  $('detalle-cargando').classList.add('oculto');
}

function progreso(txt) {
  const p = $('c-progreso');
  p.classList.remove('oculto');
  p.textContent = txt;
}

async function enviar() {
  const c = estado.campanaActual;
  if (!mail.gmailConectado()) { mostrarError({ message: 'Conecta Gmail antes de enviar.' }); return; }
  if (!$('c-asunto').value.trim()) { mostrarError({ message: 'Falta el asunto.' }); return; }
  if (!estado.destinatarios.length) { mostrarError({ message: 'El segmento no tiene destinatarios con correo.' }); return; }

  const tanda = estado.destinatarios.slice(0, mail.LIMITE_DIARIO);
  if (!confirm(`Se enviarán ${tanda.length} correos desde ${mail.gmailCorreo()}.\n`
    + 'Cada uno es un mensaje real. ¿Continuar?')) return;

  Object.assign(c, {
    nombre: $('c-nombre').value.trim() || 'Sin nombre',
    asunto: $('c-asunto').value, cuerpo: $('c-cuerpo').value,
    track: $('c-track-aperturas').checked,
  });
  c.id = await mail.guardarCampana(db, c, estado.destinatarios, auth.currentUser.uid);

  estado.cancelar = false;
  $('c-enviar').disabled = true;
  const prospectos = new Map(estado.destinatarios.map((p) => [String(p.rbd), p]));
  try {
    const r = await mail.enviarCampana(db, c, tanda,
      ctxCorreo({ prospectos, cancelado: () => estado.cancelar }),
      ({ i, total, d, error }) => progreso(
        `${i}/${total} · ${d.establecimiento || d.rbd}${error ? ` — ERROR: ${error}` : ''}`));
    progreso(`Listo: ${r.enviados} enviados, ${r.errores} con error.`);
    await marcarContactados(tanda);
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
async function marcarContactados(destinatarios) {
  for (const d of destinatarios) {
    try {
      await setDoc(doc(db, 'prospectos', String(d.rbd)),
        { estadoCrm: 'contactado', actualizado: serverTimestamp() }, { merge: true });
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
  }
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
  $(b.dataset.limpiar).value = '';
  guardarFiltros();
  alFiltrar({ inmediato: true });
});

$('limpiar-filtros').addEventListener('click', () => {
  for (const id of CAMPOS_FILTRO) {
    if (id === 'f-orden') continue;
    if (id === 'f-umbral') { $(id).value = '60'; continue; }
    $(id).value = '';
  }
  guardarFiltros();
  alFiltrar({ inmediato: true });
});

// "/" enfoca la búsqueda, como en cualquier herramienta de trabajo diario
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    e.preventDefault();
    $('buscar').focus();
  }
  if (e.key === 'Escape' && estado.seleccion.size) { estado.seleccion.clear(); pintar(); }
});

$('buscar').addEventListener('input', () => { guardarFiltros(); alFiltrar(); });
for (const id of ['f-tier', 'f-canal', 'f-region', 'f-ate', 'f-estado', 'f-correo', 'f-orden', 'f-umbral']) {
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
    const r = await mail.conectarGmail(auth, { leer });
    pintarEstadoGmail(r.correo, r.leer);
    limpiarError();
  } catch (e) { mostrarError(e); }
}
$('conectar-gmail').addEventListener('click', () => conectar(true));
$('conectar-solo-envio').addEventListener('click', () => conectar(false));

/* La casilla de aperturas sólo sirve si la función está desplegada.
   Preguntar por ella evita una opción que promete algo que no ocurre. */
async function comprobarSeguimiento() {
  const nota = $('track-aviso');
  const casilla = $('c-track-aperturas');
  try {
    const r = await fetch('/t/estado', { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    if (!j?.ok) throw new Error('sin servicio');
    casilla.disabled = false;
    casilla.checked = true;
    nota.textContent = 'Seguimiento activo. Las aperturas registradas en los primeros '
      + '15 segundos se marcan como escáner y no cuentan: los filtros antispam cargan '
      + 'las imágenes al recibir, no al leer.';
  } catch {
    casilla.disabled = true;
    casilla.checked = false;
    nota.textContent = 'La función de seguimiento no está desplegada, así que las '
      + 'aperturas y clics no se registrarán. Envíos, errores, rebotes y respuestas '
      + 'sí se miden. Para activarla: firebase deploy --only functions';
  }
}

function pintarEstadoGmail(correo, conLectura) {
  const caja = $('gmail-estado');
  if (!correo) return;
  caja.classList.add('ok');
  caja.innerHTML = `<div><strong>Gmail conectado:</strong> ${esc(correo)}.
    Los correos saldrán desde esta cuenta. La sesión dura una hora.`
    + (conLectura
      ? ' Se detectarán respuestas y rebotes automáticamente.</div>'
      : ' <em>Sin permiso de lectura: las respuestas habrá que revisarlas '
        + 'a mano en la bandeja.</em></div>');
  $('d-revisar').disabled = !conLectura;
}

$('c-ver-grande').addEventListener('click', () => {
  const ejemplo = estado.destinatarios[0];
  if (!ejemplo) { mostrarError({ message: 'El segmento no tiene destinatarios.' }); return; }
  const ctx = ctxCorreo();
  const html = mail.correoHtml({
    texto: mail.aplicarVariables($('c-cuerpo').value, ejemplo, ctx),
    prospecto: ejemplo, ctx, base: location.origin, track: false,
  });
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});

for (const [id, fn] of [
  ['c-asunto', previsualizar], ['c-cuerpo', previsualizar],
  ['c-whatsapp', () => { guardarContacto(); previsualizar(); }],
  ['c-sitio', () => { guardarContacto(); previsualizar(); }],
]) $(id).addEventListener('input', fn);

$('ag-dias').addEventListener('click', (e) => {
  const b = e.target.closest('.ag-dia');
  if (!b) return;
  agenda.dia = b.dataset.fecha;
  pintarAgenda();
});

$('ag-horas').addEventListener('click', (e) => {
  const b = e.target.closest('.ag-hora');
  if (!b || b.disabled) return;
  const d = diasHabiles().find((x) => x.toDateString() === agenda.dia);
  if (d) ponerSlots([...slotsElegidos(), textoSlot(d, b.dataset.hora)]);
});

$('ag-elegidos').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-quitar]');
  if (!b) return;
  const lista = slotsElegidos();
  lista.splice(Number(b.dataset.quitar), 1);
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
  estado.destinatarios = segmentoActual();
  estado.campanaActual.segmento = { desc: descripcionSegmento() };
  $('segmento-desc').textContent = estado.campanaActual.segmento.desc;
  resumenSegmento(); previsualizar();
});

$('c-guardar').addEventListener('click', async () => {
  const c = estado.campanaActual;
  Object.assign(c, {
    nombre: $('c-nombre').value.trim() || 'Sin nombre',
    asunto: $('c-asunto').value, cuerpo: $('c-cuerpo').value,
    track: $('c-track-aperturas').checked,
  });
  try {
    c.id = await mail.guardarCampana(db, c, estado.destinatarios, auth.currentUser.uid);
    progreso('Borrador guardado.');
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
      { asunto: $('c-asunto').value, cuerpo: $('c-cuerpo').value },
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
    const r = await mail.revisarRespuestas(db, estado.campanaActual.id);
    await abrirDetalle(estado.campanaActual.id);
    if (!r.revisados) mostrarError({ message: 'No hay envíos que revisar todavía.' });
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
    comprobarSeguimiento();
  } catch (e) {
    $('cargando').classList.add('oculto');
    mostrarError(e);
  }
});
