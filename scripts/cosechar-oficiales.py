#!/usr/bin/env python3
# ============================================================
# JUMP Math Chile - Cosecha de contactos desde fuentes oficiales
#
# Ayuda MINEDUC publica nóminas regionales en PDF con RBD, teléfono y
# correo por establecimiento. Son gratis, oficiales y no hay que raspar
# 7.808 sitios uno a uno. Este script las descarga, las parsea y deja un
# CSV listo para cruzar con la base por RBD.
#
#   pip install --break-system-packages requests pypdf
#   python3 scripts/cosechar-oficiales.py --listar      # solo probar URLs
#   python3 scripts/cosechar-oficiales.py               # descargar y parsear
#
# Salida: datos/contactos-oficiales.csv  (RBD, EMAIL, TELEFONO, FUENTE)
#
# Nota honesta: estas nóminas son subconjuntos (establecimientos
# examinadores, validación de estudios, etc.), no el universo completo.
# Cubren varios miles de RBD sin costo ni scraping; el resto queda para
# enriquecer-contactos.py.
# ============================================================
import argparse
import csv
import os
import re
import shutil
import subprocess
import sys
import time
from collections import defaultdict

import requests

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATOS = os.path.join(RAIZ, 'datos')
CACHE = os.path.join(RAIZ, '.cache-pdf')
BASE = 'https://ayudamineduc.cl/sites/default/files/'

UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124 Safari/537.36')
HDRS = {'User-Agent': UA, 'Accept-Language': 'es-CL,es;q=0.9'}

REGIONES = {
    1: 'tarapaca', 2: 'antofagasta', 3: 'atacama', 4: 'coquimbo',
    5: 'valparaiso', 6: 'ohiggins', 7: 'maule', 8: 'biobio',
    9: 'araucania', 10: 'los_lagos', 11: 'aysen', 12: 'magallanes',
    13: 'metropolitana', 14: 'los_rios', 15: 'arica', 16: 'nuble',
}

# Los nombres de archivo no siguen una sola convención: MINEDUC los
# publica año a año con plantillas distintas. Se prueban todas y se
# reporta cuáles resolvieron.
def candidatos():
    urls = []
    for n, nombre in REGIONES.items():
        for anio in (2026, 2025):
            urls.append(f'r{n}_datos_ee_{anio}_adultos.pdf')
            urls.append(f'r{n}_datos_ee_{anio}.pdf')
        urls.append(f'r{n}_informacion_establecimientos_ayudamineduc_2022_{nombre}.pdf')
        urls.append(f'r{n}_informacion_establecimientos_ayudamineduc_{nombre}.pdf')
        urls.append(f'r{n}_{nombre}.pdf')
    urls += [
        'region_metropolitana.pdf', 'region_de_valparaiso.pdf',
        'region_de_antofagasta.pdf', 'region_de_atacama.pdf',
        'region_de_coquimbo.pdf', 'region_de_tarapaca.pdf',
        'region_de_ohiggins.pdf', 'region_del_maule.pdf',
        'region_del_biobio.pdf', 'region_de_la_araucania.pdf',
        'region_de_los_lagos.pdf', 'region_de_los_rios.pdf',
        'region_de_aysen.pdf', 'region_de_magallanes.pdf',
        'region_de_arica_y_parinacota.pdf', 'region_de_nuble.pdf',
    ]
    vistos, unicos = set(), []
    for u in urls:
        if u not in vistos:
            vistos.add(u)
            unicos.append(u)
    return unicos


RE_MAIL = re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')
RE_RBD = re.compile(r'^\s*(\d{1,6})\b')
RE_TEL = re.compile(r'(?:\+?56)?[\s\-]?(?:\(?\d{1,2}\)?[\s\-]?)?\d{4}[\s\-]?\d{4}')
BASURA = ('@mineduc', 'ejemplo', 'example', 'dominio', 'correo@')


def descargar(nombre, sesion):
    os.makedirs(CACHE, exist_ok=True)
    destino = os.path.join(CACHE, nombre)
    if os.path.exists(destino) and os.path.getsize(destino) > 2000:
        return destino
    try:
        r = sesion.get(BASE + nombre, headers=HDRS, timeout=45)
    except Exception as e:
        print(f'  !    {nombre}: {e}')
        return None
    # Un 404 devuelve HTML: comprobar la firma evita parsear basura.
    if r.status_code != 200 or not r.content[:5].startswith(b'%PDF'):
        return None
    tmp = destino + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(r.content)
    os.replace(tmp, destino)
    return destino


def texto_de_pdf(ruta):
    """pdftotext -layout conserva las columnas; pypdf es el respaldo."""
    if shutil.which('pdftotext'):
        try:
            out = subprocess.run(['pdftotext', '-layout', ruta, '-'],
                                 capture_output=True, timeout=180)
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.decode('utf-8', 'ignore')
        except Exception:
            pass
    try:
        from pypdf import PdfReader
    except ImportError:
        sys.exit('Falta un extractor de PDF. Instala uno:\n'
                 '  sudo apt-get install -y poppler-utils\n'
                 '  o:  pip install --break-system-packages pypdf')
    try:
        return '\n'.join((p.extract_text() or '') for p in PdfReader(ruta).pages)
    except Exception as e:
        print(f'  ! no se pudo leer {os.path.basename(ruta)}: {e}')
        return ''


