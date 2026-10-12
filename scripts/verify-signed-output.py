"""Independent checks for the actual Node/browser compressor output.

Run after npm run check. Uses pyHanko, OpenSSL and Poppler. Test certificates
are explicitly trusted only inside this local check; no network is needed.
"""
from pathlib import Path
import gzip
import hashlib
import io
import json
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
for directory in ('tmp/qa-python', 'tmp/research-python'):
    sys.path.insert(0, str(ROOT / directory))
from asn1crypto import cms
from PIL import Image
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext

OUT = ROOT / 'tmp/qa/signed-independent'
OUT.mkdir(parents=True, exist_ok=True)
openssl = shutil.which('openssl') or 'C:/Program Files/Git/usr/bin/openssl.exe'
before = gzip.decompress((ROOT / 'tests/data/signed-certificates.pdf.gz').read_bytes())
prefix = (ROOT / 'tests/data/signed-synthetic.pdf').read_bytes()

def encoded(obj):
    out = io.BytesIO()
    obj.write_to_stream(out)
    return out.getvalue()

def check(data, name):
    reader = PdfFileReader(io.BytesIO(data), strict=True)
    assert len(reader.embedded_signatures) == 1
    sig = reader.embedded_signatures[0]
    ranges = list(map(int, sig.byte_range))
    signed_content = b''.join(data[a:a + n] for a, n in zip(ranges[::2], ranges[1::2]))
    status = validate_pdf_signature(sig, signer_validation_context=ValidationContext(
        trust_roots=[sig.signer_cert], allow_fetching=False))
    assert status.intact and status.valid and status.trusted and status.docmdp_ok and status.bottom_line
    (OUT / 'cms.der').write_bytes(cms.ContentInfo.load(sig.pkcs7_content).dump())
    (OUT / 'content.bin').write_bytes(signed_content)
    result = subprocess.run([openssl, 'cms', '-verify', '-binary', '-inform', 'DER', '-noverify',
                             '-in', str(OUT / 'cms.der'), '-content', str(OUT / 'content.bin')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
    assert result.returncode == 0, result.stderr.decode(errors='replace')
    pdf_path = OUT / f'{name}.pdf'
    pdf_path.write_bytes(data)
    subprocess.run(['pdftoppm', '-r', '96', '-png', '-singlefile', str(pdf_path), str(OUT / name)],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
    with Image.open(OUT / f'{name}.png') as img:
        pixels = hashlib.sha256(img.convert('RGB').tobytes()).hexdigest()
    return {
        'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
        'signed_bytes_sha256': hashlib.sha256(signed_content).hexdigest(),
        'cms_sha256': hashlib.sha256(sig.pkcs7_content).hexdigest(),
        'byte_range': ranges, 'openssl_content_verified': True,
        'pyhanko_intact': status.intact, 'pyhanko_valid': status.valid,
        'trusted_test_root_only': status.trusted, 'docmdp_ok': status.docmdp_ok,
        'coverage': status.coverage.name, 'modification_level': status.modification_level.name,
        'pixel_sha256': pixels,
    }, reader

report = {}
report['input'], original = check(before, 'input')
names = sys.argv[1:] or ['signed-compressed-node.pdf', 'signed-compressed-browser.pdf']
for filename in names:
    data = (ROOT / 'tmp/qa' / filename).read_bytes()
    label = Path(filename).stem
    assert data[:len(prefix)] == prefix and len(data) < 10_000_000
    record, reader = check(data, label)
    for key in ['signed_bytes_sha256', 'cms_sha256', 'byte_range', 'pixel_sha256']:
        assert record[key] == report['input'][key], key
    a = [entry.get_object().data for entry in original.root['/DSS']['/Certs']]
    b = [entry.get_object().data for entry in reader.root['/DSS']['/Certs']]
    assert a == b
    assert encoded(original.trailer['/Info']) == encoded(reader.trailer['/Info'])
    assert encoded(original.trailer['/ID']) == encoded(reader.trailer['/ID'])
    record.update({'signed_prefix_identical': True, 'certificate_entries_preserved': len(a),
                   'info_and_id_preserved': True})
    report[label] = record
(OUT / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
