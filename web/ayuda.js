// ============================================================
// Ayuda contextual
//
// Casi todo lo que se ve en la app es el resultado de un criterio: el
// tier sale de una fórmula, el dolor de una brecha contra el promedio
// real de la base, el cupo de la tanda de un escalón de calentamiento.
// Quien usa el CRM no debería tener que preguntar —ni fiarse— de un
// número cuyo origen no puede ver.
//
// Todos los textos viven acá, no repartidos por el código: es donde hay
// que venir a corregir una explicación cuando el criterio cambie.
// ============================================================

export const AYUDA = {
  // ---------- filtros del listado ----------
  buscar: ['Búsqueda',
    'Filtra por nombre del establecimiento o comuna sobre lo que ya está '
    + 'cargado en pantalla, sin volver a consultar el servidor. Ignora tildes '
    + 'y mayúsculas. Atajo: la tecla /'],
  'f-tier': ['Tier',
    'Se pueden marcar varios a la vez: el filtro trae los colegios de '
    + 'cualquiera de los tiers elegidos. '
    + 'Qué tan fácil es cerrar la venta, calculado con una fórmula: fricción de '
    + 'compra (30%), matrícula (20%), tamaño de la red del sostenedor (20%), '
    + 'copago (15%), zona urbana (10%) y convenio PIE (5%). '
    + '1 · Fácil desde 62 puntos, 2 · Medio desde 48, 3 · Difícil bajo eso.'],
  'f-canal': ['Canal de venta',
    'Admite varios a la vez. Cómo se compra, que no es lo mismo que cuánto se vende. '
    + 'A · Directo Privado: decide el colegio, contrato directo. '
    + 'B · Red Subvencionada: un sostenedor con 3 o más colegios, una reunión '
    + 'para varios. C · PS Individual: subvencionado suelto. '
    + 'D · Municipal/DAEM y E · SLEP: compra pública, plazos largos y '
    + 'normalmente Registro ATE.'],
  'f-region': ['Región',
    'Admite varias a la vez. Región del establecimiento. Sirve para armar tandas por zona: la '
    + 'capacitación docente es presencial, y concentrar colegios cercanos '
    + 'abarata la implementación.'],
  'f-ate': ['Requisito ATE',
    'Si el establecimiento necesita que el proveedor esté en el Registro ATE '
    + 'del MINEDUC para pagar con recursos SEP. Municipales y SLEP casi '
    + 'siempre lo exigen. Mientras JUMP Math no esté inscrito, los "Sin ATE" '
    + 'son los que pueden firmar este año.'],
  'f-estado': ['Estado en el CRM',
    'Admite varios a la vez. Dónde va cada prospecto en el embudo. Se marca a mano en la columna '
    + 'Estado, y pasa solo a "contactado" cuando le llega una campaña.'],
  'f-correo': ['Con o sin correo',
    'Sólo los que tienen dirección de correo pueden entrar en una campaña. '
    + 'Los "sin correo" son trabajo de teléfono o de búsqueda.'],
  'f-umbral': ['Umbral de dolor',
    'Corta la lista por el dolor mínimo en matemática. 85+ es la crisis '
    + 'documentada; 60+ es todo lo que está bajo el promedio nacional; 35+ '
    + 'abre la lista a los que apenas están en el promedio.'],
  'f-orden': ['Orden',
    'Por cuál columna se ordena la lista. En Oportunidades el orden es fijo: '
    + 'siempre por índice de oportunidad.'],
  'limpiar-filtros': ['Limpiar filtros',
    'Vuelve a la lista completa. No toca la selección de filas que hayas '
    + 'marcado a mano.'],

  // ---------- columnas ----------
  'col-oport': ['Oportunidad',
    'Mitad dolor documentado, mitad facilidad de cierre (0 a 100). Un colegio '
    + 'en crisis al que no se le puede vender hasta 2028 no es una '
    + 'oportunidad, y uno fácil de cerrar que ya rinde bien tampoco: el valor '
    + 'está en la intersección.'],
  'col-establecimiento': ['Establecimiento',
    'Nombre oficial en el directorio MINEDUC, con RBD, comuna, región y '
    + 'dependencia. El RBD es el identificador único del establecimiento y la '
    + 'llave con la que se cruzan todos los datos.'],
  'col-porque': ['Por qué',
    'El motivo concreto por el que este colegio aparece arriba: cuántos '
    + 'puntos está bajo el promedio, si pertenece a una red grande o si tiene '
    + 'copago alto. Sólo muestra lo que no se lee en otra columna.'],
  'col-matematica': ['Matemática',
    'Dolor de 0 a 100 construido con el SIMCE de Matemática de 4º básico: '
    + 'un colegio en 265 puntos marca 0 y uno en 205 marca 100, medido contra '
    + 'el promedio real de esta base, que es 253. Abajo, el puntaje y el año '
    + 'de la medición. Un guion significa que ese colegio no tiene resultado '
    + 'publicado.'],
  'col-tier': ['Tier',
    'Facilidad de cierre: 1 · Fácil, 2 · Medio, 3 · Difícil. Sale de la '
    + 'fórmula de puntaje, donde lo que más pesa es la fricción de compra.'],
  'col-matricula': ['Matrícula',
    'Alumnos en educación básica regular. Es el tamaño del contrato: el '
    + 'material y la capacitación se cotizan por estudiante y por curso.'],
  'col-contacto': ['Contacto',
    'Correos y teléfonos conocidos. Vienen del directorio MINEDUC, de la base '
    + 'de colegios de Chile y de recolección en sitios oficiales; los '
    + 'editados a mano nunca se sobrescriben en una recarga.'],
  'col-estado': ['Estado',
    'El punto del embudo en que está. Se cambia aquí mismo y queda guardado '
    + 'al instante.'],
  'col-canal': ['Canal',
    'El proceso de compra al que obliga la dependencia del establecimiento. '
    + 'Determina a quién hay que convencer y en cuánto tiempo se puede firmar.'],
  'col-ate': ['ATE',
    'Si exige Registro ATE para pagar con recursos SEP. "Sin ATE" es contrato '
    + 'directo con el sostenedor.'],
  'col-red': ['Red',
    'Cuántos establecimientos tiene el mismo sostenedor. Más de uno significa '
    + 'que una sola reunión puede cubrir varios colegios.'],
  'col-prioridad': ['Prioridad',
    'Orden de ataque de las cuentas de cabecera, puesto a mano. 1 es la '
    + 'primera de la fila.'],
  'col-cuenta': ['Cuenta',
    'Sostenedor o red trabajada como cuenta única, con su contacto verificado '
    + 'y el próximo paso acordado.'],
  'col-colegios': ['Colegios',
    'Establecimientos con básica que dependen de este sostenedor. Es el '
    + 'multiplicador de la venta: una negociación, N colegios.'],
  'col-confianza': ['Confianza',
    'Qué tan verificado está el contacto de la cuenta: si salió de una fuente '
    + 'oficial con el nombre confirmado o de una búsqueda automática.'],
  'col-sostenedor': ['Sostenedor',
    'RUT del sostenedor y su establecimiento mayor, que es el que sirve para '
    + 'abrir la conversación.'],
  'col-comuna-ppal': ['Comuna principal',
    'Comuna donde el sostenedor concentra más colegios. Es donde conviene '
    + 'proponer la reunión presencial.'],
  'col-regiones': ['Regiones',
    'En cuántas regiones opera la red. Más de dos exige plan de capacitación '
    + 'a distancia o por tandas.'],

  // ---------- selección y acciones del listado ----------
  'sel-todos': ['Seleccionar todo',
    'Marca todas las filas visibles con los filtros actuales. La selección '
    + 'sobrevive al cambio de filtros y a cargar más páginas.'],
  'accion-fila': ['Escribir sólo a este',
    'Abre una campaña con este único colegio, sin tocar la selección ni los '
    + 'filtros. Sirve para responder a un caso puntual.'],
  exportar: ['Exportar',
    'Descarga lo que estás viendo —o la selección, si hay filas marcadas— en '
    + 'CSV con punto y coma, que es lo que abre bien el Excel chileno.'],
  'crear-campana': ['Crear campaña',
    'Lleva el segmento actual al editor de correo. Antes de armarlo se quitan '
    + 'los que pidieron la baja, los que comparten casilla y los contactados '
    + 'hace menos de 30 días.'],
  'sel-campana': ['Campaña con la selección',
    'Usa exactamente las filas marcadas, ignorando los filtros de pantalla.'],
  'sel-copiar': ['Copiar correos',
    'Copia al portapapeles las direcciones de la selección, separadas por '
    + 'coma, para pegarlas donde haga falta.'],
  mas: ['Cargar más',
    'Trae la siguiente página desde el servidor. Los filtros que no se pueden '
    + 'consultar en el servidor se aplican sobre lo ya cargado, así que a '
    + 'veces hay que traer más para ver más.'],

  // ---------- hoy y ficha ----------
  'hoy-respondieron': ['Respondieron y esperan',
    'Colegios que contestaron el correo y siguen sin gestionar. Se llenan '
    + 'solos al pulsar "Revisar respuestas" en una campaña. Responder en '
    + 'menos de dos horas hábiles es lo que separa una reunión de un correo '
    + 'perdido.'],
  'hoy-pendientes': ['Próximos pasos de hoy',
    'Lo que quedó comprometido en la ficha de cada colegio y ya vence. Si '
    + 'está vacío no es que no haya trabajo: es que no se anotó.'],
  'hoy-calientes': ['Abrieron y no contestaron',
    'Dos aperturas o más sin responder: el correo les interesó pero no se '
    + 'atrevieron a escribir. Una llamada acá convierte más barato que '
    + 'cualquier envío nuevo. Requiere campañas con seguimiento activado.'],
  'hoy-seguimientos': ['Campañas que tocan seguimiento',
    'Enviadas hace más de tres días y con gente que no ha contestado. Abre '
    + 'la campaña y pulsa "Crear seguimiento".'],
  'ficha-estado': ['Estado',
    'Dónde va este colegio en el embudo. "Respondió" lo pone la app sola al '
    + 'detectar la respuesta; el resto se mueve a mano y queda anotado en el '
    + 'historial.'],
  'ficha-paso': ['Próximo paso',
    'Qué hay que hacer y cuándo. Con fecha, aparece en la bandeja de Hoy el '
    + 'día que vence: es la única forma de que un "llámame en marzo" no se '
    + 'pierda.'],
  'ficha-registrar': ['Registrar en el historial',
    'Deja constancia de una llamada, una reunión o una propuesta. Los envíos '
    + 'de correo y las respuestas se anotan solos.'],
  'ficha-historial': ['Historial',
    'Todo lo que ha pasado con este colegio, del equipo completo: correos '
    + 'enviados, respuestas, cambios de estado y lo que se registre a mano.'],

  // ---------- panel ----------
  'g-estado': ['Pipeline comercial',
    'Cuántos establecimientos hay en cada estado del embudo, contados en el '
    + 'servidor sobre los 7.808 y no sobre la página cargada.'],
  'g-dolor': ['Dolor en matemática',
    'Distribución de la base según la brecha contra el promedio de 253 '
    + 'puntos. "Sin medición" son los colegios sin SIMCE publicado, que no '
    + 'son necesariamente buenos ni malos: simplemente no se sabe.'],
  'g-tier': ['Facilidad de cierre',
    'Cuántos colegios hay en cada tier. Da el tamaño real del mercado '
    + 'abordable este año frente al que exige Registro ATE.'],

  // ---------- campañas ----------
  'conectar-gmail': ['Conectar Gmail',
    'Autoriza a la app a enviar desde tu cuenta y a leer los hilos para '
    + 'detectar respuestas y rebotes. El permiso vive sólo en memoria y dura '
    + 'una hora.'],
  'conectar-solo-envio': ['Conectar sólo para enviar',
    'Pide únicamente el permiso de envío, que Google clasifica como sensible '
    + 'y no como restringido. Se puede enviar, pero las respuestas hay que '
    + 'revisarlas a mano en la bandeja.'],
  'c-nombre': ['Nombre interno',
    'Sólo para reconocer la campaña en el listado. El destinatario nunca lo ve.'],
  'c-asunto': ['Asunto',
    'Lo que decide si se abre. Admite las mismas variables que el mensaje: el '
    + 'nombre del colegio en el asunto sube la apertura.'],
  'c-cuerpo': ['Mensaje',
    'Alimenta la sección "¿Qué es JUMP Math?" del correo. El resto de la '
    + 'pieza —saludo, dato SIMCE, beneficios, horarios, botón y firma— la '
    + 'arma la plantilla con los datos de cada colegio.'],
  variables: ['Variables',
    'Se reemplazan por los datos del destinatario al momento de enviar. Haz '
    + 'clic para insertarlas donde esté el cursor.'],
  'c-plantilla': ['Diseño del correo',
    'El contenido es el mismo en las cinco plantillas: cambia qué bloques '
    + 'aparecen y con qué forma. "Lámina" es la completa; "Mínimo" es la que '
    + 'mejor pasa los filtros de spam porque casi no lleva imágenes. El modo '
    + 'oscuro no depende del cliente de correo: el correo sale oscuro para '
    + 'todos, y por eso se ve igual en cualquier bandeja. Cuál abre más en '
    + 'esta base se descubre probando, no discutiendo: usa la variante B '
    + 'para medirlo.'],
  'c-recalcular': ['Recalcular',
    'Vuelve a leer los filtros de la vista de prospectos y rehace la lista de '
    + 'destinatarios.'],
  'c-tanda': ['Correos en esta tanda',
    'Cuántos se envían ahora. Se propone el tope del escalón de calentamiento '
    + 'y lo que queda del cupo de hoy; el resto del segmento espera a la '
    + 'próxima tanda.'],
  'c-asunto-b': ['Prueba A/B',
    'Si completas asunto o mensaje B, la mitad del segmento lo recibe (uno '
    + 'sí, uno no) y el detalle compara ambas. Con menos de 30 envíos por '
    + 'variante la diferencia todavía es azar.'],
  'c-whatsapp': ['WhatsApp',
    'Aparece como botón grande y en la firma. El chat llega con el nombre del '
    + 'colegio ya escrito, así que el director no tiene que presentarse.'],
  'c-horarios': ['Horarios propuestos',
    'Marca varios días y varias horas: se cruzan, así que "martes y jueves a '
    + 'las 10 y a las 15" son cuatro bloques con cuatro clics. Cada ficha se '
    + 'puede quitar por separado. Proponer fechas concretas responde mucho '
    + 'mejor que "cuando usted pueda", y los bloques que ya pasaron se '
    + 'descartan solos. Van hasta seis al correo, aunque tres convierten '
    + 'mejor: elegir entre tres es fácil, entre seis es una tarea.'],
  'c-track-aperturas': ['Aperturas y clics',
    'Añade un pixel invisible y pasa los enlaces por un redirect propio. Las '
    + 'aperturas de los primeros 15 segundos se descartan como escáner: los '
    + 'filtros antispam cargan las imágenes al recibir, no al leer.'],
  'c-evidencia': ['Página de evidencia',
    'Añade un enlace a la página pública que explica el método. Revísala '
    + 'antes de activarla: prometer pruebas y llevar a una página incompleta '
    + 'cuesta más que no prometer nada.'],
  'c-prueba': ['Enviarme una prueba',
    'Manda el correo a tu propia casilla con los datos de un destinatario '
    + 'real. Es el único modo de ver cómo lo trata Gmail de verdad. Hazlo '
    + 'antes de cada campaña.'],
  'c-guardar': ['Guardar borrador',
    'Guarda campaña y destinatarios sin enviar nada.'],
  'c-programar': ['Programar el envío',
    'Deja la tanda redactada y guardada para que salga sola a la hora que '
    + 'elijas, con el navegador cerrado y sin nadie delante. Los correos se '
    + 'escriben ahora, así que lo que llega es exactamente la vista previa '
    + 'que tienes al lado; después de programar, cambiar el texto obliga a '
    + 'cancelar y volver a programar.'],

  'c-programar-boton': ['Programar',
    'La hora importa tanto como el mensaje: un correo frío que llega un '
    + 'martes a las 8 aparece arriba en la bandeja del director, y el mismo '
    + 'correo enviado un viernes a las 19 queda sepultado bajo el fin de '
    + 'semana. Requiere autorizar una vez el envío automático, que es el '
    + 'mismo permiso de Gmail pero guardado en el servidor para que siga '
    + 'sirviendo cuando cierres el navegador.'],

  'c-enviar': ['Enviar campaña',
    'Envía uno por uno, con pausa entre correos, guardando el resultado de '
    + 'cada uno apenas ocurre. Si se corta, lo enviado no se pierde y se '
    + 'puede reanudar.'],

  'col-campana': ['Campaña',
    'Nombre interno y asunto con el que salió.'],
  'col-c-estado': ['Estado de la campaña',
    'Borrador mientras no se envía nada; enviada en cuanto sale la primera '
    + 'tanda, aunque queden destinatarios pendientes.'],
  'col-c-destinatarios': ['Destinatarios',
    'Cuántos entraron en la campaña, ya descontadas las bajas, las casillas '
    + 'repetidas y los contactados hace poco.'],
  'col-c-enviados': ['Enviados',
    'Correos efectivamente entregados a la API de Gmail.'],
  'col-c-respuestas': ['Respuestas',
    'Hilos con un mensaje que no es tuyo. Es la métrica que predice ventas; '
    + 'aparece al pulsar "Revisar respuestas".'],
  'col-c-aperturas': ['Aperturas',
    'Total de veces que se cargó el pixel, descontadas las de los escáneres. '
    + 'Un guion significa que esa campaña salió sin seguimiento.'],
  'col-c-creada': ['Creada', 'Fecha en que se creó la campaña.'],

  // ---------- detalle de campaña ----------
  'd-revisar': ['Revisar respuestas',
    'Recorre los hilos enviados y marca respuestas, rebotes y bajas. Quien '
    + 'rebota o pide la baja queda excluido de todas las campañas futuras, no '
    + 'sólo de esta.'],
  'd-seguimiento': ['Crear seguimiento',
    'Arma una campaña de recordatorio para los que no respondieron, dentro '
    + 'del hilo del primer correo y en pieza breve. Es la acción de mayor '
    + 'retorno: un segundo toque suele duplicar las respuestas totales.'],
  'd-reanudar': ['Reanudar envío',
    'Retoma los destinatarios que quedaron pendientes, sin repetirle a nadie.'],
  'd-copiar': ['Copiar correos',
    'Copia las direcciones del corte que estás viendo. Con "calientes" '
    + 'marcado, es la lista de llamadas del día.'],
  'filtros-detalle': ['Cortes de la lista',
    'Cada corte responde a una acción distinta. "Calientes" son los que '
    + 'abrieron y no contestaron: la conversión más barata que existe. '
    + '"Errores y rebotes" es la limpieza de la base.'],
  'kpi-apertura': ['Tasa de apertura',
    'Cuántos abrieron respecto de los enviados. Bajo 35% el problema está en '
    + 'el asunto o en el remitente, no en el mensaje.'],
  'kpi-respuesta': ['Tasa de respuesta',
    'La métrica que importa. Bajo 3% con apertura buena, el problema está en '
    + 'el mensaje o en la propuesta.'],
  'kpi-rebotes': ['Rebotes y bajas',
    'Sobre 3% hay que depurar la lista antes de la siguiente tanda: seguir '
    + 'enviando a direcciones muertas es lo que hunde la reputación del '
    + 'remitente.'],
  'col-d-estado': ['Estado del destinatario',
    'pendiente · enviado · abierto · respondido · rebotado · baja · error. '
    + 'Nunca retrocede: un "respondido" no vuelve a "abierto".'],
  'col-d-aperturas': ['Aperturas',
    'Cuántas veces se cargó el pixel en ese destinatario. Dos o más, y sin '
    + 'respuesta, es una señal fuerte para llamar.'],
  'col-d-detalle': ['Detalle',
    'El error devuelto por Gmail cuando el envío falló.'],
};

