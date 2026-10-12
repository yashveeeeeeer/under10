import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';

await mkdir('docs/assets', { recursive: true });
await build({ entryPoints: ['src/app.js'], bundle: true, format: 'esm', target: 'es2022', outfile: 'docs/assets/app.js', minify: true, legalComments: 'linked' });
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'docs/assets/pdf.worker.mjs');
await copyFile('src/index.html', 'docs/index.html');
await copyFile('src/style.css', 'docs/assets/style.css');
await writeFile('docs/.nojekyll', '');
const licenses = await Promise.all(['pdf-lib', 'pdfjs-dist'].map(async name => `${name}\n${await readFile(`node_modules/${name}/${name === 'pdf-lib' ? 'LICENSE.md' : 'LICENSE'}`, 'utf8')}`));
await writeFile('docs/THIRD-PARTY-LICENSES.txt', licenses.join('\n\n'));
await copyFile('src/_headers', 'docs/_headers');
console.log('Built docs/ — ready for GitHub Pages.');
