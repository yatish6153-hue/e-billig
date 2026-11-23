// A small Excel (.xlsx) writer for exports: one sheet, a bold header row that stays in view, and columns of text,
// whole numbers or money (two decimals). No dependency: an .xlsx is a zip of a few XML files.
//
// Unlike a CSV, every cell has a type, so text is never read as a formula: "+91 98290 12345" stays as typed, with no
// apostrophe in front, and money cells add up.
import zlib from 'node:zlib';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// Style ids in styles.xml below: 0 plain, 1 bold (the header), 2 money (#,##0.00).
const STYLE = { text: 0, number: 0, money: 2 };

/** Text for XML: escaped, without the control characters XML can't carry. */
const esc = (value) => String(value)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A, B, … Z, AA, AB … */
function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function cell(value, ref, style) {
  if (value === null || value === undefined || value === '') return '';
  const s = style ? ` s="${style}"` : '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheetXml(columns, rows) {
  const row = (values, r, styleOf) => `<row r="${r}">${values.map((value, i) => cell(value, `${columnName(i)}${r}`, styleOf(i))).join('')}</row>`;
  const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('');
  return `${HEAD}<worksheet xmlns="${MAIN}">`
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols>${cols}</cols><sheetData>`
    + row(columns.map((c) => c.title), 1, () => 1)
    + rows.map((values, i) => row(values, i + 2, (col) => STYLE[columns[col]?.type] || 0)).join('')
    + '</sheetData></worksheet>';
}

const STYLES = `${HEAD}<styleSheet xmlns="${MAIN}">`
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/**
 * The workbook as bytes. columns: [{ title, type: 'text' | 'number' | 'money', width }] (width in characters);
 * rows: arrays of values in column order (numbers for number and money columns, '' or null for empty).
 */
export function xlsxFile({ sheet = 'Sheet1', columns, rows }) {
  const name = esc(String(sheet).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet1');
  const files = [
    ['[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>'],
    ['_rels/.rels', `${HEAD}<Relationships xmlns="${PKG}">`
      + `<Relationship Id="rId1" Type="${RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${HEAD}<workbook xmlns="${MAIN}" xmlns:r="${RELS}">`
      + `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${HEAD}<Relationships xmlns="${PKG}">`
      + `<Relationship Id="rId1" Type="${RELS}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${RELS}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', sheetXml(columns, rows)],
  ];
  return zip(files.map(([path, text]) => ({ path, data: Buffer.from(text, 'utf8') })));
}

/** A zip archive of the files, each deflated. */
function zip(files) {
  const parts = [];
  const directory = [];
  let offset = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1 Jan 1980: the files carry no date of their own
  for (const { path, data } of files) {
    const name = Buffer.from(path, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42); // extra, comment, disk and attributes stay 0
    directory.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
