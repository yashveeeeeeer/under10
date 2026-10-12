# Signed validation-record compression: production method and proof

Implemented on 12 October 2026. This extends the browser worker to one supported unsigned DSS update containing certificates, CRLs, OCSP responses and VRI mappings. It does not make arbitrary signed PDFs compressible.

## Method

1. Strictly parse the revisions and identify one supported approval signature. Its ByteRange must match the actual Contents gap and an entire revision.
2. Verify the CMS content digest and public-key signature. Reject a target at or below the protected revision's length, with the exact byte count.
3. Accept only one later revision adding a new DSS, with unchanged catalog content and optional plain Info metadata. Validate its complete graph against an explicit schema. Unknown changes, aliases into signed objects, conflicting object types and mismatched VRI links fail closed.
4. Bound decompression while reading. Check ASN.1 resource limits and certificate, CRL and OCSP schemas. Losslessly compress streams and share only byte-identical records of the same type. Retain every array entry and VRI link.
5. Rebuild only that unsigned suffix. Keep the complete signed prefix byte for byte. Reparse and compare the decoded validation graph and metadata; verify the original CMS again.
6. Require a strictly smaller output below the selected limit. Render every page and require review before download. No signing keys, network requests or persistent document storage are needed.

The implementation is in [signed.js](../../src/signed.js), inside the existing cancellable worker. Its full compatibility and resource limits are in [TECHNICAL.md](../../TECHNICAL.md#signed-compression-profile). Multiple signatures, document timestamps, certification permissions, previously signed DSS data and unknown structures remain outside this profile.

## Measured results

These are generated PDFs with an explicit test CA. No licensed DSC credentials or MCA submission were used. The large CRL has 60,000 distinct revoked serial numbers, not repeated copies of one certificate. Savings depend on the unsigned records present in a real file.

| Case | Input bytes | Output bytes | Saved |
| --- | ---: | ---: | ---: |
| RSA, CRLs and OCSP, with VRI | 10,508,164 | 9,379,292 | 1,128,872 |
| RSA, OCSP and VRI | 19,994 | 19,963 | 31 |
| ECDSA, CRLs and OCSP, with VRI | 1,307,945 | 179,073 | 1,128,872 |

Node, local browser-worker downloads and live GitHub Pages downloads produced identical outputs. The release passed 60 Node checks, 48 local browser scenarios, four live revocation scenarios and the 11 existing DSC compatibility cases. The downloaded site assets matched the locally tested build. Independent verification uses OpenSSL CMS, pyHanko signature and modification-policy checks, and validation with revocation evidence required against the explicit test root. All signed prefixes, CMS values, ByteRanges, decoded DSS records, VRI links and Info/ID values matched. Every page's Poppler pixels matched. Browser tests run offline after loading the app and check for document network requests and storage writes.

The regression suite includes malformed evidence, CRL/OCSP decompression bombs, deeply nested ASN.1, cycles, VRI mismatches, page changes, unrelated objects, exact target boundaries and unsupported signatures. These checks demonstrate the supported method, not freedom from every possible bug.

## Why the other gap remains

For the accepted ByteRange `[0, a, b, c]`, the original signature protects bytes through offset `b + c`. The ByteRange numbers themselves are protected. A standalone PDF retaining that revision at those offsets cannot be shorter than `b + c`. Shortening the Contents placeholder moves the protected bytes after it; changing ByteRange to compensate invalidates the original signature.

If that floor already exceeds the target, an infrastructure change cannot make this preservation strategy fit. A fully signed 10,107,250-byte fixture is correctly refused at 10 MB. At a larger permitted limit it is returned byte-identically. The app reports the protected byte count and directs the user to prepare an unsigned original and sign it again. It never silently removes the original signature or calls a new signature preservation of the old one.

The independent verifier also tries ordinary pypdf and qpdf compression on that fixture. Both reduce its size but fail original CMS integrity. Incremental page compression retains CMS integrity but grows the file and fails the modification-policy check. None is an acceptable fallback. These experiments support the byte-preservation argument; they are not an exhaustive search of all conceivable signing schemes.

## Sources checked

- [ETSI EN 319 142-1, sections 5.4.2 and 6.3](https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/01.02.01_60/en_31914201v010201p.pdf): DSS evidence arrays, VRI links and signed ByteRange coverage. This establishes the format constraints, not an endorsement of this implementation.
- [pyHanko incremental-update analysis](https://docs.pyhanko.eu/en/latest/lib-guide/validation/diff-analysis.html): why cryptographic integrity must be distinguished from permission to change document content.
- [nSoftware PDFSign CompressDSS](https://cdn.nsoftware.com/help/EPJ/mac/PDFSign.htm): confirms compression of DSS content is a documented SDK feature. It does not establish general shrinking of existing signed page bytes. That commercial SDK was not used or tested.
- [iText signature mechanics](https://kb.itextpdf.com/itext/pdf-and-digital-signatures): the signed digest covers encoded file bytes, not just the appearance of pages.

## Reproduce

```sh
npm ci
npm run check
python -m pip install -r research/signed-pdf/requirements.txt -r research/signed-pdf/dsc-requirements.txt
python scripts/verify-revocation-output.py
```

OpenSSL and Poppler must be available for the independent verifier. Outputs stay in ignored `tmp/qa/revocation/`. The committed fixtures are reproducible with `python scripts/revocation-fixtures.py`; private test keys are generated in memory and never saved. Certificate randomness changes regenerated file hashes.

To check the deployment in PowerShell:

```powershell
$env:UNDER10_TEST_URL = 'https://yashveeeeeeer.github.io/under10/'
try { npx playwright test tests/browser/revocation.spec.js }
finally { Remove-Item Env:UNDER10_TEST_URL }
python scripts/verify-revocation-output.py live
```

The machine-readable [verification record](production-revocation-validation.json) records the tested output hashes and independent results. Physical devices, other browser engines, real DSC trust and MCA acceptance remain outside this work.
