"""Independent production-output checks: OpenSSL, pyHanko and Poppler.

Run after npm run check. Optional arguments select output suffixes, e.g. live.
No certificate/status fetches. Uses only an explicit test root and a validation
moment from the fixture, so archived fixtures do not fail merely with age.
"""
from pathlib import Path
from importlib import util
from datetime import timedelta
import gzip
import io
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
spec = util.spec_from_file_location('revocation_lab', ROOT / 'scripts/research-dsc-revocation.py')
lab = util.module_from_spec(spec)
spec.loader.exec_module(lab)
OUT = ROOT / 'tmp/qa/revocation'
OUT.mkdir(parents=True, exist_ok=True)
lab.OUT = lab.lab.OUT = OUT
root = lab.ax509.Certificate.load((ROOT / 'tests/data/revocation-test-root.der').read_bytes())
manifest = json.loads((ROOT / 'tests/data/revocation-manifest.json').read_text())
results = []
for c in manifest:
    original = gzip.decompress((ROOT / ('tests/data/' + c['name'] + '.pdf.gz')).read_bytes())
    original_path = OUT / (c['name'] + '-input.pdf')
    original_path.write_bytes(original)
    before = lab.lab.inspect(original, [root])
    parsed = lab.PdfFileReader(io.BytesIO(original), strict=True)
    pixels = lab.render(original_path)
    for suffix in sys.argv[1:] or ['node', 'browser']:
        path = OUT / (c['name'] + '-' + suffix + '.pdf')
        output = path.read_bytes()
        assert output[:c['signed_bytes']] == original[:c['signed_bytes']]
        assert len(output) < min(len(original), 10_000_000)
        after = lab.lab.inspect(output, [root])
        identities = lambda r: [(s['byte_range'], s['cms_sha256'], s['signed_bytes_sha256']) for s in r['signatures']]
        assert identities(before) == identities(after)
        for report in (before, after):
            assert all(s['openssl_content_verified'] and s['intact'] and s['cms_valid'] and s['docmdp_ok'] for s in report['signatures'])
        reopened = lab.PdfFileReader(io.BytesIO(output), strict=True)
        assert lab.dss_snapshot(parsed.root['/DSS']) == lab.dss_snapshot(reopened.root['/DSS'])
        for key in ('/Info', '/ID'):
            assert lab.encoded(parsed.trailer[key]) == lab.encoded(reopened.trailer[key])
        material = lab.DocumentSecurityStore.read_dss(reopened)
        # Derive a stable validation moment from generated test certificate data.
        moment = root['tbs_certificate']['validity']['not_before'].native + timedelta(days=1)
        context = material.as_validation_context({'trust_roots': [root], 'allow_fetching': False,
                                                 'revocation_mode': 'require', 'moment': moment})
        for sig in reopened.embedded_signatures:
            status = lab.validate_pdf_signature(sig, signer_validation_context=context)
            assert status.intact and status.valid and status.trusted and status.docmdp_ok, status.pretty_print_details()
        assert pixels == lab.render(path)
        results.append({'name': c['name'], 'engine': suffix, 'input_bytes': len(original), 'output_bytes': len(output),
                        'signed_bytes': c['signed_bytes'], 'saved_bytes': len(original) - len(output),
                        'signed_prefix_identical': True, 'cms_and_ranges_identical': True,
                        'all_dss_records_and_links_identical': True, 'metadata_identical': True,
                        'all_page_pixels_identical': True, 'test_chain_with_required_revocation_valid': True,
                        'validation_moment': moment.isoformat(), 'input': before, 'output': after})
        print(c['name'], suffix, len(original), '->', len(output), flush=True)
fully_signed = gzip.decompress((ROOT / 'tests/data/signed-over-limit-synthetic.pdf.gz').read_bytes())
signed_reader = lab.PdfFileReader(io.BytesIO(fully_signed), strict=True)
test_roots = [s.signer_cert for s in signed_reader.embedded_signatures]
original_check = lab.lab.inspect(fully_signed, test_roots)
assert all(s['openssl_content_verified'] and s['coverage'] == 'ENTIRE_FILE' for s in original_check['signatures'])
attempts = []
for name, method in [('pypdf-rewrite', lab.lab.pypdf_rewrite), ('qpdf-rewrite', lab.lab.qpdf_rewrite),
                     ('incremental-page-compression', lab.lab.incremental_recompression)]:
    candidate = method(fully_signed)
    checked = lab.lab.inspect(candidate, test_roots)
    assert checked['signatures']
    if name.endswith('rewrite'):
        assert len(candidate) < len(fully_signed)
        assert all(not s['openssl_content_verified'] and not s['intact'] for s in checked['signatures'])
    else:
        assert len(candidate) > len(fully_signed)
        assert all(s['openssl_content_verified'] and not s['docmdp_ok'] for s in checked['signatures'])
    attempts.append({'method': name, 'meets_preservation_and_size_requirements': False, **checked})
report = {'scope': 'Production code, generated test CA. No real DSC credentials or MCA submission.', 'cases': results,
          'fully_signed_counterexample': {'original': original_check, 'attempts': attempts}}
(OUT / ('verified-' + '-'.join(sys.argv[1:] or ['node', 'browser']) + '.json')).write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print('Independently verified', len(results), 'production outputs.')
