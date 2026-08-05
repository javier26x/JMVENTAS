// ============================================================
// JUMP Math Chile — CRM de prospección
//
// Lee Firestore con el SDK web. Las reglas exigen usuario autenticado,
// así que todo pasa por el login de Google.
// ============================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';
import {
  getFirestore, collection, doc, getDocs, getDoc, query, where,
  orderBy, limit, startAfter, serverTimestamp, setDoc,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

import * as mail from './mailing.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCTmWjLoe2p78K6wng9SF9DKUoAKEoMf1M',
  authDomain: 'jmventas-aab3c.firebaseapp.com',
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
  $('cargando').classList.remove('oculto');
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
      pintar();
    }
  }
}

function filtrar(filas) {
  const texto = normalizar($('buscar').value).trim();
  const [tier, canal, region, ate, est] =
    ['f-tier', 'f-canal', 'f-region', 'f-ate', 'f-estado'].map((i) => $(i).value);
  return filas.filter((f) => {
    if (tier && String(f.tierNum ?? '') !== tier) return false;
    if (canal && f.canal !== canal) return false;
    if (region && f.region !== region) return false;
    if (ate && f.requiereAte !== (ate === 'si')) return false;
    if (est && (f.estadoCrm || 'nuevo') !== est) return false;
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
  oportunidades: (p) => `<tr>
    <td class="num"><span class="oport">${p._oport ?? '—'}</span></td>
    <td><div class="nombre">${esc(p.establecimiento)}</div>
      <div class="sub">RBD ${esc(p.rbd)} · ${esc(p.comuna)}, ${esc(p.region)} · ${esc(p.canal)}</div></td>
    <td class="porque">${esc(porQue(p)) || '—'}</td>
    <td>${celdaMate(p)}</td>
    <td>${distintivoTier(p.tierNum)}<div class="sub">${distintivoAte(p.requiereAte)}</div></td>
    <td class="num">${numero(p.matBasica)}</td>
    <td class="contacto">${celdaContacto(partes(p.email), partes(p.telefono))}</td>
    <td>${selectorEstado('prospectos', p.id, p.estadoCrm)}</td></tr>`,

  prospectos: (p) => `<tr>
    <td>${distintivoTier(p.tierNum)}</td>
    <td><div class="nombre">${esc(p.establecimiento)}</div>
      <div class="sub">RBD ${esc(p.rbd)} · ${esc(p.comuna)}, ${esc(p.region)} · ${esc(p.dependencia)}</div></td>
    <td>${esc(p.canal)}</td>
    <td>${distintivoAte(p.requiereAte)}</td>
    <td>${celdaMate(p)}</td>
    <td class="num">${numero(p.matBasica)}</td>
    <td class="num">${p.eeEnRed > 1 ? `${numero(p.eeEnRed)} EE` : '—'}</td>
    <td class="contacto">${celdaContacto(partes(p.email), partes(p.telefono))}</td>
    <td>${selectorEstado('prospectos', p.id, p.estadoCrm)}</td></tr>`,

  cuentas: (c) => `<tr>
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
    <td>${selectorEstado('cuentas', c.id, c.estadoCrm)}</td></tr>`,

  redes: (r) => `<tr>
    <td><div class="nombre">${esc(r.rutSostenedor)}</div>
      <div class="sub">${esc(r.establecimientoMayor || '')}</div></td>
    <td>${esc(r.comunaPrincipal || '—')}</td>
    <td>${distintivoAte(r.requiereAte)}</td>
    <td class="num">${numero(r.eeBasica)}</td>
    <td class="num">${numero(r.matBasica)}</td>
    <td class="num">${numero(r.nRegiones)}</td>
    <td>${selectorEstado('redes', r.id, r.estadoCrm)}</td></tr>`,
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

  $('cabecera-tabla').innerHTML = COLUMNAS[v]
    .map((c, i) => `<th${NUMERICAS[v].includes(i) ? ' class="num"' : ''}>${esc(c)}</th>`).join('');
  $('cuerpo').innerHTML = filas.map(FILA[v]).join('');

  $('vacio').classList.toggle('oculto', filas.length > 0 || estado.cargando);
  $('mas').classList.toggle('oculto', !(PAGINADAS.includes(v) && estado.hayMas));
  $('f-umbral').classList.toggle('oculto', v !== 'oportunidades');
  $('f-orden').classList.toggle('oculto', v === 'oportunidades');

  $(`n-${v}`).textContent = numero(filas.length);

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
  $('vista-campanas').classList.toggle('oculto', vista !== 'campanas');
  $('vista-editor').classList.add('oculto');
  $('vista-detalle').classList.add('oculto');
  actualizarAcciones();
}

function actualizarAcciones() {
  const v = estado.vista;
  const caja = $('acciones-vista');
  if (LISTADOS.includes(v) && PAGINADAS.includes(v)) {
    caja.innerHTML = '<button class="primario" id="crear-campana">Crear campaña con este segmento</button>';
    $('crear-campana').onclick = abrirEditorDesdeSegmento;
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
  const p = [];
  if ($('f-tier').value) p.push(`Tier ${$('f-tier').value}`);
  if ($('f-canal').value) p.push($('f-canal').value);
  if ($('f-region').value) p.push($('f-region').value);
  if ($('f-ate').value) p.push($('f-ate').value === 'no' ? 'sin ATE' : 'requiere ATE');
  if ($('f-estado').value) p.push(ETIQUETA_ESTADO[$('f-estado').value] || $('f-estado').value);
  if (estado.vista === 'oportunidades') p.push(`dolor ${$('f-umbral').value}+`);
  return p.length ? p.join(' · ') : 'Todos los prospectos cargados';
}

function segmentoActual() {
  return filtrar(estado[estado.vista])
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

const PLANTILLA = `Estimado equipo directivo de {{establecimiento}}:

Los resultados SIMCE de Matemática 2025 sitúan a {{establecimiento}} en {{simce}} puntos, {{brecha}} bajo el promedio de {{promedio}} de los establecimientos del país.

JUMP Math es un método de enseñanza de la matemática con evidencia de impacto en estudios controlados. No reemplaza al profesor: le entrega una secuencia de clases estructurada que descompone cada objetivo en pasos que todo el curso puede seguir.

¿Tendrían 30 minutos para una reunión y les muestro cómo funcionaría en {{comuna}}?

Quedo atento,`;

function abrirEditor() {
  const c = estado.campanaActual;
  $('c-nombre').value = c.nombre || '';
  $('c-asunto').value = c.asunto || '';
  $('c-cuerpo').value = c.cuerpo || '';
  $('c-track-aperturas').checked = Boolean(c.track);
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

function previsualizar() {
  const ejemplo = estado.destinatarios[0];
  if (!ejemplo) { $('previsualizacion').textContent = 'Sin destinatarios en el segmento.'; return; }
  const ctx = { promedio: PROMEDIO_MATE };
  $('previsualizacion').innerHTML =
    `<span class="asunto">${esc(mail.aplicarVariables($('c-asunto').value, ejemplo, ctx))}</span>`
    + esc(mail.aplicarVariables($('c-cuerpo').value, ejemplo, ctx))
    + `<div class="sub" style="margin-top:10px">Para: ${esc(mail.primerCorreo(ejemplo.email))} · `
    + `${esc(ejemplo.establecimiento)}</div>`;
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
    { e: 'Aperturas', v: estado.campanaActual?.track ? numero(t.aperturas) : '—', n: estado.campanaActual?.track ? 'con seguimiento' : 'seguimiento desactivado' },
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
      { promedio: PROMEDIO_MATE, prospectos, cancelado: () => estado.cancelar },
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
  if (v === 'campanas') { await pintarCampanas(); return; }
  if (PAGINADAS.includes(v) && !estado[v].length) { await cargarProspectos(); poblarFiltros(); }
  else pintar();
});

$('buscar').addEventListener('input', () => alFiltrar());
for (const id of ['f-tier', 'f-canal', 'f-region', 'f-ate', 'f-estado', 'f-orden', 'f-umbral']) {
  $(id).addEventListener('change', () => alFiltrar({ inmediato: true }));
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

$('conectar-gmail').addEventListener('click', async () => {
  try {
    const correo = await mail.conectarGmail(auth);
    pintarEstadoGmail(correo);
    limpiarError();
  } catch (e) { mostrarError(e); }
});

function pintarEstadoGmail(correo) {
  const caja = $('gmail-estado');
  if (correo) {
    caja.classList.add('ok');
    caja.innerHTML = `<div><strong>Gmail conectado:</strong> ${esc(correo)}.
      Los correos saldrán desde esta cuenta. La sesión dura una hora.</div>`;
  }
}

for (const [id, fn] of [
  ['c-asunto', previsualizar], ['c-cuerpo', previsualizar],
]) $(id).addEventListener('input', fn);

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
  } catch (e) { mostrarError(e); }
});

$('c-enviar').addEventListener('click', enviar);
$('c-volver').addEventListener('click', () => { irA('campanas'); pintarCampanas(); });
$('d-volver').addEventListener('click', () => { irA('campanas'); pintarCampanas(); });

$('d-revisar').addEventListener('click', async () => {
  if (!mail.gmailConectado()) { mostrarError({ message: 'Conecta Gmail para revisar respuestas.' }); return; }
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
  try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (e) {
    const p = $('acceso-error');
    p.textContent = e.code === 'auth/operation-not-allowed'
      ? 'Falta habilitar el proveedor Google en Authentication → Sign-in method.'
      : (e.message || String(e));
    p.classList.remove('oculto');
  }
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
    irA('oportunidades');
    await cargarProspectos();
    poblarFiltros();
    await pintarCampanas();
  } catch (e) {
    $('cargando').classList.add('oculto');
    mostrarError(e);
  }
});
