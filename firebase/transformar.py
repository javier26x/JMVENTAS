#!/usr/bin/env python3
# ============================================================
# JUMP Math Chile - CSV -> NDJSON listo para Firestore
#
# Separa la transformacion (tipos, GeoPoint, derivados) de la carga.
# Asi el JSON se puede inspeccionar antes de escribir nada en la nube.
#
#   python3 firebase/transformar.py
#   -> firebase/data/prospectos.ndjson
#      firebase/data/redes.ndjson
#      firebase/data/cuentas.ndjson
#      firebase/data/meta.json
# ============================================================
import csv
import json
import os
import re
import unicodedata
from datetime import date

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATOS = os.path.join(RAIZ, 'datos')
SALIDA = os.path.join(RAIZ, 'firebase', 'data')

# El directorio MINEDUC entrega decimales con coma: "-33,53056565"
def num(v, entero=False):
    if v is None:
        return None
    v = str(v).strip().replace(',', '.')
    if v == '':
        return None
    try:
        f = float(v)
    except ValueError:
        return None
    return int(f) if entero else f


def booleano(v):
    return str(v).strip() in ('1', 'true', 'True', 'SÍ', 'SI')


def slug(s, maxlen=120):
    s = unicodedata.normalize('NFKD', str(s)).encode('ascii', 'ignore').decode()
    s = re.sub(r'[^a-zA-Z0-9]+', '-', s).strip('-').lower()
    return (s or 'sin-nombre')[:maxlen]


def tier_num(t):
    m = re.match(r'\s*(\d)', str(t))
    return int(m.group(1)) if m else None


def escribir(nombre, filas):
    ruta = os.path.join(SALIDA, nombre)
    with open(ruta, 'w', encoding='utf-8') as f:
        for r in filas:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(f'  {nombre}: {len(filas)} documentos')
    return len(filas)


def cargar_prospectos():
    ruta = os.path.join(DATOS, 'prospectos_jumpmath.csv')
    docs = []
    with open(ruta, encoding='utf-8-sig', newline='') as f:
        for r in csv.DictReader(f):
            rbd = num(r['RBD'], entero=True)
            if rbd is None:
                continue
            lat, lon = num(r.get('LAT')), num(r.get('LON'))
            dep = r['DEPENDENCIA'].strip()
            nombre = r['ESTABLECIMIENTO'].strip()
            docs.append({
                '_id': str(rbd),
                'rbd': rbd,
                'establecimiento': nombre,
                # normalizado sin tildes para busqueda por prefijo en Firestore
                'busqueda': slug(nombre, 200).replace('-', ' '),
                'tier': r['TIER'].strip(),
                'tierNum': tier_num(r['TIER']),
                'puntaje': num(r['PUNTAJE']),
                'canal': r['CANAL'].strip(),
                'dependencia': dep,
                'comuna': r['COMUNA'].strip(),
                'region': r['REGION'].strip(),
                'matBasica': num(r['MAT_BASICA'], entero=True) or 0,
                'matTotal': num(r['MAT_TOTAL'], entero=True) or 0,
                'eeEnRed': num(r['EE_EN_RED'], entero=True) or 1,
                'matRed': num(r['MAT_RED'], entero=True) or 0,
                'rutSostenedor': r['RUT_SOSTENEDOR'].strip(),
                'copago': r['COPAGO'].strip(),
                'pie': booleano(r['PIE']),
                'rural': booleano(r['RURAL']),
                # null explicito: Firestore no acepta GeoPoint con lat/lon vacios
                'geo': {'lat': lat, 'lon': lon} if lat is not None and lon is not None else None,
                # Solo particular pagado puede comprar sin estar en el Registro ATE
                'requiereAte': dep != 'Particular Pagado',
                'email': r.get('EMAIL', '').strip(),
                'telefono': r.get('TELEFONO', '').strip(),
                'web': r.get('WEB', '').strip(),
                'contacto': r.get('CONTACTO', '').strip(),
                'estadoCrm': r.get('ESTADO_CRM', '').strip() or 'nuevo',
                'busquedaWeb': r.get('BUSQUEDA_WEB', '').strip(),
            })
    return docs


