/* pro-files.js — generadores/lectores de archivos SIN dependencias externas:
 *  - Excel (.xlsx): crear y leer (zip + XML escritos a mano; leer usa DecompressionStream).
 *  - PDF: documento de texto/tablas simple (Helvetica, A4) con paginación.
 *  - CSV: crear.
 * Se carga como script clásico (window.ProFiles) y se puede importar en Node para pruebas.
 */
(function (root) {
  'use strict';

  var enc = new TextEncoder();
  var dec = new TextDecoder('utf-8');

  function concat(chunks) {
    var len = 0, i;
    for (i = 0; i < chunks.length; i++) len += chunks[i].length;
    var out = new Uint8Array(len), off = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }

  /* ---------- CRC32 ---------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------- ZIP (sin compresión) ---------- */
  function zipStore(files) { // files: [{name, data:Uint8Array}]
    var locals = [], centrals = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name);
      var crc = crc32(f.data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      var local = concat([new Uint8Array(lh.buffer), name, f.data]);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      centrals.push(concat([new Uint8Array(ch.buffer), name]));
      locals.push(local);
      offset += local.length;
    });
    var cdBytes = concat(centrals);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdBytes.length, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
    return concat(locals.concat([cdBytes, new Uint8Array(end.buffer)]));
  }

  async function inflateRaw(bytes) {
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function zipRead(bytes) { // -> { 'ruta': Uint8Array }
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('El archivo no es un .xlsx válido (zip no encontrado).');
    var count = dv.getUint16(eocd + 10, true);
    var pos = dv.getUint32(eocd + 16, true);
    var out = {};
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(pos, true) !== 0x02014b50) throw new Error('Zip dañado.');
      var method = dv.getUint16(pos + 10, true);
      var csize = dv.getUint32(pos + 20, true);
      var nlen = dv.getUint16(pos + 28, true), elen = dv.getUint16(pos + 30, true), clen = dv.getUint16(pos + 32, true);
      var lho = dv.getUint32(pos + 42, true);
      var name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nlen));
      var lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
      var start = lho + 30 + lnlen + lelen;
      var raw = bytes.subarray(start, start + csize);
      if (/\.(xml|rels)$/i.test(name)) {
        out[name] = method === 0 ? raw : (method === 8 ? await inflateRaw(raw) : null);
      }
      pos += 46 + nlen + elen + clen;
    }
    return out;
  }

  /* ---------- XLSX ---------- */
  function xmlEsc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; })
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }
  function colName(i) { // 0 -> A
    var s = '';
    i++;
    while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }
  function colIndex(ref) {
    var letters = String(ref).replace(/[^A-Z]/gi, '').toUpperCase();
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }
  function sheetXml(rows) {
    var out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    rows.forEach(function (row, r) {
      out += '<row r="' + (r + 1) + '">';
      row.forEach(function (v, c) {
        if (v == null || v === '') return;
        var ref = colName(c) + (r + 1);
        var style = r === 0 ? ' s="1"' : '';
        if (typeof v === 'number' && isFinite(v)) out += '<c r="' + ref + '"' + style + '><v>' + v + '</v></c>';
        else out += '<c r="' + ref + '"' + style + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
      });
      out += '</row>';
    });
    return out + '</sheetData></worksheet>';
  }
  /** sheets: [{name, rows:[[celda,...],...]}]. La primera fila se pinta en negrita. */
  function xlsxBuild(sheets) {
    var list = sheets && sheets.length ? sheets : [{ name: 'Hoja1', rows: [[]] }];
    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
    list.forEach(function (s, i) { ct += '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; });
    ct += '</Types>';
    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    var wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
    var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    list.forEach(function (s, i) {
      var nm = String(s.name || ('Hoja' + (i + 1))).replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31);
      wb += '<sheet name="' + xmlEsc(nm) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      wbRels += '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
    });
    wb += '</sheets></workbook>';
    wbRels += '<Relationship Id="rId' + (list.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
      + '</styleSheet>';
    var files = [
      { name: '[Content_Types].xml', data: enc.encode(ct) },
      { name: '_rels/.rels', data: enc.encode(rels) },
      { name: 'xl/workbook.xml', data: enc.encode(wb) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) },
      { name: 'xl/styles.xml', data: enc.encode(styles) }
    ];
    list.forEach(function (s, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: enc.encode(sheetXml(s.rows || [])) }); });
    return zipStore(files);
  }
  function xmlUnesc(s) {
    return String(s).replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, function (m, e) {
      var l = e.toLowerCase();
      if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>';
      if (l === 'quot') return '"'; if (l === 'apos') return "'";
      var code = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
      return isNaN(code) ? m : String.fromCodePoint(code);
    });
  }
  function textOfT(xml) { // concatena todos los <t>…</t>
    var out = '', re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, m;
    while ((m = re.exec(xml))) out += xmlUnesc(m[1]);
    return out;
  }
  /** bytes (Uint8Array) de un .xlsx -> filas de la primera hoja ([[...]]). */
  async function xlsxParse(bytes) {
    var files = await zipRead(bytes);
    var names = Object.keys(files);
    var sheetName = files['xl/worksheets/sheet1.xml'] ? 'xl/worksheets/sheet1.xml'
      : names.filter(function (n) { return /^xl\/worksheets\/[^/]+\.xml$/.test(n); }).sort()[0];
    if (!sheetName || !files[sheetName]) throw new Error('No se encontró ninguna hoja en el Excel.');
    var shared = [];
    if (files['xl/sharedStrings.xml']) {
      var sx = dec.decode(files['xl/sharedStrings.xml']), sre = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g, sm;
      while ((sm = sre.exec(sx))) shared.push(textOfT(sm[1]));
    }
    var xml = dec.decode(files[sheetName]);
    var rows = [], rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g, rm;
    while ((rm = rowRe.exec(xml))) {
      var row = [], cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
      while ((cm = cellRe.exec(rm[1]))) {
        var attrs = cm[1], inner = cm[2] || '';
        var ref = (attrs.match(/\br="([A-Z]+\d+)"/i) || [])[1];
        var type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
        var idx = ref ? colIndex(ref) : row.length;
        var val = '';
        var v = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (type === 'inlineStr') val = textOfT(inner);
        else if (type === 's') val = v ? (shared[parseInt(v[1], 10)] || '') : '';
        else if (type === 'str' || type === 'e') val = v ? xmlUnesc(v[1]) : '';
        else if (type === 'b') val = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
        else val = v ? v[1] : '';
        while (row.length < idx) row.push('');
        row[idx] = val;
      }
      rows.push(row);
    }
    return rows;
  }

  /* ---------- CSV ---------- */
  function csvBuild(rows, delim) {
    var d = delim || ';';
    var body = rows.map(function (r) {
      return r.map(function (v) {
        var s = v == null ? '' : String(v);
        return (s.indexOf(d) !== -1 || /["\r\n]/.test(s)) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(d);
    }).join('\r\n');
    return enc.encode('\uFEFF' + body + '\r\n');
  }

  /* ---------- PDF ---------- */
  var HELV = { 32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191, 40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
    48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556, 56: 556, 57: 556, 58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556, 64: 1015,
    65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778, 72: 722, 73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778, 80: 667, 81: 778,
    82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944, 88: 667, 89: 667, 90: 611, 91: 278, 92: 278, 93: 278, 94: 469, 95: 556, 96: 333,
    97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278, 103: 556, 104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833, 110: 556, 111: 556,
    112: 556, 113: 556, 114: 333, 115: 500, 116: 278, 117: 556, 118: 500, 119: 722, 120: 500, 121: 500, 122: 500, 123: 334, 124: 260, 125: 334, 126: 584 };
  var WIN1252 = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89,
    0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96,
    0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };
  function winAnsiBytes(str) {
    var out = [];
    for (var ch of String(str)) {
      var c = ch.codePointAt(0);
      if (c === 0x2212) c = 0x2D;                 // − → -
      else if (c === 0x2192 || c === 0x2191) c = c === 0x2192 ? 0x3E : 0x5E; // → ↑ aproximados
      if (c >= 0x20 && c <= 0x7E) out.push(c);
      else if (c >= 0xA0 && c <= 0xFF) out.push(c);
      else if (WIN1252[c]) out.push(WIN1252[c]);
      else if (c === 0x09) out.push(0x20);
      // el resto (emojis, etc.) se omite
    }
    return out;
  }
  function textWidth(str, size, bold) {
    var w = 0;
    for (var ch of String(str)) {
      var c = ch.codePointAt(0);
      var base = c < 127 ? c : (String(ch).normalize('NFD').charCodeAt(0));
      w += HELV[base] || (c === 0x2022 ? 350 : 556);
    }
    return (w / 1000) * size * (bold ? 1.06 : 1);
  }
  function pdfEscape(bytes) {
    var out = [];
    bytes.forEach(function (b) {
      if (b === 40 || b === 41 || b === 92) out.push(92);
      out.push(b);
    });
    return out;
  }
  function numStr(n) { return (Math.round(n * 100) / 100).toString(); }
  function rgbOp(hex) {
    var h = String(hex || '#000000').replace('#', '');
    var r = parseInt(h.substr(0, 2), 16) / 255, g = parseInt(h.substr(2, 2), 16) / 255, b = parseInt(h.substr(4, 2), 16) / 255;
    return numStr(r) + ' ' + numStr(g) + ' ' + numStr(b);
  }
  /** blocks: [{type:'band',text,sub}, {type:'heading',text}, {type:'row', cols:[{text,x,align,bold,color,size}], h, rule},
   *           {type:'text',text,size,color,x}, {type:'space',h}]. x en puntos desde el borde izquierdo (A4 595×842). */
  function pdfBuild(blocks, opts) {
    var o = Object.assign({ marginTop: 50, marginBottom: 50, marginX: 40, footer: '' }, opts || {});
    var W = 595, H = 842;
    var pages = [], cur = null, y = 0;
    function newPage() { cur = []; pages.push(cur); y = H - o.marginTop; }
    function put(op) { cur.push(op); }
    function text(t, x, yy, size, bold, color, align) {
      var b = winAnsiBytes(t);
      var xx = x;
      if (align === 'r') xx = x - textWidth(t, size, bold);
      else if (align === 'c') xx = x - textWidth(t, size, bold) / 2;
      put({ raw: rgbOp(color || '#111111') + ' rg BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' + numStr(xx) + ' ' + numStr(yy) + ' Td (', bytes: pdfEscape(b), tail: ') Tj ET\n' });
    }
    function rect(x, yy, w, h, color) { put({ raw: rgbOp(color) + ' rg ' + numStr(x) + ' ' + numStr(yy) + ' ' + numStr(w) + ' ' + numStr(h) + ' re f\n' }); }
    function line(x1, y1, x2, y2, color, wd) { put({ raw: rgbOp(color) + ' RG ' + (wd || 0.5) + ' w ' + numStr(x1) + ' ' + numStr(y1) + ' m ' + numStr(x2) + ' ' + numStr(y2) + ' l S\n' }); }
    newPage();
    (blocks || []).forEach(function (b) {
      var need = b.type === 'band' ? 70 : (b.type === 'heading' ? 40 : (b.h || (b.size ? b.size + 6 : 18)));
      if (y - need < o.marginBottom) newPage();
      if (b.type === 'band') {
        rect(0, y - 52, W, 70, b.color || '#0F6B43');
        text(b.text, o.marginX, y - 16, 20, true, '#FFFFFF');
        if (b.sub) text(b.sub, o.marginX, y - 38, 10.5, false, '#D8F5E6');
        y -= 78;
      } else if (b.type === 'heading') {
        y -= 8;
        text(b.text, o.marginX, y, 13, true, b.color || '#0F6B43');
        line(o.marginX, y - 5, W - o.marginX, y - 5, '#0F6B43', 0.8);
        y -= 20;
      } else if (b.type === 'row') {
        var h = b.h || 17;
        if (b.fill) rect(o.marginX - 4, y - 5, W - 2 * o.marginX + 8, h, b.fill);
        (b.cols || []).forEach(function (c) {
          text(c.text, c.x, y, c.size || 10, !!c.bold || !!b.bold, c.color || b.color, c.align);
        });
        if (b.rule) line(o.marginX, y - 5, W - o.marginX, y - 5, '#DDDDDD', 0.4);
        y -= h;
      } else if (b.type === 'text') {
        text(b.text, b.x != null ? b.x : o.marginX, y, b.size || 10, !!b.bold, b.color, b.align);
        y -= (b.size || 10) + 6;
      } else if (b.type === 'space') {
        y -= b.h || 10;
      }
    });
    var total = pages.length;
    pages.forEach(function (pg, i) {
      cur = pg;
      if (o.footer) text(o.footer, o.marginX, 28, 8, false, '#777777');
      text('Página ' + (i + 1) + ' de ' + total, W - o.marginX, 28, 8, false, '#777777', 'r');
    });
    // Ensamblado
    var chunks = [], offsets = [], pos = 0;
    function pushStr(s) { var b = enc.encode(s); chunks.push(b); pos += b.length; }
    function pushBytes(b) { chunks.push(b); pos += b.length; }
    function obj(id, bodyFn) { offsets[id] = pos; pushStr(id + ' 0 obj\n'); bodyFn(); pushStr('\nendobj\n'); }
    pushStr('%PDF-1.4\n'); pushBytes(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
    var kids = pages.map(function (_, i) { return (6 + 2 * i) + ' 0 R'; }).join(' ');
    obj(1, function () { pushStr('<< /Type /Catalog /Pages 2 0 R >>'); });
    obj(2, function () { pushStr('<< /Type /Pages /Kids [' + kids + '] /Count ' + pages.length + ' >>'); });
    obj(3, function () { pushStr('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); });
    obj(4, function () { pushStr('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'); });
    pages.forEach(function (pg, i) {
      var parts = [];
      pg.forEach(function (op) {
        parts.push(enc.encode(op.raw));
        if (op.bytes) { parts.push(new Uint8Array(op.bytes)); parts.push(enc.encode(op.tail)); }
      });
      var content = concat(parts);
      obj(5 + 2 * i, function () {
        pushStr('<< /Length ' + content.length + ' >>\nstream\n'); pushBytes(content); pushStr('\nendstream');
      });
      obj(6 + 2 * i, function () {
        pushStr('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + (5 + 2 * i) + ' 0 R >>');
      });
    });
    var size = 5 + 2 * pages.length;
    var xrefPos = pos;
    var xref = 'xref\n0 ' + size + '\n0000000000 65535 f \n';
    for (var id = 1; id < size; id++) xref += ('0000000000' + offsets[id]).slice(-10) + ' 00000 n \n';
    pushStr(xref + 'trailer\n<< /Size ' + size + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n');
    return concat(chunks);
  }

  root.ProFiles = {
    crc32: crc32, zipStore: zipStore, zipRead: zipRead,
    xlsxBuild: xlsxBuild, xlsxParse: xlsxParse, csvBuild: csvBuild,
    pdfBuild: pdfBuild, textWidth: textWidth, winAnsiBytes: winAnsiBytes
  };
})(typeof window !== 'undefined' ? window : globalThis);

