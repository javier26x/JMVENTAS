#!/usr/bin/env node
// ============================================================
// Empuja correos y teléfonos a Firestore sin tocar el resto del documento.
//
// Acepta cualquier CSV con columna RBD y al menos EMAIL o TELEFONO:
//   - datos/contactos-oficiales.csv   (cosechar-oficiales.py)
//   - datos/prospectos_jumpmath.csv   (enriquecer-contactos.py)
//
//   node firebase/actualizar-contactos.mjs --admin --csv datos/contactos-oficiales.csv
//   node firebase/actualizar-contactos.mjs --admin --csv ... --dry-run
//
// Sólo escribe los campos de gestión, que son los que las reglas
// permiten editar. No pisa un dato existente con uno vacío.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { firebaseConfig, comprobarFirestore } from './config.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.dirname(AQUI);
const LOTE = 500;

// Columna del CSV -> campo del documento. `pisa` distingue el dato de
// gestión, que nunca sobrescribe lo que el equipo escribió a mano, del
// dato de fuente oficial (SIMCE), que siempre debe reflejar lo último
// publicado.
const MAPA = {
  EMAIL: { campo: 'email', pisa: false },
  TELEFONO: { campo: 'telefono', pisa: false },
  WEB: { campo: 'web', pisa: false },
  CONTACTO: { campo: 'contacto', pisa: false },
  SIMCE_MATE: { campo: 'simceMate', pisa: true, numero: true },
  SIMCE_ANIO: { campo: 'simceAnio', pisa: true, numero: true },
  CATEGORIA: { campo: 'categoriaDesempeno', pisa: true },
  DOLOR: { campo: 'dolorMate', pisa: true, numero: true },
};
const COLUMNAS = Object.keys(MAPA);

const argv = process.argv.slice(2);
const tiene = (f) => argv.includes(f);
const valor = (f, def = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ADMIN = tiene('--admin');
const DRY = tiene('--dry-run');
const LIMPIAR = tiene('--limpiar');
const CSV = valor('--csv', 'datos/contactos-oficiales.csv');
const FUENTE = valor('--fuente', 'oficial');

// Parser CSV mínimo con soporte de comillas: los nombres traen comas.
function leerCsv(ruta) {
  const texto = fs.readFileSync(ruta, 'utf8').replace(/^﻿/, '');
  const filas = [];
  let campo = '';
  let fila = [];
  let enComillas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i += 1; }
      else if (c === '"') enComillas = false;
      else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  const cab = filas.shift().map((h) => h.trim().toUpperCase());
  return filas
    .filter((f) => f.length === cab.length)
    .map((f) => Object.fromEntries(cab.map((h, i) => [h, (f[i] || '').trim()])));
}

async function backend() {
  if (ADMIN) {
    const { initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    const local = path.join(AQUI, 'serviceAccount.json');
    initializeApp({
      credential: fs.existsSync(local)
        ? cert(JSON.parse(fs.readFileSync(local, 'utf8')))
        : applicationDefault(),
      projectId: firebaseConfig.projectId,
    });
    const db = getFirestore();
    return {
      etiqueta: 'admin',
      marca: FieldValue.serverTimestamp(),
      leer: async (ids) => {
        const refs = ids.map((id) => db.collection('prospectos').doc(id));
        const snaps = await db.getAll(...refs);
        return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, s.data()]));
      },
      batch: () => {
        const b = db.batch();
        return {
          set: (id, datos) => b.set(db.collection('prospectos').doc(id), datos, { merge: true }),
          commit: () => b.commit(),
        };
      },
    };
  }
  const { initializeApp } = await import('firebase/app');
  const {
    getFirestore, doc, getDoc, writeBatch, serverTimestamp,
  } = await import('firebase/firestore');
  const db = getFirestore(initializeApp(firebaseConfig));
  return {
    etiqueta: 'web SDK',
    marca: serverTimestamp(),
    leer: async (ids) => {
      const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, 'prospectos', id))));
      return new Map(snaps.filter((s) => s.exists()).map((s) => [s.id, s.data()]));
    },
    batch: () => {
      const b = writeBatch(db);
      return {
        set: (id, datos) => b.set(doc(db, 'prospectos', id), datos, { merge: true }),
        commit: () => b.commit(),
      };
    },
  };
}

