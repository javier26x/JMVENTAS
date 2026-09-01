#!/usr/bin/env python3
# ============================================================
# JUMP Math Chile - Enriquecimiento de contactos institucionales
#
# Toma prospectos_jumpmath.csv, busca el sitio web de cada colegio,
# entra a la home y a las rutas tipicas de contacto, y extrae
# correos y telefonos publicos.
#
# Resumible: se puede cortar y relanzar, no repite lo ya resuelto.
#
#   pip install --break-system-packages requests beautifulsoup4 pandas
#   python3 enriquecer-contactos.py --tier "1 · FACIL" --limite 400
#
# Modos utiles:
#   --canal "A · Directo Privado"   solo particular pagado (sin ATE, cierre rapido)
#   --por-sostenedor                un registro por RUT, no por colegio (venta de red)
#   --dry-run                       muestra a quien consultaria y sale
# ============================================================
import argparse, os, re, sys, time, random
from urllib.parse import urlparse, urljoin, parse_qs, unquote

import pandas as pd
import requests
from bs4 import BeautifulSoup

CSV_DEFECTO = os.path.expanduser('~/jumpmath/out/prospectos_jumpmath.csv')
UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124 Safari/537.36')
HDRS = {'User-Agent': UA, 'Accept-Language': 'es-CL,es;q=0.9'}
PAUSA = (2.5, 5.0)          # segundos entre requests: se educado, no te bloquean

SALIDA = None          # se resuelve en main(), nunca es el archivo de entrada

RE_MAIL = re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')

# Telefono chileno: +56 2 2345 6789 (fijo Santiago) / +56 9 8765 4321 (movil)
# / 45 2293800 (fijo regional). Exige prefijo +56, parentesis o separadores
# reales para no capturar numeros sueltos de 8 digitos (fechas, RBD, precios).
RE_TEL = re.compile(r"""
    (?:
        \+?\s?56[\s.\-]?\(?\d{1,2}\)?[\s.\-]?\d{3,4}[\s.\-]?\d{4}   # con codigo pais
      | \(\s?\d{2,3}\s?\)[\s.\-]?\d{3,4}[\s.\-]?\d{4}               # (2) 2345 6789
      | \b(?:fono|tel[eé]fono|tel|celular|m[oó]vil)\s*[:.]?\s*
        \+?\d[\d\s.\-()]{7,15}\d                                     # precedido de etiqueta
    )
""", re.IGNORECASE | re.VERBOSE)

BASURA_MAIL = ('wixpress', 'sentry', 'example.com', 'domain.com', 'godaddy',
               'squarespace', 'wordpress.org', '.png', '.jpg', '.jpeg', '.webp',
               '.gif', '.svg', 'no-reply', 'noreply')
AGREGADORES = ('facebook', 'instagram', 'linkedin', 'youtube', 'twitter', 'x.com',
               'tiktok', 'mineduc', 'wikipedia', 'yelp', 'paginasamarillas',
               'amarillas', 'emol', 'duckduckgo', 'google', 'bing', 'mercantil',
               'dateas', 'micole', 'infoescuelas', 'losmejorescolegios',
               'colegiosdechile', 'escuelasdechile', 'scribd', 'trabajando',
               'profejobs', 'rocketreach', 'lusha', 'datanyze')

RUTAS = ('', '/contacto', '/contacto/', '/contactenos', '/contactanos',
         '/admision', '/admisiones', '/nosotros', '/quienes-somos')


def _desenvolver(href: str) -> str:
    """DuckDuckGo entrega //duckduckgo.com/l/?uddg=<url-encoded>.
    Sin desenvolverlo, el filtro de agregadores descarta TODOS los
    resultados y la busqueda devuelve siempre vacio."""
    if not href:
        return ''
    if href.startswith('//'):
        href = 'https:' + href
    p = urlparse(href)
    if 'duckduckgo.com' in p.netloc and p.path.startswith('/l'):
        destino = parse_qs(p.query).get('uddg', [''])[0]
        if destino:
            return unquote(destino)
    return href


# Cuantas busquedas seguidas pueden fallar antes de rendirse. Si el
# buscador corta el grifo, "no encontre el sitio" y "me estan bloqueando"
# se ven exactamente igual desde aca, y seguir significaria marcar miles
# de colegios como "sin web" cuando si la tienen. Mejor parar y avisar.
LIMITE_FALLOS = 8
fallos_seguidos = 0


