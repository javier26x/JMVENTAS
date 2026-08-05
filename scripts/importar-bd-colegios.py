#!/usr/bin/env python3
# ============================================================
# JUMP Math Chile - Importa una base externa de colegios
#
# Cruza por RBD una planilla de contactos contra la base MINEDUC y deja
# un CSV listo para cargar. Verifica cada cruce contra el nombre oficial
# del establecimiento: un RBD que coincide numéricamente pero apunta a
# otro colegio se descarta, no se importa.
#
#   pip install --break-system-packages pandas openpyxl
#   python3 scripts/importar-bd-colegios.py --xlsx BD_Colegios_de_Chile_2020.xlsx
#
# Salida: datos/contactos-importados.csv
#         (RBD, EMAIL, TELEFONO, WEB, CONTACTO, FUENTE)
# ============================================================
import argparse
import csv
import os
import re
import sys
import unicodedata

import pandas as pd

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATOS = os.path.join(RAIZ, 'datos')

VACIAS = {'colegio', 'escuela', 'liceo', 'centro', 'educacional', 'particular',
          'basica', 'complejo', 'instituto', 'anexo', 'subvencionado',
          'municipal', 'del', 'las', 'los', 'san', 'santa'}

GENERICOS = ('gmail.', 'hotmail.', 'yahoo.', 'outlook.', 'live.', 'vtr.net',
             'terra.', 'msn.', 'icloud.')

# Quién decide la compra de un programa de matemática, en orden.
ROLES_BUENOS = ('direccion', 'rectoria', 'rector', 'director', 'sostenedor',
                'admision', 'contacto', 'secretaria', 'colegio', 'escuela',
                'info', 'utp', 'jefeutp', 'administracion', 'gerencia')
# Existen, pero no compran: no deben quedar como contacto principal.
ROLES_MALOS = ('centrodealumnos', 'centro.alumnos', 'ceal', 'cea', 'alumnos',
               'apoderados', 'centropadres', 'biblioteca', 'convivencia',
               'convivenciaescolar', 'enfermeria', 'pie', 'psicologa')

RE_MAIL = re.compile(r'^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$')


def normalizar(texto):
    t = unicodedata.normalize('NFKD', str(texto)).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]', ' ', t)).strip()


def palabras(texto):
    # Mínimo 3 caracteres: con 4 se perdían nombres reales como "Río Loa".
    return {p for p in normalizar(texto).split()
            if len(p) >= 3 and p not in VACIAS}


def mismo_colegio(oficial, otro):
    """¿El nombre de la planilla es el mismo establecimiento?

    Se exigen dos palabras significativas en común, salvo que uno de los
    dos nombres aporte una sola —"Escuela Caracoles" frente a "Complejo
    Educativo Caracoles"—. Medido sobre los descartes reales, esta regla
    acepta los renombres y abreviaturas y sigue rechazando los cambios de
    establecimiento: la similitud de texto no sirve acá, da 0,74 a un par
    distinto y 0,58 a uno que sí corresponde.
    """
    if normalizar(oficial) == normalizar(otro):
        return True
    a, b = palabras(oficial), palabras(otro)
    if not a or not b:
        return False
    return len(a & b) >= min(2, len(a), len(b))


def indice_base():
    """RBD -> nombre oficial desde el directorio MINEDUC."""
    ruta = os.path.join(DATOS, 'prospectos_jumpmath.csv')
    if not os.path.exists(ruta):
        sys.exit(f'Falta {ruta}. Corre antes build-prospectos.sh')
    idx = {}
    with open(ruta, encoding='utf-8-sig', newline='') as f:
        for r in csv.DictReader(f):
            if r['RBD'].isdigit():
                idx[int(r['RBD'])] = r['ESTABLECIMIENTO']
    return idx


def rango_mail(correo, web):
    """Menor es mejor. Ordena por quién decide, no por orden de columna."""
    correo = correo.lower().strip()
    if not RE_MAIL.match(correo):
        return 99
    local, dominio = correo.split('@', 1)
    local_limpio = re.sub(r'[^a-z]', '', local)
    generico = any(g in dominio for g in GENERICOS)

    # Dominio propio del colegio, deducido de su sitio web
    propio = False
    if web:
        w = re.sub(r'^https?://(www\.)?', '', str(web).lower()).split('/')[0]
        propio = bool(w) and (w in dominio or dominio in w)

    if any(m in local_limpio for m in ROLES_MALOS):
        return 90                       # existe, pero no es la contraparte
    bueno = any(local_limpio.startswith(r) for r in ROLES_BUENOS)
    if bueno and not generico:
        return 1
    if propio:
        return 2
    if bueno:
        return 3                        # rol institucional en gmail: común y válido
    if not generico:
        return 4
    return 5                            # correo personal en dominio genérico


