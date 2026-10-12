# Under10 technical notes

[Back to the short guide](README.md)

A free, browser-only workspace for preparing unsigned PDFs and images under a chosen file-size limit. Built for document preparation around workflows such as MCA filings; independent of MCA.

**Live site:** https://yashveeeeeeer.github.io/under10/

This is not an MCA acceptance checker, signature validator, signing service or legal tool.

## Two workflows

- **Unsigned:** drop PDFs, JPEGs and PNGs; order the files; choose a decimal MB limit from 0.1 to 100; prepare, review every page and download. Native PDF text/vectors are copied first. Colour images use bounded compression. Rasterizing unsigned PDF pages requires the explicit “Allow scan compression” option.
- **Signed:** select one PDF, check its exact byte count and download the original bytes unchanged. SHA-256 identifies the original bytes; it does not validate a signature. This mode can also check an unsigned original without changing it. Selecting Unsigned never overrides signature detection.

No tool can promise to merge/compress arbitrary digitally signed PDFs into a smaller ordinary PDF while preserving their original signatures. The safe sequence is **prepare unsigned originals → review → sign → recheck size**. A PDF portfolio can retain original files as embedded documents but is not an equivalent merged PDF, and MCA acceptance is not assumed. This app does not generate portfolios.

## Run and test

Node.js 22 or newer:

```sh
npm ci
npm run check
npm start
```

Open the printed local URL. On Windows browser tests use installed Microsoft Edge; on Linux/macOS run `npx playwright install chromium` first. The public app needs no Node.js, Python, account, API key or processing server.

`npm run build` bundles pinned dependencies and emits `docs/`. Libraries and the PDF worker are served from the same site. No CDN runtime dependencies, analytics or third-party fonts. `docs/` is committed so free GitHub Pages can publish directly from `main /docs` without a build service.

## Exact guardrails

| Condition | Behaviour |
| --- | --- |
| Output size | Strictly **less than** the chosen decimal-byte limit. 10 MB = 10,000,000 bytes. Equality fails. |
| Signing headroom | “I’ll sign this PDF later” is visible for unsigned inputs and checked by default. Its target is 90% of the limit (9,000,000 bytes at 10 MB). Unchecked, the target is 98%. It is hidden in Signed mode, where only the exact chosen limit applies. This cannot guarantee the eventual signed file size. |
| Cannot fit | Stop with no downloadable result. Never omit a page or secretly reduce quality below the configured floor. |
| Existing signature | Inspect decoded PDF objects and conservative raw/historical/escaped-name markers. Signature fields, including blank ones, block the unsigned merge/raster path. Signed mode has the narrow compression profile below, with an unchanged fallback. No cryptographic trust decision is made. |
| Ambiguous/unsupported PDF | Encrypted, damaged or unreadable inputs fail. Forms, annotations, scripts/actions, portfolios and embedded attachments cannot be transformed. |
| Quality | Colour JPEG attempts: 220 DPI / 90%, 190 / 84%, 170 / 78%, 150 / 72%. These are product settings, not an MCA-approved legibility threshold. Low-resolution originals are not made clearer by resampling. |
| Rasterization | Opt-in only, after the ordinary merge cannot fit. Removes searchable/selectable PDF text, tags and bookmarks. No OCR. |
| Page integrity | Every input page stays in file order. Generated output is reopened, counted and rendered page by page before a preview is offered. |
| Review | Visit every output page and confirm readability before download. The acknowledgement cannot prove a human actually inspected the content. |
| Resource bounds | 40 files, 40 MB/file, 100 MB total input, 200 pages. Images ≤32 million pixels and ≤16,000 pixels per side. Render surfaces ≤16 million pixels. |
| Reordering/settings change | Discard the old result. The new configuration must be prepared and reviewed again. |
| Clear/cancel | Invalidate the active job, release file/preview references, destroy document tasks and revoke blob URLs. An active signed-compression worker is terminated. Initial file inspection and unsigned processing still use cooperative cancellation around synchronous parser work. |
| Signed-file compression | Preserve the entire signed prefix. Only reconstruct a supported unsigned certificate suffix. If the eligibility, integrity, rendering or size checks fail, no compressed result is offered. An unchanged original can be downloaded only if it fits. |

