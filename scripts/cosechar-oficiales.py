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
import unicodedata
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
RE_NUM = re.compile(r'\b(\d{1,6})\b')
RE_TEL = re.compile(r'(?:\+?56)?[\s\-]?(?:\(?\d{1,2}\)?[\s\-]?)?\d{4}[\s\-]?\d{4}')
BASURA = ('@mineduc', 'ejemplo', 'example', 'dominio', 'correo@')

VACIAS = {'colegio', 'escuela', 'liceo', 'centro', 'educacional', 'particular',
          'basica', 'complejo', 'instituto', 'anexo', 'subvencionado',
          'municipal', 'para', 'con', 'del', 'las', 'los', 'san', 'santa'}


def palabras(texto):
    """Tokens significativos, sin tildes, para comparar nombres."""
    limpio = unicodedata.normalize('NFKD', str(texto)).encode('ascii', 'ignore').decode()
    return {p for p in re.split(r'[^a-zA-Z0-9]+', limpio.lower())
            if len(p) >= 4 and p not in VACIAS}


def indice_rbd():
    """RBD -> palabras del nombre oficial.

    Anclar por posición no sirve: cada nómina ordena las columnas
    distinto. Las de 2022 parten con el número de REGIÓN, y 10 de los 16
    números de región son RBD reales (el 15 es un liceo de Arica, el 9
    una escuela de Iquique), así que tomar el primer número de la línea
    le cuelga decenas de correos ajenos a colegios que existen. Se
    verifica contra el nombre.
    """
    ruta = os.path.join(DATOS, 'prospectos_jumpmath.csv')
    if not os.path.exists(ruta):
        sys.exit(f'Falta {ruta}: sin él no se puede verificar a qué colegio '
                 'pertenece cada correo.')
    idx = {}
    with open(ruta, encoding='utf-8-sig', newline='') as f:
        for r in csv.DictReader(f):
            if r['RBD'].isdigit():
                idx[int(r['RBD'])] = palabras(r['ESTABLECIMIENTO'])
    return idx


def en_cache(nombre):
    destino = os.path.join(CACHE, nombre)
    return destino if os.path.exists(destino) and os.path.getsize(destino) > 2000 else None


def descargar(nombre, sesion):
    os.makedirs(CACHE, exist_ok=True)
    destino = os.path.join(CACHE, nombre)
    if en_cache(nombre):
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


_EXTRACTOR = []


def texto_de_pdf(ruta):
    """pdftotext -layout conserva las columnas; pypdf es el respaldo.

    Cuál se use cambia por completo el resultado: pypdf devuelve el texto
    en orden de dibujo, así que las filas de una tabla quedan
    desarmadas y el correo se separa de su RBD. Por eso se reporta.
    """
    if shutil.which('pdftotext'):
        if not _EXTRACTOR:
            _EXTRACTOR.append('pdftotext -layout')
            print(f'Extractor: {_EXTRACTOR[0]}\n')
    elif not _EXTRACTOR:
        _EXTRACTOR.append('pypdf')
        print('Extractor: pypdf  (sin pdftotext: las tablas se leen peor)\n'
              '  Instálalo para mejorar el resultado:\n'
              '    sudo apt-get install -y poppler-utils\n')
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