let globo;
let anclaActual = null;
/* Con ratón, el globo ya se abrió al pasar por encima; si el clic lo
   tratara como alternar, haría falta hacer clic dos veces para dejarlo
   fijo. Se recuerda quién lo abrió: el puntero lo cierra al salir, el
   clic lo deja puesto hasta que se cierre a propósito. */
let porClic = false;

function crearGlobo() {
  globo = document.createElement('div');
  globo.className = 'globo-ayuda oculto';
  globo.setAttribute('role', 'tooltip');
  document.body.appendChild(globo);
  return globo;
}

/* Se coloca bajo el ancla, y se mete de vuelta en pantalla si se sale por
   un costado: muchos "?" viven en el borde derecho de una tabla que se
   desplaza en horizontal. */
function colocar() {
  if (!anclaActual || !globo) return;
  const r = anclaActual.getBoundingClientRect();
  const g = globo.getBoundingClientRect();
  const margen = 8;
  let x = r.left + r.width / 2 - g.width / 2;
  x = Math.max(margen, Math.min(x, window.innerWidth - g.width - margen));
  let y = r.bottom + 8;
  if (y + g.height > window.innerHeight - margen) y = Math.max(margen, r.top - g.height - 8);
  globo.style.left = `${Math.round(x)}px`;
  globo.style.top = `${Math.round(y)}px`;
}