def buscar_sitio(consulta: str, sess: requests.Session) -> str:
    """Primer resultado organico que no sea agregador ni red social."""
    global fallos_seguidos
    try:
        r = sess.post('https://html.duckduckgo.com/html/',
                      data={'q': consulta}, headers=HDRS, timeout=25)
        # 202 y las paginas con "anomaly" son la forma en que DuckDuckGo
        # dice que le estas pidiendo demasiado rapido.
        if r.status_code != 200 or 'anomaly' in r.text.lower():
            fallos_seguidos += 1
            print(f'   ! buscador rechaza la consulta (HTTP {r.status_code})')
            time.sleep(random.uniform(8, 15))
            return ''
        soup = BeautifulSoup(r.text, 'html.parser')
        # varios selectores: el markup de DDG cambia cada cierto tiempo
        anclas = (soup.select('a.result__a')
                  or soup.select('h2 a')
                  or soup.select('a[href*="uddg="]'))
        for a in anclas:
            url = _desenvolver(a.get('href', ''))
            p = urlparse(url)
            dom = p.netloc.lower()
            if not dom or not p.scheme.startswith('http'):
                continue
            if any(x in dom for x in AGREGADORES):
                continue
            fallos_seguidos = 0        # respondio de verdad
            return f'{p.scheme}://{dom}'
        # Respuesta valida pero sin resultados utiles: no es un bloqueo.
        fallos_seguidos = 0
    except Exception as e:
        fallos_seguidos += 1
        print(f'   ! busqueda: {e}')
    return ''


def _limpiar_tel(bruto: str) -> str:
    d = re.sub(r'\D', '', bruto)
    if d.startswith('56'):
        d = d[2:]
    if len(d) == 9 and d[0] == '9':          # movil
        return f'+56 9 {d[1:5]} {d[5:]}'
    if len(d) == 9:                          # fijo con codigo de area de 1 digito
        return f'+56 {d[0]} {d[1:5]} {d[5:]}'
    if len(d) == 8:                          # fijo sin codigo de area
        return f'{d[:4]} {d[4:]}'
    if 9 < len(d) <= 11:
        return f'+56 {d[-9:-8]} {d[-8:-4]} {d[-4:]}'
    return ''