def parsear(texto, fuente, idx, ventana=3):
    """Extrae (rbd, correos, telefonos) por línea.

    Devuelve (filas, correos_en_el_documento). El segundo número es el
    diagnóstico: si el documento tiene cientos de correos y las filas
    salen vacías, el problema es el anclaje al RBD, no el archivo.

    Las filas de estas tablas se parten en varias líneas, con el correo
    cayendo debajo del nombre. Se permite una ventana corta de
    continuación: arrastrar el RBD sin límite hace que un pie de página o
    una segunda tabla le cuelgue un correo ajeno al último
    establecimiento visto, y un correo atribuido al colegio equivocado es
    peor que un correo faltante.
    """
    correos_doc = {c.lower() for c in RE_MAIL.findall(texto)
                   if not any(b in c.lower() for b in BASURA)}
    filas = defaultdict(lambda: {'mails': set(), 'tels': set()})
    rbd_actual = None
    distancia = 0
    for linea in texto.splitlines():
        if not linea.strip():
            rbd_actual = None
            continue

        # Candidato = número que es un RBD real Y cuyo nombre oficial
        # coincide con lo que dice la línea. Sin la segunda condición, el
        # número de región o el código de comuna pasan por RBD.
        pal = palabras(linea)
        mejor, mejor_puntaje = None, 0
        for n in {int(x) for x in RE_NUM.findall(linea)}:
            nombre = idx.get(n)
            if not nombre:
                continue
            coincidencias = len(nombre & pal)
            exigido = min(2, len(nombre)) or 1
            if coincidencias >= exigido and coincidencias > mejor_puntaje:
                mejor, mejor_puntaje = n, coincidencias
        if mejor is not None:
            rbd_actual, distancia = mejor, 0
        else:
            distancia += 1
        if rbd_actual is None or distancia > ventana:
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



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--listar', action='store_true',
                    help='sólo probar qué URLs existen, sin parsear')
    ap.add_argument('--pausa', type=float, default=1.0)
    ap.add_argument('--ventana', type=int, default=3,
                    help='líneas de continuación tras un RBD (default 3)')
    ap.add_argument('--diagnostico', metavar='ARCHIVO',
                    help='vuelca el texto extraído de un PDF ya descargado '
                         'para ver cómo quedan las filas')
    a = ap.parse_args()

    if a.diagnostico:
        ruta = os.path.join(CACHE, a.diagnostico)
        if not os.path.exists(ruta):
            sys.exit(f'No está descargado: {ruta}\nCorre primero el script sin --diagnostico.')
        texto = texto_de_pdf(ruta)
        lineas = [l for l in texto.splitlines() if l.strip()]
        print(f'{a.diagnostico}: {len(lineas)} líneas con contenido\n')
        print('--- primeras 40 líneas ---')
        for l in lineas[:40]:
            print(repr(l[:200]))
        con_mail = [l for l in lineas if RE_MAIL.search(l)]
        print(f'\n--- líneas con correo: {len(con_mail)} · primeras 10 ---')
        for l in con_mail[:10]:
            print(repr(l[:200]))
        return

    idx = indice_rbd()
    print(f'Base de verificación: {len(idx)} RBD con nombre oficial')

    sesion = requests.Session()
    lista = candidatos()
    print(f'Probando {len(lista)} archivos candidatos en ayudamineduc.cl\n')

    encontrados = []
    for nombre in lista:
        cacheado = bool(en_cache(nombre))
        ruta = descargar(nombre, sesion)
        if ruta:
            kb = os.path.getsize(ruta) // 1024
            print(f'  OK   {nombre}  ({kb} KB){"  [cache]" if cacheado else ""}')
            encontrados.append((nombre, ruta))
        # Sólo pausar si de verdad salimos a la red: con todo cacheado
        # el rerun para ajustar --ventana debe ser instantáneo.
        if not cacheado:
            time.sleep(a.pausa)

    print(f'\n{len(encontrados)} de {len(lista)} disponibles.')
    if a.listar or not encontrados:
        if not encontrados:
            print('Ninguno respondió. Revisa la conexión o los nombres de archivo.')
        return

    print('\nParseando…')
    total = defaultdict(lambda: {'mails': set(), 'tels': set(), 'fuentes': set()})
    sospechosos = []
    for nombre, ruta in encontrados:
        filas, correos_doc = parsear(texto_de_pdf(ruta), nombre, idx, a.ventana)
        for rbd, v in filas.items():
            total[rbd]['mails'] |= v['mails']
            total[rbd]['tels'] |= v['tels']
            total[rbd]['fuentes'].add(nombre)
        atribuidos = len({c for v in filas.values() for c in v['mails']})
        # Un documento lleno de correos que no se logran anclar a un RBD
        # es un fallo de parseo, no un archivo pobre. Hay que verlo.
        perdidos = len(correos_doc) - atribuidos
        marca = ''
        if perdidos > 20:
            marca = f'  <-- {perdidos} correos sin anclar'
            sospechosos.append((nombre, len(correos_doc), atribuidos))
        print(f'  {nombre}: {len(filas)} RBD con contacto '
              f'({len(correos_doc)} correos en el doc){marca}')

    if sospechosos:
        print('\nAtención: estos documentos tienen correos que no se pudieron '
              'atribuir a un RBD.')
        print('Míralos con:')
        print(f'  python3 scripts/cosechar-oficiales.py --diagnostico {sospechosos[0][0]}')
        print('y ajusta --ventana si las filas se parten en más líneas.')

    utiles = {k: v for k, v in total.items() if k in idx}

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
    print(f'  de esos, en nuestra base de básica: {len(utiles)} '
          f'({len(utiles) * 100 // max(len(idx), 1)}% de {len(idx)})')
    print(f'  con correo: {con_mail}')
    print(f'\n-> {salida}')
    print('\nSiguiente paso:')
    print('  node firebase/actualizar-contactos.mjs --admin '
          '--csv datos/contactos-oficiales.csv')


if __name__ == '__main__':
    main()
