"""Generate a synthetic, cryptographically signed regression fixture. Never uses a real DSC."""
import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
import io

sys.path.insert(0, str(Path('tmp/qa-python').resolve()))
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from asn1crypto import keys, x509 as asn1_x509
from pyhanko.sign import signers
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext
from pyhanko_certvalidator.registry import SimpleCertificateStore
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter

root = Path('tests/data'); root.mkdir(parents=True, exist_ok=True)
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Under10 synthetic test certificate')])
now = datetime.now(timezone.utc)
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False,
             data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False,
             encipher_only=None, decipher_only=None), critical=True).sign(key, hashes.SHA256()))
asn_cert = asn1_x509.Certificate.load(cert.public_bytes(serialization.Encoding.DER))
signer = signers.SimpleSigner(signing_cert=asn_cert,
    signing_key=keys.PrivateKeyInfo.load(key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())),
    cert_registry=SimpleCertificateStore())
buf = io.BytesIO(); c = canvas.Canvas(buf); c.drawString(55, 780, 'SYNTHETIC SIGNATURE REGRESSION TEST'); c.drawString(55, 750, 'Not a legal document. No personal data.'); c.save(); buf.seek(0)
with open(root / 'signed-synthetic.pdf', 'wb') as out:
    signers.sign_pdf(IncrementalPdfFileWriter(buf), signature_meta=signers.PdfSignatureMetadata(field_name='TestSignature'), signer=signer, output=out)
(root / 'synthetic-certificate.der').write_bytes(cert.public_bytes(serialization.Encoding.DER))
with open(root / 'signed-synthetic.pdf', 'rb') as stream:
    sig = PdfFileReader(stream).embedded_signatures[0]
    status = validate_pdf_signature(sig, signer_validation_context=ValidationContext(trust_roots=[asn_cert], allow_fetching=False))
    assert status.intact and status.valid and status.trusted, status.summary()
    print('Synthetic input signature: intact, valid and trusted against the test-only root.')
buf.seek(0); writer = PdfWriter(); writer.append(PdfReader(buf)); writer.encrypt('synthetic-test-password')
with open(root / 'encrypted-synthetic.pdf', 'wb') as stream: writer.write(stream)
# Private key exists in this process only. Only the public certificate and synthetic PDFs are saved.
