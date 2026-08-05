#!/usr/bin/env python3
# ============================================================
# JUMP Math Chile - SIMCE Matemática y Categoría de Desempeño
#
# Convierte la base de "lista de colegios" en "colegios con problema de
# matemática documentado", que es lo que hace que un correo frío tenga
# respuesta: un establecimiento en categoría Insuficiente tiene la
# obligación legal de mejorar y presupuesto SEP para hacerlo.
#
#   pip install --break-system-packages requests beautifulsoup4 pandas openpyxl ijson
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
import json
import os
import re
import shutil
import subprocess
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


TABULARES = ('.csv', '.xlsx', '.xls', '.txt', '.tsv', '.dat', '.jsonld', '.json')
# Sobre este tamaño no se arma un DataFrame: se recorre en streaming.
LIMITE_MEMORIA = 50 * 1024 * 1024


def _plano(v):
    """Aplana un valor JSON-LD: {'@value': x}, listas, nodos anidados."""
    if isinstance(v, dict):
        return v.get('@value', v.get('@id', ''))
    if isinstance(v, list):
        return '; '.join(str(_plano(x)) for x in v[:3])
    return v


def leer_jsonld(buf, nombre):
    """JSON-LD -> DataFrame, un nodo por fila.

    La Agencia publica el Simce como datos enlazados (RDF), no como
    planilla. Se aplanan los nodos del @graph y se acortan las claves a
    su último segmento, que es lo que deja los nombres reconocibles
    (…/schema#rbd -> rbd).
    """
    import pandas as pd
    try:
        data = json.load(buf)
    except Exception as e:
        print(f'    ! {nombre}: {e}')
        return []
    nodos = data.get('@graph') if isinstance(data, dict) else data
    if nodos is None:
        nodos = [data] if isinstance(data, dict) else []
    filas = []
    for n in nodos:
        if not isinstance(n, dict):
            continue
        fila = {}
        for k, v in n.items():
            if k.startswith('@') and k != '@type':
                continue
            clave = re.split(r'[/#]', str(k))[-1]
            fila[clave] = _plano(v)
        if fila:
            filas.append(fila)
    if not filas:
        return []
    return [pd.DataFrame(filas).astype(str)]


def rbd_de(valor):
    """El establecimiento viene como referencia RDF, no como número."""
    m = re.search(r'(\d{1,6})\s*$', str(valor or '').strip().rstrip('/'))
    if not m:
        return None
    n = int(m.group(1))
    return n if 1 <= n <= 60000 else None


def es_cuarto_basico(grado):
    """4B, 4° básico, 04 -> sí. 8B, II medio -> no."""
    g = str(grado or '')
    return bool(re.search(r'(^|\D)0?4(\D|$)', g)) if g else True


def extraer_jsonld_stream(ruta, base, filas, fuente):
    """Recorre el JSON-LD sin cargarlo entero.

    La base de establecimientos son 366 MB de RDF: json.load la
    convertiría en varios GB de objetos Python y voltea la máquina.
    ijson la recorre nodo a nodo con memoria constante.

    Devuelve None si no hay ijson, para que el llamador decida.
    """
    try:
        import ijson
    except ImportError:
        return None

    vistos = leidos = 0
    with open(ruta, 'rb') as f:
        for nodo in ijson.items(f, '@graph.item'):
            if not isinstance(nodo, dict):
                continue
            leidos += 1
            campos = {re.split(r'[/#]', str(k))[-1]: _plano(v)
                      for k, v in nodo.items() if not k.startswith('@')}

            if 'matem' not in str(campos.get('asignatura', '')).lower():
                continue
            if not es_cuarto_basico(campos.get('grado')):
                continue
            rbd = rbd_de(campos.get('establecimiento') or campos.get('rbd'))
            if rbd is None or rbd not in base:
                continue

            try:
                prom = float(str(campos.get('prom', '')).replace(',', '.'))
            except (ValueError, TypeError):
                continue
            if not 100 <= prom <= 400:
                continue
            try:
                anio = int(float(str(campos.get('anio', 0))))
            except (ValueError, TypeError):
                anio = 0

            f_ = filas.setdefault(rbd, {'mate': None, 'anio': None,
                                        'cat': None, 'fuentes': set()})
            # Puede haber varios años por establecimiento: gana el último.
            if f_['anio'] is None or anio >= f_['anio']:
                f_['mate'], f_['anio'] = prom, anio or None
            f_['fuentes'].add(fuente)
            vistos += 1

    print(f'    {leidos} nodos recorridos, {vistos} de matemática 4º básico '
          f'cruzados con la base')
    return len(filas)


