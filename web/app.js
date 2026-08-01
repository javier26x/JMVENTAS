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
  getFirestore, collection, doc, getDocs, getDoc, updateDoc, query, where,
  orderBy, limit, startAfter, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

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

const PAGINA = 300;            // prospectos por consulta al servidor
const $ = (id) => document.getElementById(id);

const ESTADOS = ['nuevo', 'contactado', 'reunion', 'propuesta', 'ganado', 'descartado'];
const ETIQUETA_ESTADO = {
  nuevo: 'Nuevo', contactado: 'Contactado', reunion: 'Reunión agendada',
  propuesta: 'Propuesta enviada', ganado: 'Ganado', descartado: 'Descartado',
  sin_web: 'Sin web', web_sin_mail: 'Web sin correo', contacto_ok: 'Contacto OK',
};

const estado = {
  vista: 'cuentas',
  cuentas: [],      // 24 documentos: se cargan completos
  redes: [],        // 325 documentos: se cargan completos
  prospectos: [],   // 7.808: paginados desde el servidor
  ultimoDoc: null,
  hayMas: false,
  meta: null,
  cargando: false,
  peticion: 0,      // descarta respuestas de consultas ya superadas
};

// ---------- utilidades ----------
const numero = (n) => (n ?? 0).toLocaleString('es-CL');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const normalizar = (s) => String(s ?? '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

function distintivoTier(tierNum) {
  if (!tierNum) return '';
  const nombre = { 1: 'Fácil', 2: 'Medio', 3: 'Difícil' }[tierNum] || tierNum;
  return `<span class="tier t${tierNum}">${tierNum} · ${nombre}</span>`;
}

// El estado ATE se muestra con texto e icono; el color nunca va solo.
function distintivoAte(requiere) {
  return requiere
    ? '<span class="ate si">● Requiere ATE</span>'
    : '<span class="ate no">✓ Sin ATE</span>';
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

function selectorEstado(coleccion, id, actual) {
  const valor = ESTADOS.includes(actual) ? actual : 'nuevo';
  const extra = ESTADOS.includes(actual) ? ''
    : `<option value="${esc(actual)}" selected>${esc(ETIQUETA_ESTADO[actual] || actual)}</option>`;
  const opciones = ESTADOS
    .map((e) => `<option value="${e}"${e === valor && !extra ? ' selected' : ''}>${ETIQUETA_ESTADO[e]}</option>`)
    .join('');
  return `<select class="estado" data-col="${coleccion}" data-id="${esc(id)}">${extra}${opciones}</select>`;
}

function mostrarError(e) {
  const caja = $('error');
  // Firestore incluye el enlace de creación del índice en el mensaje
  const enlace = (e.message || '').match(/https:\/\/console\.firebase\.google\.com\S+/);
  caja.innerHTML = enlace
    ? `Falta un índice para esta combinación de filtros. Créalo aquí y reintenta:<br>
       <a href="${esc(enlace[0])}" target="_blank" rel="noopener">${esc(enlace[0])}</a>`
    : esc(e.message || String(e));
  caja.classList.remove('oculto');
}
const limpiarError = () => $('error').classList.add('oculto');

// ---------- carga ----------
async function cargarFijos() {
  const [cuentas, redes, meta] = await Promise.all([
    getDocs(query(collection(db, 'cuentas'), orderBy('prioridad'))),
    getDocs(query(collection(db, 'redes'), orderBy('matBasica', 'desc'), limit(400))),
    getDoc(doc(db, 'meta', 'carga')).catch(() => null),
  ]);
  estado.cuentas = cuentas.docs.map((d) => ({ id: d.id, ...d.data() }));
  estado.redes = redes.docs.map((d) => ({ id: d.id, ...d.data() }));
  estado.meta = meta && meta.exists() ? meta.data() : null;
}

/* Firestore no combina filtros arbitrarios sin un índice por combinación.
   En vez de declarar la explosión de índices, se manda al servidor el
   filtro más selectivo y el resto se afina en el cliente sobre la página
   traída. El contador de resultados dice siempre cuántos se revisaron. */
function consultaProspectos(desde) {
  const texto = normalizar($('buscar').value).trim();
  const partes = [collection(db, 'prospectos')];

  const palabra = texto.split(/\s+/).filter((p) => p.length >= 3)[0];
  if (palabra) {
    partes.push(where('tokens', 'array-contains', palabra));
  } else if ($('f-tier').value) {
    partes.push(where('tierNum', '==', Number($('f-tier').value)));
  } else if ($('f-canal').value) {
    partes.push(where('canal', '==', $('f-canal').value));
  } else if ($('f-region').value) {
    partes.push(where('region', '==', $('f-region').value));
  } else if ($('f-estado').value) {
    partes.push(where('estadoCrm', '==', $('f-estado').value));
  } else if ($('f-ate').value) {
    partes.push(where('requiereAte', '==', $('f-ate').value === 'si'));
  }

  partes.push(orderBy('matBasica', 'desc'));
  if (desde) partes.push(startAfter(desde));
  partes.push(limit(PAGINA));
  return query(...partes);
}

async function cargarProspectos({ continuar = false } = {}) {
  const mio = ++estado.peticion;
  estado.cargando = true;
  $('cargando').classList.remove('oculto');
  try {
    const snap = await getDocs(consultaProspectos(continuar ? estado.ultimoDoc : null));
    if (mio !== estado.peticion) return;            // llegó tarde: la descartamos
    const filas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    estado.prospectos = continuar ? estado.prospectos.concat(filas) : filas;
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

// ---------- filtrado en cliente ----------
function filtrar(filas) {
  const texto = normalizar($('buscar').value).trim();
  const tier = $('f-tier').value;
  const canal = $('f-canal').value;
  const region = $('f-region').value;
  const ate = $('f-ate').value;
  const est = $('f-estado').value;

  return filas.filter((f) => {
    if (tier && String(f.tierNum ?? '') !== tier) return false;
    if (canal && f.canal !== canal) return false;
    if (region && f.region !== region) return false;
    if (ate && f.requiereAte !== (ate === 'si')) return false;
    if (est && (f.estadoCrm || 'nuevo') !== est) return false;
    if (texto) {
      const heno = normalizar(
        [f.establecimiento, f.cuenta, f.comuna, f.region,
         f.establecimientoMayor, f.rutSostenedor, f.nombreContacto,
         (f.emails || []).join(' ')].filter(Boolean).join(' '));
      if (!texto.split(/\s+/).every((p) => heno.includes(p))) return false;
    }
    return true;
  });
}

// ---------- pintado ----------
const COLUMNAS = {
  cuentas: ['Prio.', 'Cuenta', 'Canal', 'ATE', 'Colegios', 'Matrícula', 'Contacto', 'Confianza', 'Estado'],
  redes: ['Sostenedor', 'Comuna principal', 'ATE', 'Colegios', 'Matrícula', 'Regiones', 'Estado'],
  prospectos: ['Tier', 'Establecimiento', 'Canal', 'ATE', 'Matrícula', 'Red', 'Contacto', 'Estado'],
};

const NUMERICAS = {
  cuentas: [4, 5], redes: [3, 4, 5], prospectos: [4, 5],
};

function filaCuenta(c) {
  return `<tr>
    <td><span class="prio${c.prioridad === 1 ? ' p1' : ''}">${c.prioridad ?? '—'}</span></td>
    <td>
      <div class="nombre">${esc(c.cuenta)}</div>
      <div class="sub">${esc(c.tipo)}${c.nombreContacto ? ` · ${esc(c.nombreContacto)}` : ''}${c.cargo ? ` (${esc(c.cargo)})` : ''}</div>
      ${c.proximoPaso ? `<div class="sub">→ ${esc(c.proximoPaso)}</div>` : ''}
    </td>
    <td>${esc(c.canal)}</td>
    <td>${distintivoAte(c.requiereAte)}</td>
    <td class="num">${c.eeBasica ? numero(c.eeBasica) : '—'}</td>
    <td class="num">${c.matBasica ? numero(c.matBasica) : '—'}</td>
    <td class="contacto">${celdaContacto(c.emails, c.telefonos)}</td>
    <td>${esc(c.confianza || '—')}</td>
    <td>${selectorEstado('cuentas', c.id, c.estadoCrm)}</td>
  </tr>`;
}

function filaRed(r) {
  return `<tr>
    <td>
      <div class="nombre">${esc(r.rutSostenedor)}</div>
      <div class="sub">${esc(r.establecimientoMayor || '')}</div>
    </td>
    <td>${esc(r.comunaPrincipal || '—')}</td>
    <td>${distintivoAte(r.requiereAte)}</td>
    <td class="num">${numero(r.eeBasica)}</td>
    <td class="num">${numero(r.matBasica)}</td>
    <td class="num">${numero(r.nRegiones)}</td>
    <td>${selectorEstado('redes', r.id, r.estadoCrm)}</td>
  </tr>`;
}

function filaProspecto(p) {
  const correos = (p.email || '').split(';').map((s) => s.trim()).filter(Boolean);
  const tels = (p.telefono || '').split(';').map((s) => s.trim()).filter(Boolean);
  return `<tr>
    <td>${distintivoTier(p.tierNum)}</td>
    <td>
      <div class="nombre">${esc(p.establecimiento)}</div>
      <div class="sub">RBD ${esc(p.rbd)} · ${esc(p.comuna)}, ${esc(p.region)} · ${esc(p.dependencia)}</div>
    </td>
    <td>${esc(p.canal)}</td>
    <td>${distintivoAte(p.requiereAte)}</td>
    <td class="num">${numero(p.matBasica)}</td>
    <td class="num">${p.eeEnRed > 1 ? `${numero(p.eeEnRed)} EE` : '—'}</td>
    <td class="contacto">${celdaContacto(correos, tels)}</td>
    <td>${selectorEstado('prospectos', p.id, p.estadoCrm)}</td>
  </tr>`;
}

function pintarKpis() {
  const m = estado.meta;
  const conContacto = estado.cuentas.filter((c) => c.tieneContacto).length;
  const sinAte = estado.cuentas
    .filter((c) => !c.requiereAte)
    .reduce((a, c) => a + (c.matBasica || 0), 0);

  const tiles = [
    { etiqueta: 'Establecimientos', valor: numero(m?.prospectos ?? 0), nota: 'con básica regular' },
    { etiqueta: 'Matrícula básica', valor: numero(m?.matBasicaTotal ?? 0), nota: 'alumnos alcanzables' },
    { etiqueta: 'Redes', valor: numero(estado.redes.length), nota: '1 reunión = N colegios' },
    { etiqueta: 'Cuentas con contacto', valor: `${conContacto}`, nota: `de ${estado.cuentas.length} de cabecera` },
    { etiqueta: 'Alcanzable sin ATE', valor: numero(sinAte), nota: 'alumnos, contrato directo' },
  ];
  $('kpis').innerHTML = tiles.map((t) => `<div class="kpi">
      <div class="etiqueta">${esc(t.etiqueta)}</div>
      <div class="valor">${esc(t.valor)}</div>
      <div class="nota">${esc(t.nota)}</div>
    </div>`).join('');
}

function pintar() {
  const vista = estado.vista;
  const filas = filtrar(estado[vista]);

  $('cabecera').innerHTML = COLUMNAS[vista]
    .map((c, i) => `<th${NUMERICAS[vista].includes(i) ? ' class="num"' : ''}>${esc(c)}</th>`)
    .join('');

  const pinta = { cuentas: filaCuenta, redes: filaRed, prospectos: filaProspecto }[vista];
  $('cuerpo').innerHTML = filas.map(pinta).join('');

  $('vacio').classList.toggle('oculto', filas.length > 0 || estado.cargando);
  $('mas').classList.toggle('oculto', !(vista === 'prospectos' && estado.hayMas));

  const revisados = estado[vista].length;
  $('resultado').textContent = vista === 'prospectos'
    ? `${numero(filas.length)} de ${numero(revisados)} revisados${estado.hayMas ? ' · hay más' : ''}`
    : `${numero(filas.length)} de ${numero(revisados)}`;
}

// Poblar los selectores con lo que existe de verdad en la base
function poblarFiltros() {
  const universo = estado.prospectos.length ? estado.prospectos : [];
  const canales = [...new Set(universo.map((p) => p.canal).filter(Boolean))].sort();
  const regiones = [...new Set(universo.map((p) => p.region).filter(Boolean))].sort();
  for (const [sel, valores] of [['f-canal', canales], ['f-region', regiones]]) {
    const el = $(sel);
    if (el.options.length > 1 || !valores.length) continue;
    for (const v of valores) el.add(new Option(v, v));
  }
}

// ---------- eventos ----------
let temporizador;
function alFiltrar({ inmediato = false } = {}) {
  clearTimeout(temporizador);
  const correr = async () => {
    if (estado.vista === 'prospectos') {
      estado.ultimoDoc = null;
      await cargarProspectos();
    } else {
      pintar();
    }
  };
  if (inmediato) correr(); else temporizador = setTimeout(correr, 280);
}

$('pestanas').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-vista]');
  if (!b) return;
  [...$('pestanas').children].forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  estado.vista = b.dataset.vista;
  if (estado.vista === 'prospectos' && !estado.prospectos.length) {
    await cargarProspectos();
    poblarFiltros();
  } else {
    pintar();
  }
});

$('buscar').addEventListener('input', () => alFiltrar());
for (const id of ['f-tier', 'f-canal', 'f-region', 'f-ate', 'f-estado']) {
  $(id).addEventListener('change', () => alFiltrar({ inmediato: true }));
}
$('mas').addEventListener('click', () => cargarProspectos({ continuar: true }));

// Las reglas sólo permiten tocar los campos de gestión comercial
$('cuerpo').addEventListener('change', async (e) => {
  const sel = e.target.closest('select.estado');
  if (!sel) return;
  const { col, id } = sel.dataset;
  const previo = estado[col].find((x) => x.id === id)?.estadoCrm;
  sel.disabled = true;
  try {
    await updateDoc(doc(db, col, id), {
      estadoCrm: sel.value,
      actualizado: serverTimestamp(),
    });
    const fila = estado[col].find((x) => x.id === id);
    if (fila) fila.estadoCrm = sel.value;
    limpiarError();
  } catch (err) {
    sel.value = previo || 'nuevo';
    mostrarError(err);
  } finally {
    sel.disabled = false;
  }
});

// ---------- sesión ----------
$('entrar').addEventListener('click', async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    const p = $('acceso-error');
    p.textContent = e.code === 'auth/operation-not-allowed'
      ? 'Falta habilitar el proveedor Google en Authentication → Sign-in method.'
      : (e.message || String(e));
    p.classList.remove('oculto');
  }
});
$('salir').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (u) => {
  const dentro = Boolean(u);
  $('acceso').classList.toggle('oculto', dentro);
  $('app').classList.toggle('oculto', !dentro);
  $('usuario').classList.toggle('oculto', !dentro);
  if (!dentro) return;

  $('avatar').src = u.photoURL || '';
  $('correo').textContent = u.email || '';
  try {
    await cargarFijos();
    pintarKpis();
    pintar();
    $('cargando').classList.add('oculto');
  } catch (e) {
    $('cargando').classList.add('oculto');
    mostrarError(e);
  }
});