def raspar(sitio: str, sess: requests.Session):
    """Home + rutas tipicas de contacto. Devuelve (correos, telefonos)."""
    mails, tels = set(), set()
    dominio = urlparse(sitio).netloc.lower().replace('www.', '')
    for ruta in RUTAS:
        try:
            r = sess.get(urljoin(sitio, ruta), headers=HDRS, timeout=25)
            if r.status_code != 200:
                continue
            soup = BeautifulSoup(r.text, 'html.parser')

            # mailto: es la fuente mas confiable
            for a in soup.select('a[href^="mailto:"]'):
                m = a['href'][7:].split('?')[0].strip().lower()
                if m and not any(b in m for b in BASURA_MAIL):
                    mails.add(m)
            for m in RE_MAIL.findall(r.text):
                m = m.lower()
                if not any(b in m for b in BASURA_MAIL):
                    mails.add(m)

            texto = soup.get_text(' ')
            for a in soup.select('a[href^="tel:"]'):
                t = _limpiar_tel(a['href'][4:])
                if t:
                    tels.add(t)
            for t in RE_TEL.findall(texto):
                t = _limpiar_tel(t)
                if t:
                    tels.add(t)
        except Exception:
            pass
        time.sleep(random.uniform(*PAUSA))
        if mails and tels:
            break

    # prioriza correos del dominio propio del colegio sobre gmail/hotmail
    propios = sorted(m for m in mails if dominio and dominio in m.split('@')[-1])
    otros = sorted(m for m in mails if m not in propios)
    return (propios + otros)[:3], sorted(tels)[:2]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', default=CSV_DEFECTO,
                    help='base de entrada; NO se modifica')
    ap.add_argument('--salida', default=None,
                    help='dónde escribir el resultado. Por defecto, junto a la '
                         'entrada con sufijo -contactos, que además queda '
                         'cubierto por .gitignore. Si ya existe, se retoma.')
    ap.add_argument('--tier', default='1 · FACIL',
                    help='"todos" para no filtrar por tier')
    ap.add_argument('--particion', default=None, metavar='N/M',
                    help='procesa sólo una de M partes (N empieza en 0). '
                         'Permite correr M procesos a la vez sobre dominios '
                         'distintos, cada uno con su propia --salida.')
    ap.add_argument('--canal', default=None, help='filtra por CANAL exacto')
    ap.add_argument('--limite', type=int, default=200)
    ap.add_argument('--por-sostenedor', action='store_true',
                    help='un registro por RUT de sostenedor (venta de red)')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    if not os.path.exists(a.csv):
        sys.exit(f'No existe {a.csv}. Corre primero build-prospectos.sh')

    # La salida por defecto lleva sufijo -contactos, que .gitignore ya
    # cubre: leer y escribir el mismo archivo era la forma facil de
    # publicar 8.000 correos en el repo sin notarlo.
    global SALIDA
    if a.salida:
        SALIDA = a.salida
    else:
        raiz, ext = os.path.splitext(a.csv)
        SALIDA = f'{raiz}-contactos{ext or ".csv"}'

    # Se retoma de la salida si ya existe: asi una corrida cortada no
    # empieza de cero ni pierde lo cosechado.
    fuente = SALIDA if os.path.exists(SALIDA) else a.csv
    print(f'entrada: {fuente}')
    print(f'salida : {SALIDA}')
    df = pd.read_csv(fuente, dtype=str, encoding='utf-8-sig').fillna('')
    for col in ('EMAIL', 'TELEFONO', 'WEB', 'CONTACTO', 'ESTADO_CRM'):
        if col not in df.columns:
            df[col] = ''

    sel = (df.TIER == a.tier) if a.tier.lower() != 'todos' else (df.TIER == df.TIER)
    if a.canal:
        sel &= df.CANAL == a.canal
    obj = df[sel]

    if a.particion:
        # Repartir por posicion y no por tier: los tramos quedan del mismo
        # tamano y, sobre todo, cada proceso toca dominios distintos. La
        # pausa entre peticiones existe para no golpear un sitio repetido,
        # no para espaciar visitas a 7.808 servidores que no se conocen
        # entre si, asi que paralelizar aqui no es menos educado.
        try:
            cual, cuantas = (int(x) for x in a.particion.split('/'))
        except ValueError:
            print('--particion se escribe N/M, por ejemplo 0/8')
            return
        if not 0 <= cual < cuantas:
            print(f'--particion {a.particion}: N debe ir de 0 a {cuantas - 1}')
            return
        obj = obj.iloc[cual::cuantas]
        print(f'Particion {cual + 1} de {cuantas}')

    # Se descarta a los ya resueltos DESPUES de partir. Al reves, cada
    # relanzamiento trocearia un conjunto mas chico y a cada proceso le
    # tocarian colegios distintos: dos se pisarian y a otros no iria nadie.
    obj = obj[obj.EMAIL == '']

    if a.por_sostenedor:
        # un colegio representante por red: el de mayor matricula
        obj = obj.assign(_m=pd.to_numeric(obj.MAT_BASICA, errors='coerce').fillna(0)) \
                 .sort_values('_m', ascending=False) \
                 .drop_duplicates(subset=['RUT_SOSTENEDOR'])
    obj = obj.head(a.limite)

    print(f'Objetivo: {len(obj)} registros | tier={a.tier} '
          f'canal={a.canal or "todos"} por_sostenedor={a.por_sostenedor}\n')
    if a.dry_run:
        print(obj[['RBD', 'ESTABLECIMIENTO', 'COMUNA', 'MAT_BASICA']].to_string(index=False))
        return

    sess = requests.Session()
    ok = 0
    for n, (idx, row) in enumerate(obj.iterrows(), 1):
        print(f'[{n}/{len(obj)}] {row.ESTABLECIMIENTO} ({row.COMUNA})')
        if fallos_seguidos >= LIMITE_FALLOS:
            print(f'\n  DETENIDO: {LIMITE_FALLOS} busquedas seguidas fallaron.')
            print('  El buscador esta bloqueando esta IP. Baja el numero de')
            print('  procesos en paralelo, espera un rato y relanza: lo hecho')
            print('  se conserva y se retoma donde iba.')
            break
        sitio = row.WEB or buscar_sitio(
            row.BUSQUEDA_WEB or f'{row.ESTABLECIMIENTO} {row.COMUNA} colegio Chile sitio oficial',
            sess)
        if not sitio:
            df.at[idx, 'ESTADO_CRM'] = 'sin_web'
            print('    sin sitio identificable')
            time.sleep(random.uniform(*PAUSA))
            continue

        mails, tels = raspar(sitio, sess)
        df.at[idx, 'WEB'] = sitio
        df.at[idx, 'EMAIL'] = '; '.join(mails)
        df.at[idx, 'TELEFONO'] = '; '.join(tels)
        df.at[idx, 'ESTADO_CRM'] = 'contacto_ok' if mails else 'web_sin_mail'
        ok += bool(mails)
        print(f'    {sitio} -> {mails or "-"} | {tels or "-"}')

        if n % 10 == 0:
            df.to_csv(SALIDA, index=False, encoding='utf-8-sig')
            print(f'    [guardado parcial: {ok}/{n} con correo]')
        time.sleep(random.uniform(*PAUSA))

    df.to_csv(SALIDA, index=False, encoding='utf-8-sig')
    con_mail = (df.EMAIL != '').sum()
    print(f'\nListo. Esta corrida: {ok}/{len(obj)} con correo.')
    print(f'Base completa: {con_mail} de {len(df)} con correo.')


if __name__ == '__main__':
    main()