def leer_tabla(buf, nombre):
    """Un DataFrame por hoja/archivo, probando separadores y codificaciones."""
    import pandas as pd
    if nombre.lower().endswith(('.jsonld', '.json')):
        return leer_jsonld(buf, nombre)
    try:
        if nombre.lower().endswith(('.xlsx', '.xls')):
            return list(pd.read_excel(buf, sheet_name=None, dtype=str).values())
        mejor = None
        for cod in ('utf-8', 'latin-1'):
            for sep in (';', ',', '\t', '|'):
                buf.seek(0)
                try:
                    d = pd.read_csv(buf, sep=sep, dtype=str, encoding=cod,
                                    on_bad_lines='skip', low_memory=False)
                except Exception:
                    continue
                # Con el separador equivocado sale una sola columna gigante:
                # se queda el que más columnas produce.
                if len(d.columns) > 2 and (mejor is None or len(d.columns) > len(mejor.columns)):
                    mejor = d
        return [mejor] if mejor is not None else []
    except Exception as e:
        print(f'    ! {nombre}: {e}')
        return []


# El paquete de la Agencia es un zip que contiene .rar. Python no lee
# rar, así que hace falta una herramienta externa; se prueban varias
# porque unrar-free falla con RAR5, que es el formato actual.
DESCOMPRESORES = (
    ('unar', ['unar', '-q', '-f', '-o']),
    ('7z', ['7z', 'x', '-y', '-o']),
    ('7za', ['7za', 'x', '-y', '-o']),
    ('bsdtar', ['bsdtar', '-xf']),
    ('unrar', ['unrar', 'x', '-y']),
    ('unrar-free', ['unrar-free', '-x']),
)


def extraer_rar(ruta, destino):
    """Devuelve True si alguna herramienta disponible logró extraerlo."""
    os.makedirs(destino, exist_ok=True)
    for nombre, base in DESCOMPRESORES:
        if not shutil.which(nombre):
            continue
        if nombre in ('7z', '7za'):
            cmd = base[:-1] + [f'-o{destino}', ruta]
        elif nombre == 'unar':
            cmd = base + [destino, ruta]
        elif nombre == 'bsdtar':
            cmd = base + [ruta, '-C', destino]
        else:
            cmd = base + [ruta, destino]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=600)
        except Exception:
            continue
        if r.returncode == 0 and any(os.scandir(destino)):
            print(f'    extraído con {nombre}')
            return True
        print(f'    {nombre} no pudo: {r.stderr.decode("utf-8", "ignore").strip()[:120]}')
    return False


def explorar(ruta, prefijo='', omitir=None, nivel=0, grandes=None):
    """(tablas, manifiesto), entrando a zip y rar anidados.

    Los archivos que no caben en memoria se apartan en `grandes` para
    recorrerlos en streaming."""
    tablas, manifiesto = [], []
    if grandes is None:
        grandes = []
    bajo = ruta.lower()
    nombre = os.path.basename(ruta)

    if omitir and omitir.search(nombre):
        manifiesto.append(f'{prefijo}{nombre}  [omitido]')
        return tablas, manifiesto
    if nivel > 4:
        return tablas, manifiesto

    trabajo = os.path.join(CACHE, 'extraido', re.sub(r'[^A-Za-z0-9._-]', '_', nombre))

    if bajo.endswith('.zip'):
        os.makedirs(trabajo, exist_ok=True)
        try:
            with zipfile.ZipFile(ruta) as z:
                z.extractall(trabajo)
        except Exception as e:
            print(f'    ! {nombre}: {e}')
            return tablas, manifiesto
    elif bajo.endswith(('.rar', '.7z')):
        if not os.path.isdir(trabajo) or not any(os.scandir(trabajo)):
            print(f'  descomprimiendo {nombre}')
            if not extraer_rar(ruta, trabajo):
                manifiesto.append(f'{prefijo}{nombre}  [sin descompresor]')
                print('\n  Falta una herramienta que lea .rar. Instala una:')
                print('    sudo apt-get install -y unar          # recomendada: lee RAR5')
                print('    sudo apt-get install -y p7zip-rar     # alternativa')
                return tablas, manifiesto
    elif bajo.endswith(TABULARES):
        tam = os.path.getsize(ruta)
        manifiesto.append(f'{prefijo}{nombre}  ({tam // 1024} KB)')
        if tam > LIMITE_MEMORIA and bajo.endswith(('.jsonld', '.json')):
            grandes.append(ruta)
            print(f'    {nombre}: {tam // 1024 // 1024} MB, se recorre en streaming')
            return tablas, manifiesto
        with open(ruta, 'rb') as f:
            return leer_tabla(io.BytesIO(f.read()), nombre), manifiesto
    else:
        manifiesto.append(f'{prefijo}{nombre}  [no tabular]')
        return tablas, manifiesto

    manifiesto.append(f'{prefijo}{nombre}/')
    for raiz, _, archivos in os.walk(trabajo):
        for f in sorted(archivos):
            t, m = explorar(os.path.join(raiz, f), prefijo + '  ', omitir,
                            nivel + 1, grandes)
            tablas += t
            manifiesto += m
    return tablas, manifiesto


