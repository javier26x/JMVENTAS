#!/usr/bin/env python3
# ============================================================
# JUMP Math Chile - Analisis de la base de prospectos
#
# Reproduce los cortes que sostienen la estrategia comercial:
#   - universo por tier y canal
#   - redes de sostenedores (1 reunion = N colegios)
#   - redes de particular pagado (el canal sin ATE)
#   - ranking de municipios y SLEP por matricula
#
#   python3 analizar-base.py [ruta/prospectos_jumpmath.csv]
# ============================================================
import sys
import pandas as pd

RUTA = sys.argv[1] if len(sys.argv) > 1 else 'datos/prospectos_jumpmath.csv'

# Grupos que operan varios RBD bajo RUT distintos: no se detectan agrupando
# por RUT_SOSTENEDOR, hay que reconocerlos por marca.
REDES_POR_MARCA = {
    'Cognita Chile': (r'PUMAHUE|MANQUECURA|AMERICAN BRITISH|GREENLAND|'
                      r'DUNALASTAIR|WESSEX|SAN FRANCISCO JAVIER'),
}


def main():
    d = pd.read_csv(RUTA, dtype=str, encoding='utf-8-sig').fillna('')
    for c in ('PUNTAJE', 'MAT_BASICA', 'MAT_TOTAL', 'EE_EN_RED', 'MAT_RED', 'RURAL'):
        d[c] = pd.to_numeric(d[c], errors='coerce').fillna(0)

    print(f'UNIVERSO: {len(d)} establecimientos con basica regular | '
          f'{int(d.MAT_BASICA.sum()):,} alumnos\n')

    print('=== TIER x CANAL ===')
    print(d.groupby(['TIER', 'CANAL'])
           .agg(EE=('RBD', 'count'), MAT=('MAT_BASICA', 'sum')).to_string())

    print('\n=== REDES SUBVENCIONADAS (>=3 EE) — requieren ATE ===')
    ps = d[d.DEPENDENCIA == 'Particular Subvencionado']
    red = (ps.groupby('RUT_SOSTENEDOR')
             .agg(EE=('RBD', 'count'), MAT=('MAT_BASICA', 'sum'),
                  EJEMPLO=('ESTABLECIMIENTO', 'first'),
                  REGIONES=('REGION', 'nunique'))
             .query('EE >= 3').sort_values('MAT', ascending=False))
    print(red.head(15).to_string())
    print(f'  -> {len(red)} redes con 3+ establecimientos, '
          f'{int(red.MAT.sum()):,} alumnos en total')

    print('\n=== REDES DE PARTICULAR PAGADO (>=2 EE) — SIN ATE ===')
    pp = d[d.DEPENDENCIA == 'Particular Pagado']
    redpp = (pp.groupby('RUT_SOSTENEDOR')
               .agg(EE=('RBD', 'count'), MAT=('MAT_BASICA', 'sum'),
                    EJEMPLO=('ESTABLECIMIENTO', 'first'))
               .query('EE >= 2').sort_values('MAT', ascending=False))
    print(redpp.head(10).to_string())

    print('\n=== REDES POR MARCA (RUT distintos, decision central) ===')
    for nombre, patron in REDES_POR_MARCA.items():
        g = pp[pp.ESTABLECIMIENTO.str.upper().str.contains(patron, na=False)]
        print(f'  {nombre}: {len(g)} colegios | {int(g.MAT_BASICA.sum()):,} alumnos '
              f'| {g.REGION.nunique()} regiones')

    print('\n=== TOP 15 DAEM MUNICIPALES (1 contrato = N escuelas) ===')
    m = d[d.CANAL == 'D · Municipal/DAEM']
    print(m.groupby(['COMUNA', 'REGION'])
           .agg(EE=('RBD', 'count'), MAT=('MAT_BASICA', 'sum'), RURALES=('RURAL', 'sum'))
           .sort_values('MAT', ascending=False).head(15).to_string())

    print('\n=== TOP 12 SLEP por comuna ===')
    s = d[d.CANAL == 'E · SLEP']
    print(s.groupby(['COMUNA', 'REGION'])
           .agg(EE=('RBD', 'count'), MAT=('MAT_BASICA', 'sum'))
           .sort_values('MAT', ascending=False).head(12).to_string())

    print('\n=== COBERTURA DE CONTACTOS ===')
    if 'EMAIL' in d.columns:
        con = d[d.EMAIL.astype(str).str.strip() != '']
        print(f'  Con correo: {len(con)} de {len(d)}')
        if len(con):
            print(con.groupby('TIER').size().to_string())


if __name__ == '__main__':
    main()