function mostrar(ancla) {
  const texto = AYUDA[ancla.dataset.ayuda];
  if (!texto) return;
  if (!globo) crearGlobo();
  // Al pasar a otro "?", el globo deja de estar fijado por el clic
  // anterior; si no, el clic sobre el nuevo lo cerraría en vez de abrirlo.
  if (ancla !== anclaActual) porClic = false;
  anclaActual = ancla;
  globo.innerHTML = '<strong></strong><span></span>';
  globo.querySelector('strong').textContent = texto[0];
  globo.querySelector('span').textContent = texto[1];
  globo.classList.remove('oculto');
  colocar();
  ancla.setAttribute('aria-expanded', 'true');
}

function ocultar() {
  if (!globo) return;
  globo.classList.add('oculto');
  anclaActual?.setAttribute('aria-expanded', 'false');
  anclaActual = null;
  porClic = false;
}

/** El botón que se intercala en plantillas y HTML estático. */
export const ayudaHtml = (clave) => `<button type="button" class="ayuda" data-ayuda="${clave}"
  aria-label="Qué significa" aria-expanded="false">?</button>`;

/**
 * Un solo juego de escuchas delegadas para toda la app: los "?" nacen y
 * mueren cada vez que se repinta una tabla, así que enganchar a cada uno
 * los dejaría muertos al siguiente repintado.
 */
