#!/usr/bin/env python3
# ============================================================
# JUMP Math Chile - Consolida lo cosechado en un solo archivo
#
# El VPS raspa y cosecha; esta pieza junta todo lo que produjo y deja UN
# archivo listo para cargar. Asi el VPS no necesita credenciales de
# Google: no escribe en Firestore, sólo produce un CSV que se transfiere.
#
# Cuando dos fuentes dan correos distintos para el mismo colegio hay que
# elegir, y no da lo mismo cual: un "contacto@colegiosanjose.cl" sigue
# vivo cuando cambia la directora; un "maria.perez@gmail.com" recogido en
# 2020 probablemente rebote. El orden de preferencia esta abajo, en
# calidad(), y se puede discutir mirando el CSV de salida: cada fila dice
# por que gano ese correo.
#
#   python3 scripts/consolidar-contactos.py datos/contactos-oficiales.csv \
#           datos/prospectos_jumpmath-contactos.csv
#
# Salida: datos/contactos-listos.csv  (RBD, EMAIL, TELEFONO, WEB, FUENTE,
#         CONFIANZA, MOTIVO) — lo que espera actualizar-contactos.mjs.
# ============================================================
import argparse
import csv
import os
import re
import sys
from collections import defaultdict

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATOS = os.path.join(RAIZ, 'datos')

RE_MAIL = re.compile(r'^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$')

# Casillas gratuitas: funcionan, pero pertenecen a una persona y no al
# establecimiento. Cuando esa persona se va, el correo se muere con ella.
GRATUITOS = {
    'gmail.com', 'gmail.cl', 'hotmail.com', 'hotmail.es', 'hotmail.cl',
    'outlook.com', 'outlook.es', 'yahoo.com', 'yahoo.es', 'yahoo.cl',
    'live.cl', 'live.com', 'msn.com', 'terra.cl', 'vtr.net', 'gmx.com',
}

# Casillas de rol: sobreviven al cambio de persona, que es exactamente lo
# que se quiere para una base que se va a usar durante meses.
ROLES = ('contacto', 'admision', 'admisiones', 'secretaria', 'secretaría',
         'direccion', 'dirección', 'director', 'rectoria', 'rectoría',
         'info', 'informacion', 'colegio', 'escuela', 'liceo', 'comunicaciones',
         'administracion', 'daem', 'educacion')

# Lo que nunca sirve: buzones tecnicos, de plataformas o del que hizo la web.
BASURA = ('noreply', 'no-reply', 'webmaster', 'postmaster', 'mailer-daemon',
          'example.com', 'sentry.io', 'wordpress', 'wixpress', 'godaddy',
          'sitio.com', 'dominio.cl', 'tudominio', 'correo@correo')


def limpiar(bruto):
    """Separa un campo que puede traer varios correos y descarta basura."""
    salida = []
    for trozo in re.split(r'[;,\s]+', str(bruto or '')):
        e = trozo.strip().strip('.').lower()
        if not e or not RE_MAIL.match(e):
            continue
        if any(b in e for b in BASURA):
            continue
        # Un nombre de archivo colado por el raspado: "logo.png@sitio.cl"
        # sale de un <img>, no de un contacto. Se mira antes de la arroba
        # y al final, porque aparece de las dos formas.
        if re.search(r'\.(png|jpe?g|gif|webp|svg|ico|css|js|pdf)(@|$)', e):
            continue
        if e not in salida:
            salida.append(e)
    return salida


def dominio(correo):
    return correo.split('@')[-1] if '@' in correo else ''


def calidad(correo, web, fuente):
    """Puntaje y motivo. Mas alto es mejor; el motivo va al CSV para que
    la decision se pueda revisar sin releer este archivo."""
    dom = dominio(correo)
    usuario = correo.split('@')[0]
    puntos = 0
    motivos = []

    if 'oficial' in fuente.lower():
        puntos += 40
        motivos.append('fuente oficial')

    if dom in GRATUITOS:
        motivos.append('casilla personal')
    else:
        puntos += 30
        motivos.append('dominio propio')
        # Que el dominio del correo coincida con el del sitio del colegio
        # es la senal mas fuerte de que ese buzon es de verdad suyo.
        host = re.sub(r'^www\.', '', re.sub(r'^https?://', '', str(web or '')).split('/')[0]).lower()
        if host and (host.endswith(dom) or dom.endswith(host)):
            puntos += 20
            motivos.append('coincide con su sitio')

    if any(usuario.startswith(r) for r in ROLES):
        puntos += 15
        motivos.append('casilla de rol')

    return puntos, ' · '.join(motivos)


