// Kept ready after the page loads so a later offline document job needs no
// network request. Cancellation destroys its parser state and document memory.
export class SignedCompressor {
  constructor() { this.serial = 0; this.start(); }
  start() {
    this.available = false;
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
    try { this.worker = new Worker(new URL('./signed.worker.js', import.meta.url), { type: 'module' }); }
    catch { this.resolveReady(false); return; }
    this.loadTimer = setTimeout(() => { this.worker.terminate(); this.resolveReady(false); }, 10_000);
    this.worker.onmessage = ({ data }) => {
      if (data.ready) { clearTimeout(this.loadTimer); this.available = true; this.resolveReady(true); return; }
      if (!this.pending) return;
      if (data.progress) { this.pending.progress(data.progress); return; }
      const pending = this.pending; this.pending = null; clearTimeout(this.timer);
      if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.result);
    };
    this.worker.onerror = event => {
      event.preventDefault(); clearTimeout(this.loadTimer); this.available = false; this.resolveReady(false);
      this.pending?.reject(new Error('Signed compression could not run in this browser.'));
      this.pending = null; clearTimeout(this.timer);
    };
  }
  async run(bytes, limit, progress) {
    const serial = this.serial;
    if (!await this.ready || !this.available) throw new Error('Signed compression could not load in this browser.');
    if (serial !== this.serial) throw new Error('Cancelled. Your original is unchanged.');
    if (this.pending) throw new Error('Another document is still being checked.');
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, progress };
      this.timer = setTimeout(() => this.cancel('The signature check took too long. The original is unchanged.'), 30_000);
      const copy = bytes.slice(); this.worker.postMessage({ bytes: copy.buffer, limit }, [copy.buffer]);
    });
  }
  cancel(reason = 'Cancelled. Your original is unchanged.', restart = true) {
    this.serial++;
    // An idle worker has no document state. Keep its code ready for offline use.
    if (restart && !this.pending) return;
    this.worker?.terminate(); this.resolveReady(false); clearTimeout(this.timer); clearTimeout(this.loadTimer);
    this.pending?.reject(new Error(reason)); this.pending = null;
    if (restart) this.start();
  }
}
