export const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const xml = escapeHTML;
export function download(name, content, type = 'application/octet-stream') {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content],{ type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url),2000);
}
export function csv(rows) {
  return '\uFEFF' + rows.map(row => row.map(value => {
    let v = String(value ?? ''); if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(v)) v = "'" + v;
    return '"' + v.replace(/"/g,'""') + '"';
  }).join(',')).join('\r\n');
}
export function parseCSV(text) {
  text = text.replace(/^\uFEFF/,''); const result = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i+1] === '\n') i++; row.push(field); if (row.some(s => s.trim())) result.push(row); row = []; field = ''; }
    else field += c;
  }
  if (quoted) throw new Error('CSV 引号不完整');
  if (field || row.length) { row.push(field); result.push(row); } return result;
}
// A genuine .xlsx file, using uncompressed ZIP and inline strings. No remote export service or spreadsheet runtime.
export function makeXLSX(rows, sheetName = '情景测算') {
  const enc = new TextEncoder(), chunks = [], directory = []; let offset = 0;
  const crcTable = Array.from({length:256},(_,n) => { for(let k=0;k<8;k++) n = n&1 ? 0xedb88320^(n>>>1) : n>>>1; return n>>>0; });
  const crc32 = data => { let c = 0xffffffff; for(const n of data) c = crcTable[(c^n)&255]^(c>>>8); return (c^0xffffffff)>>>0; };
  function bytes(n) { const a = new Uint8Array(n); return [a,new DataView(a.buffer)]; }
  function add(name, data) {
    const file = enc.encode(name), body = enc.encode(data), crc = crc32(body), [header,v] = bytes(30);
    v.setUint32(0,0x04034b50,true); v.setUint16(4,20,true); v.setUint16(6,0x800,true); v.setUint32(14,crc,true); v.setUint32(18,body.length,true); v.setUint32(22,body.length,true); v.setUint16(26,file.length,true);
    chunks.push(header,file,body);
    const [central,c] = bytes(46); c.setUint32(0,0x02014b50,true); c.setUint16(4,20,true); c.setUint16(6,20,true); c.setUint16(8,0x800,true); c.setUint32(16,crc,true); c.setUint32(20,body.length,true); c.setUint32(24,body.length,true); c.setUint16(28,file.length,true); c.setUint32(42,offset,true);
    directory.push(central,file); offset += header.length + file.length + body.length;
  }
  const doc = s => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + s;
  add('[Content_Types].xml',doc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'));
  add('_rels/.rels',doc('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'));
  add('xl/workbook.xml',doc('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="'+xml(sheetName)+'" sheetId="1" r:id="rId1"/></sheets></workbook>'));
  add('xl/_rels/workbook.xml.rels',doc('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'));
  add('xl/worksheets/sheet1.xml',doc('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+rows.map((r,i) => '<row r="'+(i+1)+'">'+r.map(v => typeof v === 'number' && Number.isFinite(v) ? '<c><v>'+v+'</v></c>' : '<c t="inlineStr"><is><t xml:space="preserve">'+xml(v ?? '')+'</t></is></c>').join('')+'</row>').join('')+'</sheetData></worksheet>'));
  const size = directory.reduce((s,b) => s+b.length,0), [end,e] = bytes(22); e.setUint32(0,0x06054b50,true); e.setUint16(8,5,true); e.setUint16(10,5,true); e.setUint32(12,size,true); e.setUint32(16,offset,true);
  return new Blob([...chunks,...directory,end],{ type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