def leer(ruta):
    """Lee un CSV de cosecha y devuelve filas normalizadas por RBD."""
    if not os.path.exists(ruta):
        print(f'  aviso: no existe {ruta}, se omite')
        return []
    fuente = os.path.basename(ruta)
    filas = []
    with open(ruta, newline='', encoding='utf-8-sig') as fh:
        for f in csv.DictReader(fh):
            rbd = str(f.get('RBD') or '').strip()
            if not rbd or not rbd.isdigit():
                continue
            filas.append({
                'rbd': rbd,
                'correos': limpiar(f.get('EMAIL')),
                'telefono': str(f.get('TELEFONO') or '').strip(),
                'web': str(f.get('WEB') or '').strip(),
                'contacto': str(f.get('CONTACTO') or '').strip(),
                'fuente': str(f.get('FUENTE') or '').strip() or fuente,
            })
    print(f'  {ruta}: {len(filas)} filas con RBD')
    return filas


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('entradas', nargs='+', help='CSV cosechados por el VPS')
    ap.add_argument('--salida', default=os.path.join(DATOS, 'contactos-listos.csv'))
    ap.add_argument('--solo-buenos', action='store_true',
                    help='descarta las casillas personales; sube la calidad '
                         'a costa de cobertura')
    a = ap.parse_args()

    print('Leyendo lo cosechado:')
    por_rbd = defaultdict(list)
    for ruta in a.entradas:
        for f in leer(ruta):
            por_rbd[f['rbd']].append(f)

    if not por_rbd:
        print('\nNo se encontró ninguna fila utilizable. ¿Las rutas son correctas?')
        return 1

    salida = []
    stats = defaultdict(int)
    for rbd, filas in sorted(por_rbd.items(), key=lambda x: int(x[0])):
        # El mejor telefono, sitio y nombre de cualquiera de las fuentes.
        telefono = next((f['telefono'] for f in filas if f['telefono']), '')
        web = next((f['web'] for f in filas if f['web']), '')
        contacto = next((f['contacto'] for f in filas if f['contacto']), '')

        # Cuantas fuentes distintas mencionan cada correo: coincidir en dos
        # es una confirmacion barata y sorprendentemente buena.
        veces = defaultdict(set)
        for f in filas:
            for c in f['correos']:
                veces[c].add(f['fuente'])

        candidatos = []
        for correo, fuentes in veces.items():
            fuente = ' + '.join(sorted(fuentes))
            puntos, motivo = calidad(correo, web, fuente)
            if len(fuentes) > 1:
                puntos += 10
                motivo += f' · en {len(fuentes)} fuentes'
            candidatos.append((puntos, correo, fuente, motivo))

        if not candidatos:
            if telefono:
                stats['solo teléfono'] += 1
                salida.append({'RBD': rbd, 'EMAIL': '', 'TELEFONO': telefono,
                               'WEB': web, 'CONTACTO': contacto,
                               'FUENTE': filas[0]['fuente'], 'CONFIANZA': 'SIN CORREO',
                               'MOTIVO': 'sólo teléfono'})
            else:
                stats['sin nada'] += 1
            continue

        candidatos.sort(key=lambda x: (-x[0], x[1]))
        puntos, correo, fuente, motivo = candidatos[0]

        if a.solo_buenos and dominio(correo) in GRATUITOS:
            stats['descartado por personal'] += 1
            continue

        conf = 'ALTA' if puntos >= 60 else 'MEDIA' if puntos >= 30 else 'BAJA'
        stats[conf] += 1
        # Los demas correos van detras, separados por ";": el motor usa el
        # primero y los otros quedan como respaldo si ese rebota.
        resto = [c[1] for c in candidatos[1:3]]
        salida.append({
            'RBD': rbd,
            'EMAIL': '; '.join([correo] + resto),
            'TELEFONO': telefono,
            'WEB': web,
            'CONTACTO': contacto,
            'FUENTE': fuente,
            'CONFIANZA': conf,
            'MOTIVO': motivo,
        })

    os.makedirs(os.path.dirname(a.salida), exist_ok=True)
    campos = ['RBD', 'EMAIL', 'TELEFONO', 'WEB', 'CONTACTO', 'FUENTE',
              'CONFIANZA', 'MOTIVO']
    with open(a.salida, 'w', newline='', encoding='utf-8-sig') as fh:
        w = csv.DictWriter(fh, fieldnames=campos)
        w.writeheader()
        w.writerows(salida)

    con_correo = sum(1 for f in salida if f['EMAIL'])
    print(f'\n{len(salida)} colegios escritos en {a.salida}')
    print(f'  con correo : {con_correo}')
    for k in ('ALTA', 'MEDIA', 'BAJA', 'solo teléfono', 'sin nada',
              'descartado por personal'):
        if stats[k]:
            print(f'  {k:24} {stats[k]}')
    print('\nRevisa unas filas antes de cargar:')
    print(f'  head -5 {a.salida}')
    print('\nY cárgalo desde donde tengas credenciales:')
    print(f'  node firebase/actualizar-contactos.mjs --admin --csv {a.salida} --fuente cosecha')
    return 0


if __name__ == '__main__':
    sys.exit(main())
