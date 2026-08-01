#!/usr/bin/env bash
# ============================================================
# JUMP Math Chile — Motor de prospección comercial
# Frody Labs · construye la base de prospectos desde datos oficiales MINEDUC
# Uso:  bash build-prospectos.sh
# Salida: ~/jumpmath/out/prospectos_jumpmath.csv  +  prospectos_jumpmath.xlsx
# ============================================================
set -euo pipefail

BASE="$HOME/jumpmath"
mkdir -p "$BASE/raw" "$BASE/out"
cd "$BASE"

echo "==> [1/5] Dependencias"
sudo apt-get update -qq
sudo apt-get install -y -qq unrar-free python3-pip curl >/dev/null
pip install --break-system-packages -q pandas openpyxl requests beautifulsoup4 2>/dev/null || true

echo "==> [2/5] Descargando Directorio Oficial de Establecimientos (MINEDUC)"
curl -sL -o raw/directorio.rar \
  "https://datosabiertos.mineduc.cl/wp-content/uploads/2025/11/Directorio-Oficial-EE-2025.rar"
rm -rf raw/dir && mkdir -p raw/dir
unrar-free -x raw/directorio.rar raw/dir/ >/dev/null
CSV=$(find raw/dir -name "*Directorio*EE*.csv" | head -1)
echo "    -> $CSV"

echo "==> [3/5] Construyendo base de prospectos"
python3 - "$CSV" << 'PYEOF'
import sys, csv, unicodedata
from collections import defaultdict
import pandas as pd

src = sys.argv[1]
df = pd.read_csv(src, sep=';', encoding='utf-8-sig', dtype=str).fillna('')
num = lambda s: pd.to_numeric(s, errors='coerce').fillna(0).astype(int)
for c in ['MAT_ENS_2','MAT_TOTAL','COD_DEPE2','RURAL_RBD','CONVENIO_PIE','ESTADO_ESTAB','COD_REG_RBD']:
    df[c] = num(df[c])

# Universo objetivo: establecimientos activos que imparten Educacion Basica Regular
df = df[(df.ESTADO_ESTAB == 1) & (df.MAT_ENS_2 > 0)].copy()

DEP = {1:'Municipal/DAEM', 2:'Particular Subvencionado', 3:'Particular Pagado',
       4:'Corp. Adm. Delegada', 5:'SLEP'}
df['DEPENDENCIA'] = df.COD_DEPE2.map(DEP)

# Tamano de la red del sostenedor (clave: 1 venta = N colegios)
df['SOST_KEY'] = df.apply(lambda r: ('RUT:'+r.RUT_SOSTENEDOR.strip()) if r.RUT_SOSTENEDOR.strip() not in ('','0')
    else (('MRUN:'+r.MRUN.strip()) if r.MRUN.strip() not in ('','0') else 'RBD:'+str(r.RBD)), axis=1)
red = df.groupby('SOST_KEY').agg(EE_RED=('RBD','count'), MAT_RED=('MAT_ENS_2','sum'))
df = df.merge(red, on='SOST_KEY', how='left')

# --- CANAL DE VENTA (define el proceso de compra, no el tamano) ---
def canal(r):
    if r.COD_DEPE2 == 3:  return 'A · Directo Privado'
    if r.COD_DEPE2 == 2:  return 'B · Red Subvencionada' if r.EE_RED >= 3 else 'C · PS Individual'
    if r.COD_DEPE2 == 1:  return 'D · Municipal/DAEM'
    if r.COD_DEPE2 == 5:  return 'E · SLEP'
    return 'F · Otro'
df['CANAL'] = df.apply(canal, axis=1)

FRICCION = {'A · Directo Privado':1, 'B · Red Subvencionada':2, 'C · PS Individual':3,
            'D · Municipal/DAEM':4, 'E · SLEP':4, 'F · Otro':4}
df['FRICCION'] = df.CANAL.map(FRICCION)   # 1 = facil de cerrar, 4 = licitacion publica

# --- COMPONENTES DE PUNTAJE (0-100 c/u) ---
df['S_TAMANO']   = (df.MAT_ENS_2.clip(0,1200) / 12).round(0)          # ticket por colegio
df['S_RED']      = (df.EE_RED.clip(1,40) * 2.5).round(0)              # apalancamiento de red
df['S_FRICCION'] = ((5 - df.FRICCION) * 25).round(0)                  # velocidad de cierre
df['S_URBANO']   = (1 - df.RURAL_RBD) * 100                           # logistica de capacitacion
df['S_PAGO']     = df.PAGO_MENSUAL.map({'MAS DE $100.000':100,'$50.001 A $100.000':85,
                                        '$25.001 A $50.000':70,'$10.001 A $25.000':55,
                                        '$1.000 A $10.000':45}).fillna(30)
