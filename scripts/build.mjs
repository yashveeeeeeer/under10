import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

await mkdir('docs/assets', { recursive: true });
await build({ entryPoints: ['src/signed.worker.js'], bundle: true, format: 'esm', target: 'es2022', outfile: 'docs/assets/signed.worker.js', minify: true, legalComments: 'linked' });
const signedVersion = createHash('sha256').update(await readFile('docs/assets/signed.worker.js')).digest('hex').slice(0, 12);
await build({ entryPoints: ['src/app.js'], bundle: true, format: 'esm', target: 'es2022', outfile: 'docs/assets/app.js', minify: true, legalComments: 'linked' });
await writeFile('docs/assets/app.js', (await readFile('docs/assets/app.js', 'utf8')).replace('./signed.worker.js', `./signed.worker.js?v=${signedVersion}`));
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'docs/assets/pdf.worker.mjs');
await copyFile('src/style.css', 'docs/assets/style.css');
let html = await readFile('src/index.html', 'utf8');
for (const file of ['app.js', 'style.css']) {
  const version = createHash('sha256').update(await readFile(`docs/assets/${file}`)).digest('hex').slice(0, 12);
  html = html.replace(`./assets/${file}`, `./assets/${file}?v=${version}`);
}
await writeFile('docs/index.html', html);
await writeFile('docs/.nojekyll', '');
const licenses = await Promise.all(['pdf-lib', 'pdfjs-dist', 'pkijs', 'asn1js', 'pvtsutils', 'pvutils', 'bytestreamjs', 'tslib', '@noble/hashes'].map(async name => `${name}\n${await readFile(`node_modules/${name}/${name === 'pdf-lib' ? 'LICENSE.md' : name === 'tslib' ? 'LICENSE.txt' : 'LICENSE'}`, 'utf8')}`));
await writeFile('docs/THIRD-PARTY-LICENSES.txt', licenses.join('\n\n'));
await copyFile('src/_headers', 'docs/_headers');
console.log('Built docs/ — ready for GitHub Pages.');
