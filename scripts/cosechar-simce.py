#!/usr/bin/env python3
# ============================================================
# JUMP Math Chile - SIMCE Matemática y Categoría de Desempeño
#
# Convierte la base de "lista de colegios" en "colegios con problema de
# matemática documentado", que es lo que hace que un correo frío tenga
# respuesta: un establecimiento en categoría Insuficiente tiene la
# obligación legal de mejorar y presupuesto SEP para hacerlo.
#
#   pip install --break-system-packages requests beautifulsoup4 pandas openpyxl
#
#   python3 scripts/cosechar-simce.py --descubrir     # ver qué hay publicado
#   python3 scripts/cosechar-simce.py --url <enlace>  # bajar y cruzar
#
# Salida: datos/simce-matematica.csv
#   (RBD, SIMCE_MATE, SIMCE_ANIO, CATEGORIA, DOLOR, FUENTE)
#
# Descubre los enlaces desde el portal en vez de suponerlos: los nombres
# de archivo de la Agencia cambian cada año y adivinarlos produce
# silencio o, peor, datos cruzados mal.
# ============================================================
import argparse
import csv
import io
import os
import re
import sys
import zipfile

import requests

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATOS = os.path.join(RAIZ, 'datos')
CACHE = os.path.join(RAIZ, '.cache-simce')

UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124 Safari/537.36')
HDRS = {'User-Agent': UA, 'Accept-Language': 'es-CL,es;q=0.9'}

PORTALES = [
    'https://informacionestadistica.agenciaeducacion.cl/',
    'https://bases-nat.agenciaeducacion.cl/',
    'https://www.agenciaeducacion.cl/simce/',
    'https://www.agenciaeducacion.cl/categoria-de-desempeno/',
]
EXTENSIONES = ('.zip', '.rar', '.csv', '.xlsx', '.xls', '.7z')

# Categoría de Desempeño: la clasificación legal. Un establecimiento
# Insuficiente está obligado a mejorar y tiene plata SEP para hacerlo.
DOLOR_CATEGORIA = {
    'insuficiente': 100,
    'medio-bajo': 75, 'medio bajo': 75, 'mediobajo': 75,
    'medio': 45,
    'alto': 10,
}
# Promedio nacional 4º básico ronda los 250 puntos; bajo 210 es crítico.
SIMCE_TECHO, SIMCE_PISO = 265, 205


def descubrir():
    """Lista enlaces a archivos de datos publicados en los portales."""
    from bs4 import BeautifulSoup
    from urllib.parse import urljoin

    vistos = {}
    for portal in PORTALES:
        try:
            r = requests.get(portal, headers=HDRS, timeout=40)
        except Exception as e:
            print(f'  ! {portal}: {e}')
            continue
        if r.status_code != 200:
            print(f'  ! {portal}: HTTP {r.status_code}')
            continue
        soup = BeautifulSoup(r.text, 'html.parser')
        n = 0
        for a in soup.find_all('a', href=True):
            url = urljoin(portal, a['href'])
            if url.lower().split('?')[0].endswith(EXTENSIONES) and url not in vistos:
                vistos[url] = ' '.join(a.get_text(' ').split())[:80]
                n += 1
        print(f'  {portal}: {n} archivos de datos')
    return vistos


def bajar(url):
    os.makedirs(CACHE, exist_ok=True)
    nombre = re.sub(r'[^A-Za-z0-9._-]', '_', url.split('/')[-1].split('?')[0]) or 'descarga'
    destino = os.path.join(CACHE, nombre)
    if os.path.exists(destino) and os.path.getsize(destino) > 2000:
        print(f'  [cache] {nombre}')
        return destino
    print(f'  bajando {url}')
    r = requests.get(url, headers=HDRS, timeout=180)
    r.raise_for_status()
    tmp = destino + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(r.content)
    os.replace(tmp, destino)
    print(f'  -> {nombre} ({os.path.getsize(destino) // 1024} KB)')
    return destino


def tablas_de(ruta):
    """Devuelve DataFrames desde csv/xlsx, incluidos los que vengan en zip."""
    import pandas as pd

    def leer(buf, nombre):
        try:
            if nombre.lower().endswith(('.xlsx', '.xls')):
                return list(pd.read_excel(buf, sheet_name=None, dtype=str).values())
            for sep in (';', ',', '\t'):
                buf.seek(0)
                d = pd.read_csv(buf, sep=sep, dtype=str, encoding='latin-1',
                                on_bad_lines='skip', low_memory=False)
                if len(d.columns) > 2:
                    return [d]
        except Exception as e:
            print(f'    ! {nombre}: {e}')
        return []

    if ruta.lower().endswith('.zip'):
        salida = []
        with zipfile.ZipFile(ruta) as z:
            for n in z.namelist():
                if n.lower().endswith(('.csv', '.xlsx', '.xls')):
                    salida += leer(io.BytesIO(z.read(n)), n)
        return salida
    if ruta.lower().endswith('.rar'):
        sys.exit('Archivo .rar: descomprímelo antes.\n'
                 '  sudo apt-get install -y unrar-free && unrar-free -x <archivo>')
    with open(ruta, 'rb') as f:
        return leer(io.BytesIO(f.read()), ruta)


def columna(d, *patrones):
    for p in patrones:
        for c in d.columns:
            if re.search(p, str(c), re.I):
                return c
    return None