export function iniciarAyuda() {
  document.addEventListener('pointerover', (e) => {
    const a = e.target.closest?.('.ayuda');
    if (a) mostrar(a);
  });
  document.addEventListener('pointerout', (e) => {
    const a = e.target.closest?.('.ayuda');
    // En pantalla táctil el globo se abre con un toque y no debe cerrarse
    // por el "pointerout" que llega justo después; y si se dejó fijo con
    // un clic, tampoco.
    if (a && a === anclaActual && e.pointerType === 'mouse' && !porClic) ocultar();
  });
  document.addEventListener('focusin', (e) => {
    const a = e.target.closest?.('.ayuda');
    if (a) mostrar(a);
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('.ayuda');
    if (a) {
      e.preventDefault();
      e.stopPropagation();          // no disparar la acción de la fila
      if (a === anclaActual && porClic) ocultar();
      else { mostrar(a); porClic = true; }
      return;
    }
    ocultar();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ocultar(); });
  /* Al desplazar, el globo sigue al "?" en vez de cerrarse: cerrarlo
     rompía la ayuda de las últimas columnas, que sólo se alcanzan
     desplazando la tabla en horizontal. */
  const seguir = () => {
    if (!anclaActual) return;
    if (anclaActual.isConnected) colocar();
    else ocultar();
  };
  window.addEventListener('scroll', seguir, true);
  window.addEventListener('resize', seguir);
}
