import { PDFDocument, PDFDict, PDFArray, PDFName, PDFRawStream, PDFInvalidObject } from 'pdf-lib';

export const LIMITS = Object.freeze({ files: 40, fileBytes: 40_000_000, totalBytes: 100_000_000, outputMB: 100, pages: 200, imagePixels: 32_000_000, renderPixels: 16_000_000 });
export const PROFILES = Object.freeze([{ dpi: 220, quality: .90 }, { dpi: 190, quality: .84 }, { dpi: 170, quality: .78 }, { dpi: 150, quality: .72 }]);
export const mb = bytes => `${(bytes / 1_000_000).toFixed(2)} MB`;
export function byteLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.1 || n > LIMITS.outputMB) throw new Error(`Choose a limit between 0.1 and ${LIMITS.outputMB} MB.`);
  return Math.floor(n * 1_000_000);
}
export function fits(bytes, limit) { return Number.isSafeInteger(bytes) && bytes > 0 && bytes < limit; }
export function targetBytes(limit, reserve = true) { return Math.floor(limit * (reserve ? .90 : .98)); }
export function sniff(bytes) {
  if (bytes.length < 8) throw new Error('This file is empty or incomplete.');
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 8));
  if (head.startsWith('%PDF-')) return 'pdf';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  throw new Error('Unsupported file. Use a PDF, JPG or PNG; changing the extension will not convert it.');
}
export function imageDimensions(bytes, kind) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height;
  if (kind === 'png' && bytes.length >= 24) {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (kind === 'jpg') {
    let p = 2;
    while (p + 8 < bytes.length) {
      if (bytes[p++] !== 255) throw new Error('Invalid JPEG structure.');
      while (bytes[p] === 255) p++;
      const marker = bytes[p++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const len = view.getUint16(p);
      if (len < 2 || p + len > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        height = view.getUint16(p + 3); width = view.getUint16(p + 5); break;
      }
      p += len;
    }
  }
  if (!width || !height) throw new Error('Cannot read the image dimensions.');
  if (width * height > LIMITS.imagePixels || Math.max(width, height) > 16000) throw new Error('Image too large to process safely. Use an image of 32 megapixels or less, with no side over 16,000 pixels.');
  return { width, height };
}
export async function inspectPDF(bytes) {
  const raw = new TextDecoder('latin1').decode(bytes);
  if (!raw.slice(-1024).includes('%%EOF')) throw new Error('Incomplete PDF: the end-of-file marker is missing. Re-export the original.');
  // Raw indicators also protect orphaned / historical signature objects. Escaped PDF names are decoded.
  const decodedNames = raw.replace(/#([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  let signature = /\/(?:ByteRange|Sig|DocMDP|FieldMDP|SigFlags)\b/.test(decodedNames);
  let interactive = false, active = false, attachments = false, oversizedImages = false;
  if (/\/Encrypt\b/.test(decodedNames)) throw new Error('Password-protected or encrypted PDFs are not supported. Obtain an authorised unsigned, unencrypted source.');
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    if (!(doc.catalog instanceof PDFDict)) throw new Error('Missing catalog');
    doc.getPages();
  }
  catch { throw new Error('This PDF could not be safely read. It may be encrypted, damaged or unsupported. Re-export the source.'); }
  const seen = new Set();
  const walk = obj => {
    if (!obj || seen.has(obj)) return;
    seen.add(obj);
    if (obj instanceof PDFInvalidObject) throw new Error('This PDF contains an unreadable object. Re-export the source.');
    if (obj instanceof PDFRawStream) { walk(obj.dict); return; }
    if (obj instanceof PDFDict) {
      if (obj.get(PDFName.of('Subtype'))?.toString() === '/Image') {
        const width = obj.lookup(PDFName.of('Width'))?.asNumber?.();
        const height = obj.lookup(PDFName.of('Height'))?.asNumber?.();
        if (!width || !height || width * height > LIMITS.imagePixels || Math.max(width, height) > 16000) oversizedImages = true;
      }
      for (const [key, value] of obj.entries()) {
        const k = key.decodeText();
        const v = value instanceof PDFName ? value.decodeText() : '';
        if (['ByteRange', 'DocMDP', 'FieldMDP', 'SigFlags'].includes(k) || (['FT', 'Type'].includes(k) && ['Sig', 'DocTimeStamp'].includes(v))) signature = true;
        if (['AcroForm', 'XFA'].includes(k) || (k === 'Subtype' && v === 'Widget')) interactive = true;
        if (['JS', 'JavaScript', 'AA', 'OpenAction'].includes(k) || (k === 'S' && ['Launch', 'GoToR', 'SubmitForm', 'ImportData', 'JavaScript', 'Rendition'].includes(v))) active = true;
        if (['EmbeddedFiles', 'EF', 'Collection'].includes(k)) attachments = true;
        walk(value);
      }
    } else if (obj instanceof PDFArray) for (let i = 0; i < obj.size(); i++) walk(obj.get(i));
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) walk(obj);
  let annotations = false;
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('PDF has invalid page dimensions. Re-export the source.');
    const a = page.node.Annots();
    if (a && a.size()) annotations = true;
  }
  const pages = doc.getPageCount();
  if (pages < 1 || pages > LIMITS.pages) throw new Error(`Use a PDF with 1–${LIMITS.pages} pages.`);
  return { pages, signature, interactive, active, attachments, annotations, oversizedImages };
}
export function transformIssue(info) {
  if (info.oversizedImages) return 'Embedded image exceeds the processing safety limit. This PDF is check-only.';
  if (info.signature) return 'Signature marker or field found. This PDF is check-only. Choose Already signed, or remove it to prepare unsigned files.';
  if (info.interactive) return 'Interactive form detected. This tool does not rewrite forms. Use a static, unsigned source attachment.';
  if (info.active) return 'PDF actions or scripts detected. This file is check-only.';
  if (info.attachments) return 'Portfolio or embedded attachment detected. This file is check-only so enclosed documents are not lost.';
  if (info.annotations) return 'PDF annotations detected. This file is check-only so comments, links or other annotations are not lost.';
  return null;
}
export async function assemble(items, getImage, onProgress = () => {}, check = () => {}) {
  const out = await PDFDocument.create();
  out.setProducer('Under10');
  out.setCreator('Under10');
  for (let i = 0; i < items.length; i++) {
    check();
    const item = items[i];
    onProgress(`Preparing file ${i + 1} of ${items.length}`);
    if (item.kind === 'pdf' && !item.raster) {
      const bytes = new Uint8Array(await item.file.arrayBuffer());
      const info = await inspectPDF(bytes);
      const issue = transformIssue(info);
      if (issue) throw new Error(issue);
      const source = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
      const pages = await out.copyPages(source, source.getPageIndices());
      pages.forEach(page => out.addPage(page));
    } else {
      await getImage(item, async ({ bytes, width, height }) => {
        check();
        const img = await out.embedJpg(bytes);
        const page = out.addPage([width, height]);
        page.drawImage(img, { x: 0, y: 0, width, height });
      });
    }
  }
  check();
  const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
  const reopened = await inspectPDF(bytes);
  const expected = items.reduce((sum, item) => sum + item.info.pages, 0);
  if (reopened.pages !== expected || transformIssue(reopened)) throw new Error('Output validation failed. No download was created.');
  return bytes;
}
