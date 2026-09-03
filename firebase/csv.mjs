// ============================================================
// Lector de CSV con comillas.
//
// Los nombres de establecimiento traen comas ("ESC. BASICA G-N°637,
// LAS MELOSAS") y los directores también, así que partir por coma a
// secas corre las columnas y mete media dirección en el teléfono.
// Vive aparte porque lo usan varios cargadores y una copia divergente
// es una corrupción silenciosa en la base.
// ============================================================
import fs from 'node:fs';

export function leerCsv(ruta) {
  const texto = fs.readFileSync(ruta, 'utf8').replace(/^﻿/, '');
  const filas = [];
  let campo = '';
  let fila = [];
  let enComillas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i += 1; } else if (c === '"') enComillas = false;
      else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; } else if (c === '\n') {
      fila.push(campo); filas.push(fila); fila = []; campo = '';
    } else if (c !== '\r') campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  if (!filas.length) return [];
  const cab = filas.shift().map((h) => h.trim().toUpperCase());
  return filas
    .filter((f) => f.length === cab.length)
    .map((f) => Object.fromEntries(cab.map((h, i) => [h, (f[i] || '').trim()])));
}

export default leerCsv;
