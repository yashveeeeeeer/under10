import { PDFDocument, PDFName, PDFHexString, StandardFonts, rgb } from 'pdf-lib';

export async function pdfFixture(options = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (options.pages || 1); i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`${options.label || 'SYNTHETIC TEST DOCUMENT'} - page ${i + 1}`, { x: 42, y: 780, size: 18, font });
    page.drawText('Not a real incorporation document. No personal information.', { x: 42, y: 747, size: 10, font });
    page.drawText('Fine-print readability test: 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ', { x: 42, y: 720, size: 8, font });
    page.drawRectangle({ x: 42, y: 625, width: 80, height: 70, borderColor: rgb(.1, .4, .3), borderWidth: 1.2 });
    page.drawText('TEST SEAL', { x: 51, y: 651, font, size: 10 });
  }
  if (options.signature) {
    const sig = doc.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', ByteRange: [0, 123, 456, 789], Contents: PDFHexString.of('00'.repeat(128)) });
    const ref = doc.context.register(sig);
    const field = doc.context.obj({ FT: 'Sig', T: PDFHexString.fromText('Test signature'), V: ref });
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [doc.context.register(field)], SigFlags: 3 }));
  }
  if (options.blankSignature) doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [doc.context.register(doc.context.obj({ FT: 'Sig' }))] }));
  if (options.form) doc.getForm().createTextField('Company name');
  if (options.active) doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ S: 'JavaScript', JS: PDFHexString.fromText('app.alert("test")') }));
  if (options.attachment) await doc.attach(new Uint8Array([1, 2, 3]), 'synthetic.txt');
  if (options.annotation) doc.getPages()[0].node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 30, 30] }))]));
  return doc.save({ useObjectStreams: options.compressed !== false });
}
export function file(bytes, name = 'synthetic.pdf') { return { name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }; }
