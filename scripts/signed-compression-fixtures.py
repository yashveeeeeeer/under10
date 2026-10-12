"""Generate signed regression inputs locally. Private keys never leave memory."""
from pathlib import Path
from datetime import datetime, timedelta, timezone
import gzip
import io
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tmp/qa-python'))
from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from asn1crypto import keys, x509 as asn_x509
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign import signers
from pyhanko.sign.timestamps import DummyTimeStamper
from pyhanko_certvalidator.registry import SimpleCertificateStore
from pyhanko.sign.validation import validate_pdf_signature, validate_pdf_timestamp
from pyhanko_certvalidator import ValidationContext

DATA = ROOT / 'tests/data'
source = (DATA / 'signed-synthetic.pdf').read_bytes()
public = (DATA / 'synthetic-certificate.der').read_bytes()

def store(name, data):
    (DATA / f'{name}.pdf.gz').write_bytes(gzip.compress(data, mtime=0))
    print(name, len(data))

def certificates(data, count):
    writer = IncrementalPdfFileWriter(io.BytesIO(data))
    entries = generic.ArrayObject([writer.add_object(generic.StreamObject(stream_data=public)) for _ in range(count)])
    writer.root[generic.pdf_name('/DSS')] = writer.add_object(generic.DictionaryObject({generic.pdf_name('/Certs'): entries}))
    writer.update_root()
    output = io.BytesIO(); writer.write(output)
    return output.getvalue()

# The large certificate-only fixture originally came from the feasibility lab.
# Pass --refresh-positive to regenerate it using this equivalent generator.
if '--refresh-positive' in sys.argv or not (DATA / 'signed-certificates.pdf.gz').exists():
    store('signed-certificates', certificates(source, 14_000))

positive = gzip.decompress((DATA / 'signed-certificates.pdf.gz').read_bytes())
writer = IncrementalPdfFileWriter(io.BytesIO(positive))
writer.update_root()
output = io.BytesIO(); writer.write(output)
store('signed-extra-revision', output.getvalue())

def identity(tsa=False):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(timezone.utc)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Under10 test-only timestamp' if tsa else 'Under10 second test signer')])
    builder = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
               .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(days=1))
               .not_valid_after(now + timedelta(days=3650))
               .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
               .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False,
                   data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False,
                   encipher_only=None, decipher_only=None), critical=True))
    if tsa: builder = builder.add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.TIME_STAMPING]), critical=True)
    cert = builder.sign(key, hashes.SHA256())
    return asn_x509.Certificate.load(cert.public_bytes(serialization.Encoding.DER)), keys.PrivateKeyInfo.load(
        key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))

cert, key = identity()
signer = signers.SimpleSigner(signing_cert=cert, signing_key=key, cert_registry=SimpleCertificateStore())
output = io.BytesIO()
signers.sign_pdf(IncrementalPdfFileWriter(io.BytesIO(source)),
                 signature_meta=signers.PdfSignatureMetadata(field_name='SecondSignature'), signer=signer, output=output)
multi = output.getvalue()
reader = PdfFileReader(io.BytesIO(multi), strict=True)
assert len(reader.embedded_signatures) == 2
for sig in reader.embedded_signatures:
    status = validate_pdf_signature(sig, signer_validation_context=ValidationContext(trust_roots=[sig.signer_cert], allow_fetching=False))
    assert status.intact and status.valid and status.trusted and status.docmdp_ok
store('signed-multiple', multi)

tsa_cert, tsa_key = identity(tsa=True)
output = io.BytesIO()
signers.PdfTimeStamper(DummyTimeStamper(tsa_cert=tsa_cert, tsa_key=tsa_key)).timestamp_pdf(
    IncrementalPdfFileWriter(io.BytesIO(source)), 'sha256', output=output,
    validation_context=ValidationContext(trust_roots=[tsa_cert], allow_fetching=False))
timestamped = output.getvalue()
reader = PdfFileReader(io.BytesIO(timestamped), strict=True)
timestamp = reader.embedded_signatures[-1]
assert timestamp.sig_object['/Type'] == '/DocTimeStamp'
status = validate_pdf_timestamp(timestamp, validation_context=ValidationContext(trust_roots=[tsa_cert], allow_fetching=False))
assert status.intact and status.valid and status.trusted
store('signed-timestamp', timestamped)