def tablas_de(ruta, omitir=None):
    """Devuelve (DataFrames, manifiesto, archivos para streaming)."""
    grandes = []
    tablas, manifiesto = explorar(ruta, omitir=omitir, grandes=grandes)
    return tablas, manifiesto, grandes


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
    ap.add_argument('--incluir-idps', action='store_true',
                    help='procesa también IDPS (59 MB de indicadores '
                         'socioemocionales, no aportan a matemática)')
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
    manifiestos = []
    for ruta in rutas:
        print(f'\nLeyendo {os.path.basename(ruta)}')
        omitir = None if a.incluir_idps else re.compile(r'idps', re.I)
        tablas, manifiesto, grandes = tablas_de(ruta, omitir)
        manifiestos += manifiesto
        print(f'  {len(manifiesto)} archivos dentro, {len(tablas)} tablas legibles'
              + (f', {len(grandes)} en streaming' if grandes else ''))

        for g in grandes:
            print(f'  recorriendo {os.path.basename(g)}')
            if extraer_jsonld_stream(g, base, filas, os.path.basename(g)) is None:
                print('    ! falta ijson para leerlo sin agotar la memoria:')
                print('      pip install --break-system-packages ijson')
        for d in tablas:
            col_rbd = columna(d, r'^rbd$', r'\brbd\b', r'establecimiento', r'cod.*ee')
            if not col_rbd:
                print(f'    (sin columna RBD) columnas: {list(d.columns)[:12]}')
                continue
            # 4º básico es el nivel donde JUMP Math tiene producto
            col_mate = columna(d, r'mate.*4b|4b.*mate', r'prom.*mate', r'matem')
            col_cat = columna(d, r'categor')
            col_anio = columna(d, r'^a[gñn]o|periodo|year')

            # Formato largo: la asignatura es un VALOR, no una columna.
            # Es la forma en que exporta un data warehouse (una fila por
            # establecimiento × prueba), y buscar una columna "mate" ahí
            # no encuentra nada aunque el dato esté.
            if not col_mate:
                col_asig = next(
                    (c for c in d.columns
                     if d[c].astype(str).str.contains('matem', case=False, na=False).any()),
                    None)
                col_valor = columna(d, r'promedio|puntaje|prom|valor|score')
                if col_asig and col_valor:
                    antes = len(d)
                    d = d[d[col_asig].astype(str).str.contains('matem', case=False, na=False)]
                    col_mate = col_valor
                    print(f'  formato largo: {col_asig} contiene la asignatura, '
                          f'{antes} filas -> {len(d)} de matemática')
                    # Si además distingue el grado, quedarse con 4º básico
                    col_grado = next(
                        (c for c in d.columns
                         if d[c].astype(str).str.contains(r'\b4', regex=True, na=False).any()
                         and re.search(r'grado|curso|nivel|grad', str(c), re.I)),
                        None)
                    if col_grado:
                        d4 = d[d[col_grado].astype(str).str.contains(r'4', na=False)]
                        if len(d4):
                            d = d4
                            print(f'  filtrado a 4º básico por {col_grado}: {len(d)} filas')

            if not col_mate and not col_cat:
                print(f'    (sin matemática ni categoría) columnas: {list(d.columns)[:14]}')
                if len(d):
                    print(f'    ejemplo: {d.iloc[0].to_dict()}')
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
        if manifiestos:
            print(f'\nContenido de lo descargado ({len(manifiestos)} archivos):')
            for m in manifiestos[:60]:
                print(f'  {m}')
            if len(manifiestos) > 60:
                print(f'  … y {len(manifiestos) - 60} más')
            print('\nSi los datos vienen en un formato que pandas no lee '
                  '(.sav, .dta, .sas7bdat),')
            print('conviértelos o pídeme el lector que corresponda.')
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
