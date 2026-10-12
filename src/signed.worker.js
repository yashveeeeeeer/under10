import { compactSignedPDF } from './signed.js';
self.onmessage = async ({ data: { bytes, limit } }) => {
  try {
    const result = await compactSignedPDF(new Uint8Array(bytes), limit, progress => self.postMessage({ progress }));
    self.postMessage({ result }, [result.bytes.buffer]);
  } catch (error) { self.postMessage({ error: error.message || 'Signed compression is not supported for this file.' }); }
};
self.postMessage({ ready: true });