def limpiar_tel(bruto):
    """Se deja tal cual la publicó la fuente.

    Muchos vienen en formato de 7 dígitos, anterior al cambio de
    numeración. Inventarles un código de área a partir de la región no es
    posible sin error: varias regiones tienen más de uno.
    """
    t = re.sub(r'[^\d+]', ' ', str(bruto)).strip()
    d = re.sub(r'\D', '', t)
    return t if 7 <= len(d) <= 12 else ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--xlsx', required=True)
    ap.add_argument('--hoja', default=None)
    ap.add_argument('--fuente', default='bd2020')
    ap.add_argument('--salida', default=os.path.join(DATOS, 'contactos-importados.csv'))
    ap.add_argument('--incluir-dudosos', action='store_true',
                    help='importa también los RBD cuyo nombre no concuerda')
    a = ap.parse_args()

    idx = indice_base()
    print(f'Base MINEDUC: {len(idx)} establecimientos con básica regular')

    xl = pd.ExcelFile(a.xlsx)
    hoja = a.hoja or xl.sheet_names[0]
    d = pd.read_excel(a.xlsx, sheet_name=hoja, dtype=str).fillna('')
    print(f'Planilla: {len(d)} filas (hoja "{hoja}")')

    col_id = next((c for c in d.columns
                   if re.search(r'\b(rbd|id_colegio|id)\b', c, re.I)), None)
    col_nom = next((c for c in d.columns
                    if re.search(r'nombre|establecimiento', c, re.I)), None)
    if not col_id or not col_nom:
        sys.exit(f'No encuentro columna de RBD o de nombre en: {list(d.columns)}')
    cols_mail = [c for c in d.columns if re.search(r'mail|correo', c, re.I)]
    col_tel = next((c for c in d.columns if re.search(r'tel[ée]fono|fono', c, re.I)), None)
    col_web = next((c for c in d.columns if re.search(r'web|sitio|url', c, re.I)), None)
    col_dir = next((c for c in d.columns if re.search(r'director|rector', c, re.I)), None)
    print(f'  RBD={col_id}  nombre={col_nom}  correos={cols_mail}  tel={col_tel}')

    filas = []
    sin_rbd = fuera = descartados = 0
    ejemplos = []

    for _, r in d.iterrows():
        try:
            rbd = int(float(r[col_id]))
        except (ValueError, TypeError):
            sin_rbd += 1
            continue
        if rbd not in idx:
            fuera += 1                  # no imparte básica regular: no nos sirve
            continue

        oficial = idx[rbd]
        if not mismo_colegio(oficial, r[col_nom]) and not a.incluir_dudosos:
            descartados += 1
            if len(ejemplos) < 5:
                ejemplos.append((rbd, oficial, r[col_nom]))
            continue

        web = str(r[col_web]).strip() if col_web else ''
        correos = []
        for c in cols_mail:
            v = str(r[c]).strip().lower()
            if RE_MAIL.match(v) and v not in correos:
                correos.append(v)
        correos.sort(key=lambda m: rango_mail(m, web))
        # Un correo de centro de alumnos sólo entra si no hay nada mejor
        correos = [m for m in correos if rango_mail(m, web) < 90] or correos

        contacto = ''
        if col_dir and str(r[col_dir]).strip():
            # El año va en el propio dato: los directores rotan y este
            # nombre tiene la edad de la planilla.
            contacto = f'Director {a.fuente.replace("bd", "")}: {str(r[col_dir]).strip()}'

        filas.append({
            'RBD': rbd,
            'EMAIL': '; '.join(correos[:3]),
            'TELEFONO': limpiar_tel(r[col_tel]) if col_tel else '',
            'WEB': web,
            'CONTACTO': contacto,
            'FUENTE': a.fuente,
        })

    tmp = a.salida + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['RBD', 'EMAIL', 'TELEFONO', 'WEB',
                                          'CONTACTO', 'FUENTE'])
        w.writeheader()
        w.writerows(sorted(filas, key=lambda x: x['RBD']))
    os.replace(tmp, a.salida)

    con_mail = sum(1 for f in filas if f['EMAIL'])
    con_tel = sum(1 for f in filas if f['TELEFONO'])
    print(f'\nCruzados y verificados: {len(filas)}')
    print(f'  con correo   : {con_mail}  ({con_mail * 100 // max(len(idx), 1)}% de la base)')
    print(f'  con teléfono : {con_tel}')
    print(f'\nDescartados por nombre que no concuerda: {descartados}')
    for rbd, oficial, otro in ejemplos:
        print(f'  RBD {rbd}: MINEDUC="{oficial}"  planilla="{otro}"')
    print(f'Fuera de la base de básica regular: {fuera}')
    if sin_rbd:
        print(f'Sin RBD legible: {sin_rbd}')
    print(f'\n-> {a.salida}')
    print('\nSiguiente paso:')
    print(f'  node firebase/actualizar-contactos.mjs --admin '
          f'--csv {os.path.relpath(a.salida, RAIZ)} --fuente {a.fuente}')


if __name__ == '__main__':
    main()