def parsear(texto, fuente):
    """Extrae (rbd, correos, telefonos) por línea.

    Las filas de estas tablas a veces se parten en dos, con el correo o el
    teléfono cayendo en la línea siguiente. Se permite exactamente UNA
    línea de continuación: arrastrar el RBD indefinidamente hace que
    cualquier línea suelta (un pie de página, otra tabla) le cuelgue un
    correo ajeno al último establecimiento visto. Un correo atribuido al
    colegio equivocado es peor que un correo faltante.
    """
    filas = defaultdict(lambda: {'mails': set(), 'tels': set()})
    rbd_actual = None
    distancia = 0
    for linea in texto.splitlines():
        if not linea.strip():
            rbd_actual = None
            continue
        m = RE_RBD.match(linea)
        if m:
            n = int(m.group(1))
            # Rango real de RBD en Chile; fuera de él la fila es otra cosa
            # (un total, una numeración de página) y no se le atribuye nada.
            rbd_actual = n if 1 <= n <= 60000 else None
            distancia = 0
        else:
            distancia += 1
        if rbd_actual is None or distancia > 1:
            continue
        for correo in RE_MAIL.findall(linea):
            correo = correo.lower().strip('.,;')
            if not any(b in correo for b in BASURA):
                filas[rbd_actual]['mails'].add(correo)
        # el teléfono se busca sólo tras quitar el correo, para no
        # capturar dígitos que son parte de la dirección de mail
        sin_mail = RE_MAIL.sub(' ', linea)
        for t in RE_TEL.findall(sin_mail):
            d = re.sub(r'\D', '', t)
            if 8 <= len(d) <= 11 and d != str(rbd_actual):
                filas[rbd_actual]['tels'].add(t.strip())
    return {k: v for k, v in filas.items() if v['mails'] or v['tels']}, fuente


def rbds_de_la_base():
    ruta = os.path.join(DATOS, 'prospectos_jumpmath.csv')
    if not os.path.exists(ruta):
        return set()
    with open(ruta, encoding='utf-8-sig', newline='') as f:
        return {int(r['RBD']) for r in csv.DictReader(f) if r['RBD'].isdigit()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--listar', action='store_true',
                    help='sólo probar qué URLs existen, sin parsear')
    ap.add_argument('--pausa', type=float, default=1.0)
    a = ap.parse_args()

    sesion = requests.Session()
    lista = candidatos()
    print(f'Probando {len(lista)} archivos candidatos en ayudamineduc.cl\n')

    encontrados = []
    for nombre in lista:
        ruta = descargar(nombre, sesion)
        if ruta:
            kb = os.path.getsize(ruta) // 1024
            print(f'  OK   {nombre}  ({kb} KB)')
            encontrados.append((nombre, ruta))
        time.sleep(a.pausa)

    print(f'\n{len(encontrados)} de {len(lista)} disponibles.')
    if a.listar or not encontrados:
        if not encontrados:
            print('Ninguno respondió. Revisa la conexión o los nombres de archivo.')
        return

    print('\nParseando…')
    total = defaultdict(lambda: {'mails': set(), 'tels': set(), 'fuentes': set()})
    for nombre, ruta in encontrados:
        filas, fuente = parsear(texto_de_pdf(ruta), nombre)
        for rbd, v in filas.items():
            total[rbd]['mails'] |= v['mails']
            total[rbd]['tels'] |= v['tels']
            total[rbd]['fuentes'].add(fuente)
        print(f'  {nombre}: {len(filas)} RBD con contacto')

    base = rbds_de_la_base()
    utiles = {k: v for k, v in total.items() if not base or k in base}

    os.makedirs(DATOS, exist_ok=True)
    salida = os.path.join(DATOS, 'contactos-oficiales.csv')
    tmp = salida + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['RBD', 'EMAIL', 'TELEFONO', 'FUENTE'])
        for rbd in sorted(utiles):
            v = utiles[rbd]
            w.writerow([rbd, '; '.join(sorted(v['mails'])[:3]),
                        '; '.join(sorted(v['tels'])[:2]),
                        '; '.join(sorted(v['fuentes'])[:2])])
    os.replace(tmp, salida)

    con_mail = sum(1 for v in utiles.values() if v['mails'])
    print(f'\nRBD con contacto encontrados: {len(total)}')
    if base:
        print(f'  de esos, en nuestra base de básica: {len(utiles)} '
              f'({len(utiles) * 100 // max(len(base), 1)}% de {len(base)})')
    print(f'  con correo: {con_mail}')
    print(f'\n-> {salida}')
    print('\nSiguiente paso:')
    print('  node firebase/actualizar-contactos.mjs --admin '
          '--csv datos/contactos-oficiales.csv')


if __name__ == '__main__':
    main()
