#!/usr/bin/env bash
# ============================================================
# JUMP Math Chile - Cosecha completa, de principio a fin
#
# Corre las tres etapas y deja UN archivo listo para cargar. Se puede
# cortar en cualquier momento y relanzar el mismo comando: cada parte
# retoma donde iba.
#
#   bash scripts/cosechar-todo.sh        # 8 procesos en paralelo
#   bash scripts/cosechar-todo.sh 12     # mas agresivo
#   bash scripts/cosechar-todo.sh 1      # uno solo, para depurar
#
# Sobre el paralelismo: la pausa entre peticiones existe para no golpear
# un mismo sitio repetidamente. Aca hay 7.808 dominios distintos que no
# se conocen entre si, y cada proceso toma una particion por posicion, de
# modo que dos procesos nunca visitan el mismo servidor a la vez.
# Espaciar visitas a servidores ajenos no protege a nadie: solo alarga la
# corrida de 3 horas a 30.
#
# Esta maquina no necesita credenciales de Google: no escribe en
# Firestore. Produce datos/contactos-listos.csv y ahi termina su trabajo.
# ============================================================
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
BASE='datos/prospectos_jumpmath.csv'
PROCESOS="${1:-8}"
REGISTRO="$HOME/cosecha-completa.log"

etapa() {
  echo ""
  echo "=============================================================="
  echo "  $1"
  echo "  $(date '+%Y-%m-%d %H:%M:%S')"
  echo "=============================================================="
}

{
  etapa "ETAPA 1/3 · Nominas oficiales del MINEDUC"
  # Ventana 8: las filas de estos PDF parten el correo varias lineas bajo
  # el RBD. Mas ancha no aporta y empieza a atribuir correos ajenos.
  python3 -u scripts/cosechar-oficiales.py --ventana 8

  etapa "ETAPA 2/3 · Sitios web · $PROCESOS procesos en paralelo"
  echo "Cada proceso escribe su propio archivo; ninguno pisa al otro."
  echo "Sigue el avance de uno cualquiera con:"
  echo "  tail -f ~/parte-0.log"
  echo ""

  # Los logs de corridas anteriores se van. Si la corrida pasada uso otro
  # numero de procesos, los sobrantes quedan en disco y el contador los
  # suma: eso disparaba una alarma de bloqueo sobre rechazos de ayer.
  rm -f "$HOME"/parte-*.log

  PIDS=()
  MIOS=()
  for ((i = 0; i < PROCESOS; i++)); do
    python3 -u scripts/enriquecer-contactos.py \
      --csv "$BASE" \
      --tier todos \
      --particion "$i/$PROCESOS" \
      --salida "datos/parte-$i-contactos.csv" \
      --limite 999999 > "$HOME/parte-$i.log" 2>&1 &
    PIDS+=($!)
    MIOS+=("$HOME/parte-$i.log")
    echo "  proceso $((i + 1))/$PROCESOS lanzado (pid ${PIDS[-1]})"
  done

  # Un informe cada cinco minutos: con corridas de horas, no saber si
  # avanza es lo que lleva a matarla por las dudas.
  while true; do
    VIVOS=0
    for pid in "${PIDS[@]}"; do
      kill -0 "$pid" 2>/dev/null && VIVOS=$((VIVOS + 1))
    done
    [ "$VIVOS" -eq 0 ] && break
    # awk y no bc: bc no viene instalado en un Ubuntu minimo, y un
    # informe que dice "?" cada cinco minutos no informa de nada.
    HECHOS=$(cat "${MIOS[@]}" 2>/dev/null | grep -c ' -> ' || echo 0)
    FALLOS=$(cat "${MIOS[@]}" 2>/dev/null | grep -c 'buscador rechaza' || echo 0)
    AVISO=''
    [ "$FALLOS" -gt 20 ] && AVISO=" · ATENCION: $FALLOS rechazos del buscador, baja el paralelismo"
    echo "  [$(date '+%H:%M:%S')] $VIVOS procesos vivos · $HECHOS con contacto$AVISO"
    sleep 300
  done
  echo "Raspado terminado."

  etapa "ETAPA 3/3 · Un solo archivo, con el mejor correo de cada colegio"
  ENTRADAS=()
  [ -f datos/contactos-oficiales.csv ] && ENTRADAS+=(datos/contactos-oficiales.csv)
  for f in datos/parte-*-contactos.csv; do
    [ -f "$f" ] && ENTRADAS+=("$f")
  done
  if [ ${#ENTRADAS[@]} -eq 0 ]; then
    echo "No hay nada que consolidar: ninguna etapa dejo archivo."
    exit 1
  fi
  python3 -u scripts/consolidar-contactos.py "${ENTRADAS[@]}"

  etapa "LISTO"
  echo "Trae el resultado a la maquina que tiene credenciales:"
  echo "  scp $(whoami)@$(hostname -I | awk '{print $1}'):$(pwd)/datos/contactos-listos.csv datos/"
  echo ""
  echo "Y cargalo desde alli:"
  echo "  node firebase/actualizar-contactos.mjs --admin \\"
  echo "    --csv datos/contactos-listos.csv --fuente cosecha"
} 2>&1 | tee "$REGISTRO"