def construir_redes(prospectos):
    """Sostenedores con 3+ establecimientos: 1 reunion = N colegios."""
    por_rut = {}
    for p in prospectos:
        rut = p['rutSostenedor']
        if not rut or rut.startswith('RBD:'):
            continue
        g = por_rut.setdefault(rut, {'ee': [], 'mat': 0, 'regiones': set(),
                                     'comunas': {}, 'dependencias': set()})
        g['ee'].append(p)
        g['mat'] += p['matBasica']
        g['regiones'].add(p['region'])
        g['comunas'][p['comuna']] = g['comunas'].get(p['comuna'], 0) + 1
        g['dependencias'].add(p['dependencia'])

    docs = []
    for rut, g in por_rut.items():
        if len(g['ee']) < 3:
            continue
        mayor = max(g['ee'], key=lambda x: x['matBasica'])
        docs.append({
            '_id': slug(rut),
            'rutSostenedor': rut,
            'eeBasica': len(g['ee']),
            'matBasica': g['mat'],
            'regiones': sorted(g['regiones']),
            'nRegiones': len(g['regiones']),
            'comunaPrincipal': max(g['comunas'], key=g['comunas'].get),
            'dependencias': sorted(g['dependencias']),
            'requiereAte': 'Particular Pagado' not in g['dependencias'],
            'establecimientoMayor': mayor['establecimiento'],
            'rbdMayor': mayor['rbd'],
            'rbds': sorted(p['rbd'] for p in g['ee']),
            'estadoCrm': 'nuevo',
        })
    docs.sort(key=lambda d: -d['matBasica'])
    return docs


def cargar_cuentas():
    """Las cuentas de cabecera ya contactadas o contactables."""
    ruta = os.path.join(DATOS, 'contactos-verificados.csv')
    docs = []
    with open(ruta, encoding='utf-8', newline='') as f:
        for r in csv.DictReader(f):
            nombre = r['CUENTA'].strip()
            emails = [e.strip() for e in r['EMAIL'].split(';') if e.strip()]
            tels = [t.strip() for t in r['TELEFONO'].split(';') if t.strip()]
            docs.append({
                '_id': slug(nombre),
                'cuenta': nombre,
                'prioridad': num(r['PRIORIDAD'], entero=True),
                'tipo': r['TIPO'].strip(),
                'canal': r['CANAL'].strip(),
                'rutSostenedor': r['RUT_SOSTENEDOR'].strip(),
                'eeBasica': num(r['EE_BASICA'], entero=True),
                'matBasica': num(r['MAT_BASICA'], entero=True),
                'requiereAte': r['REQUIERE_ATE'].strip() == 'SÍ',
                'nombreContacto': r['NOMBRE_CONTACTO'].strip(),
                'cargo': r['CARGO'].strip(),
                'emails': emails,
                'telefonos': tels,
                'tieneContacto': bool(emails or tels),
                'direccion': r['DIRECCION'].strip(),
                'web': r['WEB'].strip(),
                'comuna': r['COMUNA'].strip(),
                'region': r['REGION'].strip(),
                'rbd': num(r['RBD'], entero=True),
                'confianza': r['CONFIANZA'].strip(),
                'fuente': r['FUENTE'].strip(),
                'proximoPaso': r['PROXIMO_PASO'].strip(),
                'estadoCrm': 'nuevo',
            })
    docs.sort(key=lambda d: (d['prioridad'] or 9, -(d['matBasica'] or 0)))
    return docs


def main():
    os.makedirs(SALIDA, exist_ok=True)
    print('Transformando CSV -> NDJSON')

    prospectos = cargar_prospectos()
    redes = construir_redes(prospectos)
    cuentas = cargar_cuentas()

    n_p = escribir('prospectos.ndjson', prospectos)
    n_r = escribir('redes.ndjson', redes)
    n_c = escribir('cuentas.ndjson', cuentas)

    meta = {
        '_id': 'carga',
        'fuente': 'MINEDUC, Directorio Oficial de Establecimientos Educacionales 2025',
        'corteMatricula': '2025-04-30',
        'generado': date.today().isoformat(),
        'prospectos': n_p,
        'redes': n_r,
        'cuentas': n_c,
        'matBasicaTotal': sum(p['matBasica'] for p in prospectos),
        'porTier': {t: sum(1 for p in prospectos if p['tier'] == t)
                    for t in sorted({p['tier'] for p in prospectos})},
        'advertencia': ('La base refleja abril 2025. Los 10 SLEP que entraron en '
                        'regimen el 1-ene-2026 absorbieron DAEM que aqui aun figuran '
                        'como municipales. Verificar en dep.gob.cl antes de contactar.'),
    }
    with open(os.path.join(SALIDA, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"\n  Total: {n_p + n_r + n_c + 1} documentos a escribir")
    print(f"  Matricula basica cubierta: {meta['matBasicaTotal']:,}")
    print(f"  Cuentas con contacto: {sum(1 for c in cuentas if c['tieneContacto'])}")
    print(f"\n  -> {SALIDA}")


if __name__ == '__main__':
    main()