df['S_PIE']      = df.CONVENIO_PIE * 100                              # foco en diversidad = fit JUMP

W = dict(S_TAMANO=.20, S_RED=.20, S_FRICCION=.30, S_URBANO=.10, S_PAGO=.15, S_PIE=.05)
df['PUNTAJE'] = sum(df[k]*v for k,v in W.items()).round(1)

def tier(p):
    if p >= 62: return '1 · FACIL'
    if p >= 48: return '2 · MEDIO'
    return '3 · DIFICIL'
df['TIER'] = df.PUNTAJE.map(tier)

# Dominio probable para enriquecimiento posterior de correos
def slug(s):
    s = unicodedata.normalize('NFKD', str(s)).encode('ascii','ignore').decode().lower()
    return ''.join(ch for ch in s if ch.isalnum())
df['BUSQUEDA_WEB'] = df.NOM_RBD.str.title() + ' ' + df.NOM_COM_RBD.str.title() + ' colegio sitio web'
df['EMAIL'] = ''; df['TELEFONO'] = ''; df['WEB'] = ''; df['CONTACTO'] = ''; df['ESTADO_CRM'] = 'nuevo'

cols = ['TIER','PUNTAJE','CANAL','RBD','NOM_RBD','DEPENDENCIA','NOM_COM_RBD','NOM_REG_RBD_A',
        'MAT_ENS_2','MAT_TOTAL','EE_RED','MAT_RED','SOST_KEY','PAGO_MENSUAL','CONVENIO_PIE',
        'RURAL_RBD','LATITUD','LONGITUD','EMAIL','TELEFONO','WEB','CONTACTO','ESTADO_CRM','BUSQUEDA_WEB']
out = df[cols].sort_values(['TIER','PUNTAJE'], ascending=[True,False])
out.columns = ['TIER','PUNTAJE','CANAL','RBD','ESTABLECIMIENTO','DEPENDENCIA','COMUNA','REGION',
               'MAT_BASICA','MAT_TOTAL','EE_EN_RED','MAT_RED','RUT_SOSTENEDOR','COPAGO','PIE',
               'RURAL','LAT','LON','EMAIL','TELEFONO','WEB','CONTACTO','ESTADO_CRM','BUSQUEDA_WEB']
out.to_csv('out/prospectos_jumpmath.csv', index=False, encoding='utf-8-sig')

# Hoja resumen por sostenedor (para venta de red = 1 reunion, N colegios)
red_out = (df[df.COD_DEPE2.isin([2,3])]
           .groupby(['SOST_KEY'])
           .agg(EE=('RBD','count'), MAT_BASICA=('MAT_ENS_2','sum'),
                EJEMPLO=('NOM_RBD','first'), REGIONES=('NOM_REG_RBD_A','nunique'),
                COMUNA_PPAL=('NOM_COM_RBD', lambda s: s.mode().iat[0]))
           .query('EE >= 3').sort_values('MAT_BASICA', ascending=False).reset_index())
red_out.to_csv('out/redes_sostenedores.csv', index=False, encoding='utf-8-sig')

print(f"    Prospectos: {len(out)}  |  Redes >=3 EE: {len(red_out)}")
print(out.TIER.value_counts().to_string())
PYEOF

echo "==> [4/5] Exportando a Excel"
python3 - << 'PYEOF'
import pandas as pd
p = pd.read_csv('out/prospectos_jumpmath.csv')
r = pd.read_csv('out/redes_sostenedores.csv')
with pd.ExcelWriter('out/prospectos_jumpmath.xlsx', engine='openpyxl') as w:
    p.to_excel(w, sheet_name='Prospectos', index=False)
    r.to_excel(w, sheet_name='Redes', index=False)
    p.groupby(['TIER','CANAL']).agg(EE=('RBD','count'), MAT=('MAT_BASICA','sum')).reset_index() \
     .to_excel(w, sheet_name='Resumen', index=False)
print('    -> out/prospectos_jumpmath.xlsx')
PYEOF

echo "==> [5/5] Listo"
ls -lh out/
