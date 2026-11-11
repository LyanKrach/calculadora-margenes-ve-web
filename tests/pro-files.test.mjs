import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import '../pro-core.js';
import '../pro-files.js';

const F = globalThis.ProFiles;
const OUT = process.env.PRO_FILES_OUT || '';

function save(name, bytes) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), bytes);
}

test('crc32 estándar', () => {
  assert.equal(F.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

test('xlsx: se escribe y se vuelve a leer igual (acentos, comillas, números)', async () => {
  const rows = [
    ['Producto', 'Costo $', 'Precio Bs', 'Nota'],
    ['Diamantes 100 + 10', 0.66, 913.97, 'Ñandú "especial" & <b>'],
    ['Tarjeta', 6.5, 7567.28, '']
  ];
  const bytes = F.xlsxBuild([{ name: 'Reporte', rows }]);
  save('roundtrip.xlsx', bytes);
  const back = await F.xlsxParse(bytes);
  assert.equal(back.length, 3);
  assert.deepEqual(back[0], rows[0]);
  assert.equal(back[1][0], 'Diamantes 100 + 10');
  assert.equal(Number(back[1][1]), 0.66);
  assert.equal(Number(back[1][2]), 913.97);
  assert.equal(back[1][3], 'Ñandú "especial" & <b>');
  assert.equal(back[2][0], 'Tarjeta');
});

test('xlsx: varias hojas', async () => {
  const bytes = F.xlsxBuild([{ name: 'Por día', rows: [['a'], [1]] }, { name: 'Por producto', rows: [['b'], [2]] }]);
  save('twosheets.xlsx', bytes);
  const files = await F.zipRead(bytes);
  assert.ok(files['xl/worksheets/sheet1.xml'] && files['xl/worksheets/sheet2.xml']);
});

test('pdf: estructura válida (xref apunta a cada objeto) y varias páginas', () => {
  const blocks = [{ type: 'band', text: 'Lista de precios — Mi Tienda', sub: 'Tasa BCV Bs 901,62 · 11 nov' }];
  for (let s = 0; s < 3; s++) {
    blocks.push({ type: 'heading', text: 'Categoría ' + (s + 1) + ' ñ é ü' });
    for (let i = 0; i < 40; i++) {
      blocks.push({ type: 'row', rule: true, cols: [{ text: (i + 1) + ' + ' + (i + 1) + ' Diamantes (promo)', x: 44 }, { text: 'Bs ' + (1000 + i * 37.5).toFixed(2), x: 550, align: 'r', bold: true }] });
    }
  }
  const pdf = F.pdfBuild(blocks, { footer: 'Generado con margencalcu.online' });
  save('lista.pdf', pdf);
  const txt = new TextDecoder('latin1').decode(pdf);
  assert.ok(txt.startsWith('%PDF-1.4'));
  assert.ok(txt.trimEnd().endsWith('%%EOF'));
  const sx = txt.lastIndexOf('startxref');
  const xrefPos = parseInt(txt.slice(sx + 9).trim(), 10);
  assert.equal(txt.slice(xrefPos, xrefPos + 4), 'xref');
  const m = txt.slice(xrefPos).match(/xref\n0 (\d+)\n/);
  const n = parseInt(m[1], 10);
  const entries = txt.slice(xrefPos + m[0].length).split('\n').slice(1, n);
  for (let id = 1; id < n; id++) {
    const off = parseInt(entries[id - 1].slice(0, 10), 10);
    assert.equal(txt.slice(off, off + String(id).length + 6), id + ' 0 obj', 'objeto ' + id);
  }
  const pages = (txt.match(/\/Type \/Page /g) || []).length;
  assert.ok(pages >= 3, 'páginas: ' + pages);
});

test('pdf: texto con paréntesis y barras se escapa', () => {
  const pdf = F.pdfBuild([{ type: 'text', text: 'Precio (Bs) \\ ok' }]);
  const txt = new TextDecoder('latin1').decode(pdf);
  assert.ok(txt.includes('(Precio \\(Bs\\) \\\\ ok)'));
});

test('csv: separador ; con BOM y comillas', () => {
  const bytes = F.csvBuild([['a;b', 'c"d'], [1, 'x']]);
  assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF]); // BOM UTF-8
  const out = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  assert.equal(out, '\uFEFF"a;b";"c""d"\r\n1;x\r\n');
});

test('ancho de texto Helvetica razonable', () => {
  const w = F.textWidth('1234567890', 10, false);
  assert.ok(Math.abs(w - 55.6) < 0.01);
});
