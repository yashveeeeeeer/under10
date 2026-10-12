import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { createHash } from 'node:crypto';

export const manifest = JSON.parse(await readFile('tests/data/revocation-manifest.json', 'utf8'));
export const fixture = async name => new Uint8Array(gunzipSync(await readFile(`tests/data/${name}.pdf.gz`)));
export async function snapshot(bytes) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const walk = n => {
    if (n instanceof PDFRef) return walk(pdf.context.lookup(n));
    if (n instanceof PDFRawStream) return ['stream', createHash('sha256').update(decodePDFRawStream(n).decode()).digest('hex')];
    if (n instanceof PDFDict) return n.entries().map(([k, v]) => [k.toString(), walk(v)]).sort(([a], [b]) => a.localeCompare(b));
    if (n instanceof PDFArray) return n.asArray().map(walk);
    return n.toString();
  };
  return { dss: walk(pdf.catalog.get(PDFName.of('DSS'))),
    info: walk(pdf.context.trailerInfo.Info), id: walk(pdf.context.trailerInfo.ID), pages: pdf.getPageCount() };
}

// Change only an unsigned revision and rebuild its xref correctly. A rejection
// must therefore exercise the intended guard, not a stale byte offset.
export function changeSuffix(input, signedBytes, edit) {
  const src = Buffer.from(input).toString('latin1');
  const xref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(src)[1]);
  const trailer = src.slice(xref).match(/trailer\s*(<<[\s\S]*>>)\s*startxref/)[1];
  const lines = src.slice(xref, src.indexOf('trailer', xref)).trim().split(/\r?\n/).slice(1);
  const offsets = [];
  for (let i = 0; i < lines.length;) {
    const [start, count] = lines[i++].trim().split(/\s+/).map(Number);
    for (let j = 0; j < count; j++) {
      const [at, , type] = lines[i++].trim().split(/\s+/);
      if (type === 'n') offsets.push([start + j, Number(at)]);
    }
  }
  offsets.sort((a, b) => a[1] - b[1]);
  const objects = new Map(offsets.map(([id, at], i) => [id, src.slice(at, offsets[i + 1]?.[1] ?? xref)
    .replace(/^\d+ 0 obj\s*/, '').replace(/\s*endobj\s*$/, '')]));
  edit(objects);
  let out = src.slice(0, signedBytes) + '\n'; const rows = [];
  for (const [id, body] of [...objects].sort((a, b) => a[0] - b[0])) {
    rows.push(`${id} 1\n${String(out.length).padStart(10, '0')} 00000 n \n`);
    out += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const at = out.length, size = Math.max(...objects.keys()) + 1;
  out += `xref\n0 1\n0000000000 65535 f \n${rows.join('')}trailer\n${trailer.replace(/\/Size \d+/, '/Size ' + size)}\nstartxref\n${at}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

export const streamBody = (bytes, flate = false) => `<< /Length ${bytes.length}${flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n${Buffer.from(bytes).toString('latin1')}\nendstream`;
