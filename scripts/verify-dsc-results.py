"""Verify the DSC compatibility browser downloads with independent libraries."""
from pathlib import Path
import hashlib
import io
import json
import logging
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
for directory in ('tmp/qa-python', 'tmp/research-python'):
    sys.path.insert(0, str(ROOT / directory))
from asn1crypto import cms, x509
from PIL import Image
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext
logging.basicConfig(level=logging.CRITICAL)
OUT = ROOT / 'tmp/qa/dsc'
openssl = shutil.which('openssl') or 'C:/Program Files/Git/usr/bin/openssl.exe'
root = x509.Certificate.load((OUT / 'test-root.der').read_bytes())
report = json.loads((OUT / 'browser-results.json').read_text(encoding='utf-8'))

def digest(b): return hashlib.sha256(b).hexdigest()
def encoded(obj):
    output = io.BytesIO(); obj.write_to_stream(output); return output.getvalue()

def inspect(data, external=False):
    reader = PdfFileReader(io.BytesIO(data), strict=True)
    signatures = []
    for sig in reader.embedded_signatures:
        ranges = list(map(int, sig.byte_range))
        content = b''.join(data[a:a + n] for a, n in zip(ranges[::2], ranges[1::2]))
        (OUT / 'verify-cms.der').write_bytes(cms.ContentInfo.load(sig.pkcs7_content).dump())
        (OUT / 'verify-content.bin').write_bytes(content)
        result = subprocess.run([openssl, 'cms', '-verify', '-binary', '-inform', 'DER', '-noverify',
            '-in', str(OUT / 'verify-cms.der'), '-content', str(OUT / 'verify-content.bin')],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
        assert result.returncode == 0, result.stderr.decode(errors='replace')
        status = validate_pdf_signature(sig, signer_validation_context=ValidationContext(
            trust_roots=[] if external else [root], allow_fetching=False))
        assert status.intact and status.valid and status.docmdp_ok
        if not external: assert status.trusted
        signatures.append({'cms_sha256': digest(sig.pkcs7_content), 'signed_bytes_sha256': digest(content),
            'byte_range': ranges, 'openssl_verified': True, 'intact': status.intact, 'valid': status.valid,
            'test_root_chain_valid': None if external else status.trusted,
            'public_certificate_trust_checked': False, 'modification_level': status.modification_level.name,
            'issuer': sig.signer_cert.issuer.human_friendly if external else 'Under10 TEST ISSUING CA',
            'subfilter': str(sig.sig_object.get('/SubFilter')), 'public_key_algorithm': sig.signer_cert.public_key.algorithm,
            'public_key_bits': sig.signer_cert.public_key.bit_size})
    assert signatures
    return signatures, reader

def render(path, label):
    subprocess.run(['pdftoppm', '-r', '96', '-png', '-singlefile', str(path), str(OUT / label)],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
    with Image.open(OUT / f'{label}.png') as img: return digest(img.convert('RGB').tobytes())

for case in report['cases']:
    name = case['name']; original = (OUT / f'{name}.pdf').read_bytes()
    before, reader = inspect(original, external=bool(case.get('source')))
    case['input_signature_checks'] = before
    if case['outcome'] == 'blocked': continue
    output_path = OUT / f'{name}-download.pdf'; output = output_path.read_bytes()
    after, reopened = inspect(output, external=bool(case.get('source')))
    for a, b in zip(before, after):
        for k in ['cms_sha256', 'signed_bytes_sha256', 'byte_range']: assert a[k] == b[k]
    assert len(before) == len(after)
    case['output_signature_checks'] = after
    case['signature_identities_preserved'] = True
    if case['outcome'] == 'unchanged':
        assert output == original; case['byte_identical'] = True
    else:
        prefix = (OUT / case['prefix_file']).read_bytes()
        assert output[:len(prefix)] == prefix
        assert [x.get_object().data for x in reader.root['/DSS']['/Certs']] == [x.get_object().data for x in reopened.root['/DSS']['/Certs']]
        assert encoded(reader.trailer['/Info']) == encoded(reopened.trailer['/Info'])
        assert encoded(reader.trailer['/ID']) == encoded(reopened.trailer['/ID'])
        assert render(OUT / f'{name}.pdf', name + '-before') == render(output_path, name + '-after')
        case.update({'signed_prefix_identical': True, 'visible_signature_pixels_identical': True,
                     'certificate_chain_and_metadata_preserved': True})
public_samples = sum(bool(case.get('source')) for case in report['cases'])
report['scope'] = f'Test CA chains plus {public_samples} public signed PDF(s). No USB token, private DSC, fresh revocation or MCA submission was tested.'
(OUT / 'verified-results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'cases_verified': len(report['cases']), 'cases': [{k: c[k] for k in ['name', 'input_bytes', 'outcome', 'saved'] if k in c} for c in report['cases']], 'scope': report['scope']}, indent=2))