async function main() {
  const ruta = path.isAbsolute(CSV) ? CSV : path.join(RAIZ, CSV);
  if (!fs.existsSync(ruta)) throw new Error(`No existe ${ruta}`);

  const filas = leerCsv(ruta);
  const conDato = LIMPIAR
    ? filas.filter((f) => f.RBD)
    : filas.filter((f) => f.RBD && COLUMNAS.some((c) => f[c]));
  const presentes = COLUMNAS.filter((c) => conDato.some((f) => f[c]));
  console.log(`${path.relative(RAIZ, ruta)}: ${filas.length} filas, `
    + `${conDato.length} ${LIMPIAR ? 'a limpiar' : 'con datos'}`);
  if (!LIMPIAR) console.log(`Columnas a cargar: ${presentes.join(', ') || 'ninguna'}`);

  if (!conDato.length) {
    console.log('Nada que hacer.');
    return;
  }
  if (LIMPIAR && !DRY) {
    console.log('\nMODO LIMPIEZA: borra email, teléfono y estado de esos RBD '
      + 'para volver a cosecharlos.\n');
  }
  if (DRY) {
    console.log('\n--dry-run. Primeras 10:');
    for (const f of conDato.slice(0, 10)) {
      const vista = presentes.map((c) => `${c}=${(f[c] || '—').slice(0, 34)}`).join('  ');
      console.log(`  RBD ${f.RBD.padEnd(6)} ${vista}`);
    }
    return;
  }

  await comprobarFirestore();
  const be = await backend();
  console.log(`Backend: ${be.etiqueta}\n`);

  let escritos = 0;
  let saltados = 0;
  let ausentes = 0;

  for (let i = 0; i < conDato.length; i += LOTE) {
    const trozo = conDato.slice(i, i + LOTE);
    const actuales = await be.leer(trozo.map((f) => String(f.RBD)));
    const b = be.batch();
    let enLote = 0;

    for (const f of trozo) {
      const id = String(f.RBD);
      const previo = actuales.get(id);
      if (!previo) { ausentes += 1; continue; }

      const datos = {};
      if (LIMPIAR) {
        // Se revierte lo cosechado automáticamente. Un documento sin
        // `contactoFuente` viene de una carga anterior a que se registrara
        // el origen, así que también entra; los editados a mano llevan
        // otra fuente y se respetan.
        const origen = previo.contactoFuente;
        if (origen && origen !== FUENTE) { saltados += 1; continue; }
        if (!String(previo.email || '').trim()
            && !String(previo.telefono || '').trim()) { saltados += 1; continue; }
        Object.assign(datos, {
          email: '', telefono: '', web: '', contacto: '',
          contactoFuente: '', estadoCrm: 'nuevo',
        });
      } else {
        for (const col of COLUMNAS) {
          const bruto = f[col];
          if (!bruto) continue;
          const { campo, pisa, numero } = MAPA[col];
          // El contacto escrito a mano gana; el dato oficial se refresca.
          if (!pisa && String(previo[campo] || '').trim()) continue;
          const valor = numero ? Number(String(bruto).replace(',', '.')) : bruto;
          if (numero && !Number.isFinite(valor)) continue;
          datos[campo] = valor;
        }
        if (!Object.keys(datos).length) { saltados += 1; continue; }

        // Deja rastro de origen para poder revertir sólo esto después.
        datos.contactoFuente = FUENTE;
        if (datos.email && (previo.estadoCrm || 'nuevo') === 'nuevo') {
          datos.estadoCrm = 'contacto_ok';
        }
      }
      datos.actualizado = be.marca;
      b.set(id, datos);
      enLote += 1;
    }

    if (enLote) await b.commit();
    escritos += enLote;
    process.stdout.write(`\r  ${Math.min(i + LOTE, conDato.length)}/${conDato.length} revisados · ${escritos} actualizados   `);
  }

  console.log(`\n\n${LIMPIAR ? 'Limpiados' : 'Actualizados'}: ${escritos}`);
  console.log(LIMPIAR
    ? `Respetados (editados a mano o ya vacíos): ${saltados}`
    : `Ya tenían contacto (no se pisaron): ${saltados}`);
  if (ausentes) console.log(`RBD que no están en la base de básica: ${ausentes}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nError: ${e.message}`);
  if (/permission|PERMISSION_DENIED|insufficient/i.test(e.message) && !ADMIN) {
    console.error('\nUsa --admin: las reglas sólo permiten editar campos de gestión '
      + 'a usuarios autenticados.');
  }
  process.exit(1);
});
