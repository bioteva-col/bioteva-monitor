/*
 * BioTeva Monitor — generador de Excel (.xlsx) sin dependencias.
 *
 * Un .xlsx es un ZIP con XML (Office Open XML). Aquí se escribe el ZIP en modo
 * "stored" (sin compresión; válido y compatible con Excel, LibreOffice y Google
 * Sheets) con su CRC-32. Las fechas se guardan como fecha/hora real de Excel
 * (número de serie con formato), no como texto, para poder filtrar y graficar.
 *
 *   MonXlsx.build([{ name, columns: [{ header, type, width }], rows: [[...]] }]) → Uint8Array
 *   type: "string" | "number" | "number1" | "number2" | "integer" | "datetime" (ms epoch) | "wrap"
 */
(function (root) {
  "use strict";

  var CRC_TABLE = (function () {
    var t = new Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    var out = [], s = unescape(encodeURIComponent(str));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return new Uint8Array(out);
  }

  /**
   * ZIP. files: [{ name, data: Uint8Array, comp?: Uint8Array }] — si `comp` existe
   * (deflate crudo de `data`), la entrada va comprimida; si no, "stored".
   */
  function zip(files, date) {
    var d = date || new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var chunks = [], central = [], offset = 0;

    function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
    function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

    files.forEach(function (f) {
      var name = utf8(f.name), data = f.data, crc = crc32(data);
      var method = f.comp ? 8 : 0, body = f.comp || data;
      var local = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(dosTime), u16(dosDate), u32(crc), u32(body.length), u32(data.length), u16(name.length), u16(0));
      chunks.push(new Uint8Array(local), name, body);
      central.push({ name: name, crc: crc, size: data.length, csize: body.length, method: method, offset: offset });
      offset += local.length + name.length + body.length;
    });
    var cdStart = offset, cdSize = 0;
    central.forEach(function (c) {
      var hdr = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(c.method), u16(dosTime), u16(dosDate), u32(c.crc), u32(c.csize), u32(c.size), u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset));
      chunks.push(new Uint8Array(hdr), c.name);
      cdSize += hdr.length + c.name.length;
    });
    chunks.push(new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0))));
    var total = chunks.reduce(function (a, c) { return a + c.length; }, 0), out = new Uint8Array(total), pos = 0;
    chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
    return out;
  }

  function esc(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function colName(i) {
    var s = "";
    i++;
    while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  /** ms epoch → número de serie de Excel en hora LOCAL del equipo. */
  function excelSerial(ms) {
    var off = new Date(ms).getTimezoneOffset() * 60000;
    return (ms - off) / 86400000 + 25569;
  }

  // estilos (índices de cellXfs)
  var STYLE = { string: 0, datetime: 1, number1: 2, header: 3, integer: 4, number2: 5, wrap: 6, number: 0 };

  var STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/><numFmt numFmtId="165" formatCode="0.0"/><numFmt numFmtId="166" formatCode="0.00"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1B4D2E"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="7">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' +
    "</cellXfs>" +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    "</styleSheet>";

  function sheetXml(sheet) {
    var cols = sheet.columns, rows = sheet.rows || [];
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
    out.push('<dimension ref="A1:' + colName(Math.max(0, cols.length - 1)) + (rows.length + 1) + '"/>');
    out.push('<sheetViews><sheetView workbookViewId="0"' + (sheet.freeze === false ? "" : '><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>') + (sheet.freeze === false ? "/>" : "") + "</sheetViews>");
    out.push("<cols>" + cols.map(function (c, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.width || 14) + '" customWidth="1"/>'; }).join("") + "</cols>");
    out.push("<sheetData>");
    out.push('<row r="1">' + cols.map(function (c, i) { return '<c r="' + colName(i) + '1" t="inlineStr" s="3"><is><t>' + esc(c.header) + "</t></is></c>"; }).join("") + "</row>");
    rows.forEach(function (row, ri) {
      var r = ri + 2, cells = [];
      cols.forEach(function (c, ci) {
        var v = row[ci], ref = colName(ci) + r;
        if (v === null || v === undefined || v === "") return;
        var type = c.type || "string";
        if (type === "datetime") {
          if (typeof v === "number" && isFinite(v)) cells.push('<c r="' + ref + '" s="1"><v>' + excelSerial(v) + "</v></c>");
          return;
        }
        if (type === "number" || type === "number1" || type === "number2" || type === "integer") {
          var n = Number(v);
          if (isFinite(n)) {
            cells.push('<c r="' + ref + '" s="' + STYLE[type] + '"><v>' + n + "</v></c>");
            return;
          }
        }
        cells.push('<c r="' + ref + '" t="inlineStr"' + (type === "wrap" ? ' s="6"' : "") + '><is><t xml:space="preserve">' + esc(v) + "</t></is></c>");
      });
      out.push('<row r="' + r + '">' + cells.join("") + "</row>");
    });
    out.push("</sheetData>");
    if (sheet.autoFilter !== false && cols.length) out.push('<autoFilter ref="A1:' + colName(cols.length - 1) + (rows.length + 1) + '"/>');
    out.push("</worksheet>");
    return out.join("");
  }

  function safeSheetName(name, used) {
    var n = String(name).replace(/[\\\/\?\*\[\]:]/g, " ").slice(0, 31) || "Hoja";
    var base = n, k = 2;
    while (used[n]) n = base.slice(0, 28) + " " + k++;
    used[n] = true;
    return n;
  }

  /** Partes del libro (sin comprimir). */
  function parts(sheets) {
    var used = {};
    var names = sheets.map(function (s) { return safeSheetName(s.name, used); });
    var files = [];
    files.push({
      name: "[Content_Types].xml",
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
          sheets.map(function (_, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join("") +
          "</Types>",
      ),
    });
    files.push({
      name: "_rels/.rels",
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
          "</Relationships>",
      ),
    });
    var nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    files.push({
      name: "docProps/core.xml",
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
          "<dc:title>BioTeva — Monitoreo ambiental</dc:title><dc:creator>BioTeva Monitor</dc:creator>" +
          '<dcterms:created xsi:type="dcterms:W3CDTF">' + nowIso + "</dcterms:created>" +
          "</cp:coreProperties>",
      ),
    });
    files.push({
      name: "xl/workbook.xml",
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          "<sheets>" + names.map(function (n, i) { return '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join("") + "</sheets>" +
          "<definedNames>" +
          sheets.map(function (s, i) {
            if (s.autoFilter === false || !s.columns.length) return "";
            return '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">\'' + esc(names[i]).replace(/'/g, "''") + "'!$A$1:$" + colName(s.columns.length - 1) + "$" + ((s.rows || []).length + 1) + "</definedName>";
          }).join("") +
          "</definedNames>" +
          "</workbook>",
      ),
    });
    files.push({
      name: "xl/_rels/workbook.xml.rels",
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          sheets.map(function (_, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join("") +
          '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
          "</Relationships>",
      ),
    });
    files.push({ name: "xl/styles.xml", data: utf8(STYLES_XML) });
    sheets.forEach(function (s, i) { files.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: utf8(sheetXml(s)) }); });
    return files;
  }

  /** Libro .xlsx sin compresión (síncrono). */
  function build(sheets) { return zip(parts(sheets)); }

  function deflateRaw(data) {
    return new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  /**
   * Libro .xlsx comprimido (deflate nativo del navegador, ~10× más pequeño).
   * Si el navegador no tiene CompressionStream, cae a la versión sin compresión.
   */
  function buildCompressed(sheets) {
    var files = parts(sheets);
    if (typeof CompressionStream === "undefined" || typeof Response === "undefined") return Promise.resolve(zip(files));
    return Promise.all(files.map(function (f) { return deflateRaw(f.data).then(function (c) { f.comp = c; }); }))
      .then(function () { return zip(files); })
      .catch(function () { files.forEach(function (f) { delete f.comp; }); return zip(files); });
  }

  root.MonXlsx = { build: build, buildCompressed: buildCompressed, zip: zip, crc32: crc32, colName: colName, excelSerial: excelSerial, utf8: utf8 };
})(typeof self !== "undefined" ? self : globalThis);
