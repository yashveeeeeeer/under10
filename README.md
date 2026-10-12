# Under10

A free, browser-only workspace for preparing unsigned PDFs and images under a chosen file-size limit. Built for document preparation around workflows such as MCA filings; independent of MCA.

**Live site:** https://yashveeeeeeer.github.io/under10/

**Status:** tested beta. This is not an MCA acceptance checker, signature validator, signing service or legal tool.

## Two workflows

- **Build a PDF:** drop PDFs, JPEGs and PNGs; order the files; choose a decimal MB limit up to 10; prepare, review every page and download. Native PDF text/vectors are copied first. Colour images use bounded compression. Rasterizing unsigned PDF pages requires the explicit “Allow scan compression” option.
- **Check an existing PDF:** select one PDF, check its exact byte count and download the original bytes unchanged. This is the path for previously signed documents. SHA-256 identifies the original bytes; it does not validate a signature.

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
| Signing headroom | Default target = 90% of limit (9,000,000 bytes at 10 MB). With headroom unchecked, target = 98%. This cannot guarantee the eventual signed file size. |
| Cannot fit | Stop with no downloadable result. Never omit a page or secretly reduce quality below the configured floor. |
| Existing signature | Inspect decoded PDF objects and conservative raw/historical/escaped-name markers. Signature fields, including blank ones, are check-only. No cryptographic trust decision is made. |
| Ambiguous/unsupported PDF | Encrypted, damaged or unreadable inputs fail. Forms, annotations, scripts/actions, portfolios and embedded attachments cannot be transformed. |
| Quality | Colour JPEG attempts: 220 DPI / 90%, 190 / 84%, 170 / 78%, 150 / 72%. These are product settings, not an MCA-approved legibility threshold. Low-resolution originals are not made clearer by resampling. |
| Rasterization | Opt-in only, after the ordinary merge cannot fit. Removes searchable/selectable PDF text, tags and bookmarks. No OCR. |
| Page integrity | Every input page stays in file order. Generated output is reopened, counted and rendered page by page before a preview is offered. |
| Review | Visit every output page and confirm readability before download. The acknowledgement cannot prove a human actually inspected the content. |
| Resource bounds | 40 files, 40 MB/file, 100 MB total input, 200 pages. Images ≤32 million pixels and ≤16,000 pixels per side. Render surfaces ≤16 million pixels. |
| Reordering/settings change | Discard the old result. The new configuration must be prepared and reviewed again. |
| Clear/cancel | Invalidate the active job, release file/preview references, destroy document tasks and revoke blob URLs. Cancellation is cooperative around synchronous parser work. |
| Signed-file check | Never serialize, rasterize or rewrite the original. Identical bytes on output; oversized originals stay blocked. |

## Privacy: precise claims

The app never sends document contents or filenames to a server. It has no document-upload endpoint, persistent document store, cookies, localStorage, sessionStorage, IndexedDB, service worker, telemetry or analytics. Files are held in browser memory for the active session. Saving is a deliberate download action. Page reload starts with an empty workspace.

`connect-src 'none'` blocks fetch/XHR/beacon/WebSocket connections. Scripts and worker code load from this site's origin. The host may cache website code and retain ordinary page access logs, including IP addresses. The app cannot control the browser's memory management, swap files, extensions, crash recovery or the user's downloads. It cannot promise forensic erasure or that “nothing is stored anywhere.”

Security headers are included for Cloudflare Pages in `src/_headers`. GitHub Pages does not apply that file: it receives the HTML meta CSP. Header-only protections, including `frame-ancestors`, need a host supporting custom response headers. CSP is defence in depth; it is not a defence against a compromised software supply chain or browser.

## MCA requirements and evidence

Research checked on **12 October 2026**. The quoted LinkedIn post is context, not a technical specification. Public MCA materials describe different scopes:

- [2020 SPICe+ FAQ, question 64](https://www.mca.gov.in/Ministry/pdf/SpicePlusFAQS_20112020.pdf): 6 MB for each PDF form. Historical source, not asserted as today's rule.
- [URC-1 instruction kit](https://www.mca.gov.in/content/dam/mca-aem-forms/instructionkits/Instruction%20Kit_URC-1.pdf): attachments totalling up to 10 MB.
- [RD-1 V3 instruction kit](https://www.mca.gov.in/content/dam/mca-aem-forms/instructionkits/Instruction_Kit_RD-1_v3.pdf): 2 MB per attachment and 10 MB total.
- [Adobe signed PDF restrictions](https://helpx.adobe.com/acrobat/desktop/e-sign-documents/learn-about-signatures/signed-pdf-limitations.html) and [digital signature technical reference](https://www.adobe.com/devnet-docs/acrobatetk/tools/DigSig/Acrobat_DigitalSignatures_in_PDF.pdf): why rewriting a signed file is not a safe compression strategy. Permitted incremental updates are a separate mechanism; this app performs none.

Direct requests to the MCA incorporation page and 2023 V3 FAQ returned HTTP 403 during research. Relevant indexed official excerpts were available. No authenticated MCA portal was accessed, no legal requirements were changed, and no live filing or acceptance test was performed. Confirm the current limit and whether it is per attachment, per form or aggregate in the actual filing workflow.

## Hosting and free alternatives

**GitHub Pages is suitable for this free personal utility.** There is no backend to scale or pay for. GitHub Free supports Pages on public repositories; visitors' document data is not placed in the repository. Respect the [Pages limits and use restrictions](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), including its restrictions on commercial SaaS hosting.

For a broader public service, **Cloudflare Pages** can serve the same `docs/` directory, with [custom security headers](https://developers.cloudflare.com/pages/configuration/headers/) and [free static asset requests](https://developers.cloudflare.com/pages/functions/pricing/). A server-based PDF processor is not required. Reliability comes from the parser/compressor, validation corpus, release review and dependency maintenance; paying for a server does not solve signature preservation.

For an immediate existing option on Windows, [PDF24 Creator](https://tools.pdf24.org/en/creator) is free for private and commercial use, supports drag-and-drop assembly/compression and works offline. It saves files locally as a desktop application; it is not the same ephemeral browser design. Its online tools use a different data flow. No recommendation here implies signed files can safely be recompressed.

“Jev” was not identified unambiguously from the request, so no capability or pricing claim is made about it.

## Development plan

1. **Current beta:** browser-only merge, bounded compression, exact size gate, unchanged-file checks, page review, conservative signature blocks and reproducible regression tests.
2. **Before recommending for sensitive production work:** independent security review; an authorised, sanitised corpus including Indian-script fonts, JPEG2000/JBIG2, rotations/crop boxes, multiple and timestamped signatures, damaged PDFs and large scans; visual comparisons against trusted renderers; browser/low-memory testing; accessibility review; live MCA field confirmation by a filing professional.
3. **Robustness work:** isolate all parsing/merging in a dedicated terminable worker with hard time and memory budgets, tighten PDF feature support, add loss-aware content checks, broaden offline font/CMap support, add performance budgets and fuzzing. Current parsing/merging can temporarily block the main thread; resource caps are not a sandbox against all malicious PDFs.
4. **Release operations:** run checks for each change, review dependency updates, use protected branches and CI, verify built assets match source, retain a rollback commit. `ci/check.yml.example` is a ready-to-install GitHub Actions check; publishing it as a workflow requires appropriate GitHub permissions.

No OCR, signing-key handling, cloud upload, automatic split, document editing, compliance advice or certificate validation is in scope.

See [TESTING.md](TESTING.md) for completed checks and limitations. All committed PDF fixtures are synthetic; no client documents or private keys are included.