## Signed compression profile

`src/signed.js` is a deliberately strict subset reader. It does not repair PDFs. `src/signed.worker.js` runs it in a dedicated worker; an active job is terminated on cancellation or after 30 seconds. The worker is loaded with the page, so processing also works offline. PKI.js 3.4.1 and WebCrypto verify the detached CMS content digest and public-key signature before and after compression. Certificate-chain trust, expiry, revocation and legal validity are not checked.

Eligible inputs have one ordinary approval signature, one simple signature field, traditional xrefs with generation-zero objects and direct stream lengths, and exactly one unsigned update after the signed revision. That update may add a new `/DSS` containing only `/Certs`, update the catalog solely to reference it, and update plain `/Info` metadata. The signature must use `adbe.pkcs7.detached` or `ETSI.CAdES.detached` and SHA-256, SHA-384 or SHA-512. Every byte-range boundary is checked against the actual signature contents and signed revision EOF.

The worker deduplicates byte-identical certificate streams and applies Flate compression when smaller. It preserves every decoded certificate entry in its original array order, the latest Info values, document ID, signature contents and every byte through the signed revision. It builds only the unsigned suffix, reopens the result with the strict reader, repeats integrity checks, and compares the preserved data. The normal PDF renderer checks page count and renders every page before mandatory user review. No signed content is rasterized, merged or re-signed.

Certification permissions, multiple signatures, document timestamps, an existing signed DSS, OCSP/CRL/VRI data, further unsigned revisions, hybrid/xref/object streams, indirect stream lengths, duplicate dictionary keys, unindexed objects, unknown trailer entries, encryption and ambiguous structures are rejected. This limits compatibility deliberately. The original input is never mutated. If the signed prefix itself reaches the chosen limit, this method cannot make it fit.

Additional limits: 16 revisions, 30,000 object entries, nesting below 32, one million parsed values, up to 20,000 certificate entries, 256 distinct certificates, 65,536 bytes per certificate and 40 MB total decoded certificate data. These bounds and the worker deadline are not a formal memory sandbox.

The checked fixture shrank from 12,095,873 to 106,820 bytes. It deliberately repeats a certificate 14,000 times; this is evidence of the eligible mechanism, not expected savings for ordinary filings. See [the research record](research/signed-pdf/README.md) and [independent output checks](scripts/verify-signed-output.py). General compression of signed page bytes remains unsupported.

## Privacy: precise claims

The app never sends document contents or filenames to a server. It has no document-upload endpoint, persistent document store, cookies, localStorage, sessionStorage, IndexedDB, service worker, telemetry or analytics. Files are held in browser memory for the active session. Saving is a deliberate download action. Page reload starts with an empty workspace.

`connect-src 'none'` blocks fetch/XHR/beacon/WebSocket connections in the page. GitHub Pages does not send CSP response headers for worker scripts; the workers contain no document networking or persistence code. Scripts and worker code load from this site's origin. The host may cache website code and retain ordinary page access logs, including IP addresses. The app cannot control the browser's memory management, swap files, extensions, crash recovery or the user's downloads. It cannot promise forensic erasure or that “nothing is stored anywhere.”

Security headers are included for Cloudflare Pages in `src/_headers`. GitHub Pages does not apply that file: it receives the HTML meta CSP. Header-only protections, including `frame-ancestors`, need a host supporting custom response headers. CSP is defence in depth; it is not a defence against a compromised software supply chain or browser.

## MCA requirements and evidence

Research checked on **12 October 2026**. The quoted LinkedIn post is context, not a technical specification. Public MCA materials describe different scopes:

- [2020 SPICe+ FAQ, question 64](https://www.mca.gov.in/Ministry/pdf/SpicePlusFAQS_20112020.pdf): 6 MB for each PDF form. Historical source, not asserted as today's rule.
- [URC-1 instruction kit](https://www.mca.gov.in/content/dam/mca-aem-forms/instructionkits/Instruction%20Kit_URC-1.pdf): attachments totalling up to 10 MB.
- [RD-1 V3 instruction kit](https://www.mca.gov.in/content/dam/mca-aem-forms/instructionkits/Instruction_Kit_RD-1_v3.pdf): 2 MB per attachment and 10 MB total.
- [Adobe signed PDF restrictions](https://helpx.adobe.com/acrobat/desktop/e-sign-documents/learn-about-signatures/signed-pdf-limitations.html) and [digital signature technical reference](https://www.adobe.com/devnet-docs/acrobatetk/tools/DigSig/Acrobat_DigitalSignatures_in_PDF.pdf): why rewriting a signed file is not a safe compression strategy. The signed compressor preserves the signed revision and rebuilds only a supported unsigned certificate update, as specified above.

Direct requests to the MCA incorporation page and 2023 V3 FAQ returned HTTP 403 during research. Relevant indexed official excerpts were available. No authenticated MCA portal was accessed, no legal requirements were changed, and no live filing or acceptance test was performed. Confirm the current limit and whether it is per attachment, per form or aggregate in the actual filing workflow.

## Hosting and free alternatives

**GitHub Pages is suitable for this free personal utility.** There is no backend to scale or pay for. GitHub Free supports Pages on public repositories; visitors' document data is not placed in the repository. Respect the [Pages limits and use restrictions](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), including its restrictions on commercial SaaS hosting.

For a broader public service, **Cloudflare Pages** can serve the same `docs/` directory, with [custom security headers](https://developers.cloudflare.com/pages/configuration/headers/) and [free static asset requests](https://developers.cloudflare.com/pages/functions/pricing/). A server-based PDF processor is not required. Reliability comes from the parser/compressor, validation corpus, release review and dependency maintenance; paying for a server does not solve signature preservation.

For an immediate existing option on Windows, [PDF24 Creator](https://tools.pdf24.org/en/creator) is free for private and commercial use, supports drag-and-drop assembly/compression and works offline. It saves files locally as a desktop application; it is not the same ephemeral browser design. Its online tools use a different data flow. No recommendation here implies signed files can safely be recompressed.

“Jev” was not identified unambiguously from the request, so no capability or pricing claim is made about it.

## Development plan

1. **Current version:** browser-only merge, bounded compression, exact size gate, limited signed-certificate compression, unchanged-file checks, page review, conservative signature blocks and reproducible regression tests.
2. **Before recommending for sensitive production work:** independent security review; an authorised, sanitised corpus including Indian-script fonts, JPEG2000/JBIG2, rotations/crop boxes, multiple and timestamped signatures, damaged PDFs and large scans; visual comparisons against trusted renderers; browser/low-memory testing; accessibility review; live MCA field confirmation by a filing professional.
3. **Robustness work:** isolate all parsing/merging in a dedicated terminable worker with hard time and memory budgets, tighten PDF feature support, add loss-aware content checks, broaden offline font/CMap support, add performance budgets and fuzzing. Current parsing/merging can temporarily block the main thread; resource caps are not a sandbox against all malicious PDFs.
4. **Release operations:** run checks for each change, review dependency updates, use protected branches and CI, verify built assets match source, retain a rollback commit. `ci/check.yml.example` is a ready-to-install GitHub Actions check; publishing it as a workflow requires appropriate GitHub permissions.

No OCR, signing-key handling, cloud upload, automatic split, document editing, compliance advice or certificate trust validation is in scope.

See [TESTING.md](TESTING.md) for completed checks and limitations. All committed PDF fixtures are synthetic; no client documents or private keys are included.