def dolor(cat, puntaje):
    """0-100: cuánto duele la matemática en ese establecimiento."""
    partes = []
    if cat:
        clave = re.sub(r'\s+', ' ', str(cat).strip().lower())
        for k, v in DOLOR_CATEGORIA.items():
            if clave.startswith(k):
                partes.append((v, 2))       # la categoría pesa doble: es la legal
                break
    if puntaje is not None:
        p = max(0, min(100, (SIMCE_TECHO - puntaje) / (SIMCE_TECHO - SIMCE_PISO) * 100))
        partes.append((p, 1))
    if not partes:
        return None
    return round(sum(v * w for v, w in partes) / sum(w for _, w in partes))


def indice_base():
    ruta = os.path.join(DATOS, 'prospectos_jumpmath.csv')
    if not os.path.exists(ruta):
        sys.exit(f'Falta {ruta}. Corre antes build-prospectos.sh')
    with open(ruta, encoding='utf-8-sig', newline='') as f:
        return {int(r['RBD']) for r in csv.DictReader(f) if r['RBD'].isdigit()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--descubrir', action='store_true')
    ap.add_argument('--url', action='append', default=[],
                    help='enlace a una base publicada (repetible)')
    ap.add_argument('--archivo', action='append', default=[],
                    help='archivo ya descargado (repetible)')
    ap.add_argument('--salida', default=os.path.join(DATOS, 'simce-matematica.csv'))
    a = ap.parse_args()

    if a.descubrir or (not a.url and not a.archivo):
        print('Buscando bases publicadas…\n')
        enlaces = descubrir()
        if not enlaces:
            print('\nNo se encontraron archivos de datos enlazados.')
            print('Baja la base a mano desde informacionestadistica.agenciaeducacion.cl')
            print('y pásala con --archivo <ruta>.')
            return
        print(f'\n{len(enlaces)} archivos encontrados:\n')
        for u, txt in enlaces.items():
            print(f'  {u}')
            if txt:
                print(f'      {txt}')
        print('\nElige las de Simce por establecimiento y Categoría de Desempeño:')
        print('  python3 scripts/cosechar-simce.py --url <enlace> --url <otro>')
        return

    base = indice_base()
    print(f'Base MINEDUC: {len(base)} establecimientos con básica regular\n')

    rutas = list(a.archivo)
    for u in a.url:
        try:
            rutas.append(bajar(u))
        except Exception as e:
            print(f'  ! {u}: {e}')

    filas = {}
    for ruta in rutas:
        print(f'\nLeyendo {os.path.basename(ruta)}')
        for d in tablas_de(ruta):
            col_rbd = columna(d, r'^rbd$', r'\brbd\b')
            if not col_rbd:
                continue
            # 4º básico es el nivel donde JUMP Math tiene producto
            col_mate = columna(d, r'mate.*4b|4b.*mate', r'prom.*mate', r'matem')
            col_cat = columna(d, r'categor')
            col_anio = columna(d, r'^a[gñn]o|periodo|year')
            if not col_mate and not col_cat:
                continue
            print(f'  columnas: rbd={col_rbd} mate={col_mate} categoria={col_cat}')

            for _, r in d.iterrows():
                try:
                    rbd = int(float(str(r[col_rbd]).strip()))
                except (ValueError, TypeError):
                    continue
                if rbd not in base:
                    continue
                f = filas.setdefault(rbd, {'mate': None, 'anio': None,
                                           'cat': None, 'fuentes': set()})
                if col_mate:
                    try:
                        v = float(str(r[col_mate]).replace(',', '.'))
                        if 100 <= v <= 400:
                            f['mate'] = v
                    except (ValueError, TypeError):
                        pass
                if col_cat and str(r[col_cat]).strip() not in ('', 'nan'):
                    f['cat'] = str(r[col_cat]).strip()
                if col_anio:
                    try:
                        f['anio'] = int(float(str(r[col_anio])))
                    except (ValueError, TypeError):
                        pass
                f['fuentes'].add(os.path.basename(ruta))

    if not filas:
        print('\nNo se pudo extraer ningún RBD con datos de matemática.')
        print('Revisa las columnas del archivo y vuelve a intentar.')
        return

    os.makedirs(DATOS, exist_ok=True)
    tmp = a.salida + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['RBD', 'SIMCE_MATE', 'SIMCE_ANIO', 'CATEGORIA', 'DOLOR', 'FUENTE'])
        for rbd in sorted(filas):
            v = filas[rbd]
            w.writerow([rbd, v['mate'] or '', v['anio'] or '', v['cat'] or '',
                        dolor(v['cat'], v['mate']) or '', '; '.join(sorted(v['fuentes'])[:2])])
    os.replace(tmp, a.salida)

    con_mate = sum(1 for v in filas.values() if v['mate'] is not None)
    con_cat = sum(1 for v in filas.values() if v['cat'])
    print(f'\nEstablecimientos cruzados: {len(filas)} ({len(filas) * 100 // len(base)}% de la base)')
    print(f'  con puntaje de matemática: {con_mate}')
    print(f'  con categoría de desempeño: {con_cat}')
    print(f'\n-> {a.salida}')
    print('\nSiguiente paso:')
    print('  node firebase/actualizar-contactos.mjs --admin '
          '--csv datos/simce-matematica.csv --fuente simce')


if __name__ == '__main__':
    main()
