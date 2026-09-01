#!/usr/bin/env bash
# ============================================================
# JUMP Math Chile - Cosecha completa, de principio a fin
#
# Corre las tres piezas en el orden que importa y deja UN archivo listo
# para cargar. Pensado para un VPS: se puede cortar en cualquier momento
# y relanzar el mismo comando, porque cada etapa retoma donde iba.
#
# El orden no es casual. Primero lo oficial, que es gratis y no molesta a
# nadie. Despues el raspado por tier, empezando por los colegios que
# cierran mas rapido: si hay que parar a mitad de camino, lo que quedo
# hecho es lo que mas vale.
#
#   bash scripts/cosechar-todo.sh              # todo
#   bash scripts/cosechar-todo.sh --sin-tier3  # salta los 5.715 dificiles
#
# Esta maquina no necesita credenciales de Google: no escribe en
# Firestore. Produce datos/contactos-listos.csv y ahi termina su trabajo.
# ============================================================
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
BASE='datos/prospectos_jumpmath.csv'
RASPADO='datos/prospectos_jumpmath-contactos.csv'
REGISTRO="$HOME/cosecha-completa.log"

# Cada etapa se anuncia en el registro con su hora: con corridas de
# muchas horas, saber cuando empezo cada cosa es la mitad del diagnostico.
etapa() {
  echo ""
  echo "=============================================================="
  echo "  $1"
  echo "  $(date '+%Y-%m-%d %H:%M:%S')"
  echo "=============================================================="
}

{
  etapa 'ETAPA 1/3 · Nominas oficiales del MINEDUC'
  # Ventana 8: las filas de estos PDF parten el correo varias lineas bajo
  # el RBD. Mas ancha no aporta y empieza a atribuir correos ajenos.
  python3 -u scripts/cosechar-oficiales.py --ventana 8

  etapa 'ETAPA 2/3 · Sitios web de los colegios'
  # Por tier y en este orden: si hay que cortar, lo hecho es lo valioso.
  # --limite alto porque el script ya salta los que tienen contacto.
  for TIER in '1 · FACIL' '2 · MEDIO' '3 · DIFICIL'; do
    if [ "$TIER" = '3 · DIFICIL' ] && [ "${1:-}" = '--sin-tier3' ]; then
      echo ''
      echo ">>> Tier 3 omitido por --sin-tier3"
      continue
    fi
    echo ''
    echo ">>> Tier: $TIER"
    python3 -u scripts/enriquecer-contactos.py --csv "$BASE" --tier "$TIER" --limite 9999
  done

  etapa 'ETAPA 3/3 · Un solo archivo, con el mejor correo de cada colegio'
  ENTRADAS=()
  [ -f datos/contactos-oficiales.csv ] && ENTRADAS+=(datos/contactos-oficiales.csv)
  [ -f "$RASPADO" ] && ENTRADAS+=("$RASPADO")
  if [ ${#ENTRADAS[@]} -eq 0 ]; then
    echo 'No hay nada que consolidar: ninguna etapa dejo archivo.'
    exit 1
  fi
  python3 -u scripts/consolidar-contactos.py "${ENTRADAS[@]}"

  etapa 'LISTO'
  echo 'Transfiere el resultado a la maquina que tiene credenciales:'
  echo "  scp $(whoami)@$(hostname -I | awk '{print $1}'):$(pwd)/datos/contactos-listos.csv ."
  echo ''
  echo 'Y cargalo desde alli:'
  echo '  node firebase/actualizar-contactos.mjs --admin \'
  echo '    --csv datos/contactos-listos.csv --fuente cosecha'
} 2>&1 | tee "$REGISTRO"
