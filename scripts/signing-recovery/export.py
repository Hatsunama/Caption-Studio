"""One-time, fail-closed CMS export. Standard library plus OpenSSL 3.0+ and Java 17 keytool."""
import argparse
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

RECIPIENT_SHA256 = '5be66294eff75a2c9aee7ca70d71b94c740113a768f26f46b6c75346cc72e6a4'
SIGNING_SHA256 = 'd02d23b28cbc615e3686d181aedefbbe5de993a0b6ba3f8e4ea2b6160211b35f'
FILES = ('keystore.p12', 'store-password.txt', 'key-password.txt', 'alias.txt')
SECRET_NAMES = ('CAPTION_STUDIO_FIXED_KEYSTORE_BASE64', 'CAPTION_STUDIO_FIXED_STORE_PASSWORD',
                'CAPTION_STUDIO_FIXED_KEY_PASSWORD', 'CAPTION_STUDIO_FIXED_KEY_ALIAS')
FAILURE = 'Signing recovery failed. No recovery artifact was published.\n'


def captured_tool(executable, args, *, data=None, password=None):
    # Do not inherit credentials, Java options, or tool configuration overrides.
    env = {name: os.environ[name] for name in ('PATH', 'SystemRoot', 'TEMP', 'TMP') if name in os.environ}
    env['OPENSSL_CONF'] = os.devnull
    if password is not None:
        env['RECOVERY_STORE_PASSWORD'] = password
    result = subprocess.run([executable, *map(str, args)], input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, timeout=60, check=False)
    if result.returncode:
        # Never emit child output, argv, values, or exception details.
        raise ValueError('Recovery tool failed')
    return result.stdout


def openssl(args, *, executable, data=None):
    return captured_tool(executable, args, data=data)


def signing_certificate(store, password, executable):
    # Java 17 detects JKS/PKCS12 from contents, regardless of the filename.
    # List public certificates only; never pass the secret alias in argv or export keys.
    certs = captured_tool(executable, [
        '-J-Xms16m', '-J-Xmx64m', '-J-XX:ActiveProcessorCount=1',
        '-list', '-rfc', '-keystore', store, '-storepass:env', 'RECOVERY_STORE_PASSWORD'], password=password)
    certificates = re.findall(b'-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----', certs)
    if len(certificates) != 1 or certs.count(b'-----BEGIN CERTIFICATE-----') != 1:
        raise ValueError('Ambiguous signing certificate')
    return base64.b64decode(certificates[0].replace(b'\r', b'').replace(b'\n', b''), validate=True)


def private_file(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)


def checked_output(value):
    runner = Path(os.environ['RUNNER_TEMP'])
    if not runner.is_absolute() or not runner.is_dir() or runner.is_symlink():
        raise ValueError('Invalid temporary root')
    runner = runner.resolve(strict=True)
    output = Path(value)
    # Only a new, immediate child of the trusted runner temp root; no traversal/symlinks.
    if '..' in output.parts or not output.is_absolute() or output.parent != runner:
        raise ValueError('Invalid output path')
    if output.exists() or output.is_symlink():
        raise ValueError('Output already exists')
    return runner, output


def export(args):
    runner, output = checked_output(args.output_dir)
    run = lambda cmd, **kw: openssl(cmd, executable=args.openssl, **kw)
    # Validate the out-of-band recipient pin and expiry BEFORE reading credentials.
    der = run(['x509', '-in', Path(args.recipient), '-outform', 'DER'])
    if hashlib.sha256(der).hexdigest() != RECIPIENT_SHA256:
        raise ValueError('Wrong recipient')
    run(['x509', '-inform', 'DER', '-checkend', '0', '-noout'], data=der)
    recipient_pem = run(['x509', '-inform', 'DER', '-outform', 'PEM'], data=der)
    # Remove secrets from this process environment before invoking any child.
    values = [os.environ.pop(name, '') for name in SECRET_NAMES]
    if any(not value or len(value) > 1024 * 1024 for value in values):
        raise ValueError('Missing or oversized secret')
    for value in values[1:]:
        if len(value.encode('utf-8')) > 4096 or any(c in value for c in ('\0', '\r', '\n')):
            raise ValueError('Malformed text secret')
    # GNU base64 --decode accepts LF wrapping, but not arbitrary ignored garbage.
    keystore = base64.b64decode(values[0].replace('\n', ''), validate=True)
    if not keystore or len(keystore) > 512 * 1024:
        raise ValueError('Invalid keystore')
    # mkdtemp is 0700; explicit umask in main also protects OpenSSL-created files.
    with tempfile.TemporaryDirectory(prefix='solana-recovery-private-', dir=runner) as temp:
        temp = Path(temp)
        os.chmod(temp, 0o700)
        # Snapshot the validated public certificate to avoid a path replacement race.
        recipient_copy = temp / 'recipient.crt'
        private_file(recipient_copy, recipient_pem)
        p12 = temp / 'keystore.p12'
        private_file(p12, keystore)
        signing_der = signing_certificate(p12, values[1], args.keytool)
        if hashlib.sha256(signing_der).hexdigest() != SIGNING_SHA256:
            raise ValueError('Wrong signing certificate')
        # Raw bytes preserved; UTF-8 text has no added newline. No schema file in ZIP.
        payload = temp / 'payload.zip'
        fd = os.open(payload, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as stream, zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED) as archive:
            for name, data in zip(FILES, (keystore, *(value.encode('utf-8') for value in values[1:]))):
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = 0o100600 << 16
                archive.writestr(info, data)
        p12.unlink()
        encrypted = temp / 'recovery.p7m'
        run(['cms', '-encrypt', '-aes-256-gcm', '-binary', '-outform', 'DER',
             '-in', payload, '-out', encrypted, '-recip', recipient_copy,
             '-keyopt', 'rsa_padding_mode:oaep', '-keyopt', 'rsa_oaep_md:sha256',
             '-keyopt', 'rsa_mgf1_md:sha256'])
        payload.unlink()
        if not encrypted.is_file() or encrypted.stat().st_size == 0:
            raise ValueError('Missing ciphertext')
        version = run(['version']).decode('ascii').strip()
        manifest = {
            'schema_version': 1,
            'envelope': 'CMS AuthEnvelopedData DER',
            'content_encryption': 'AES-256-GCM',
            'key_transport': 'RSA-OAEP',
            'oaep_digest': 'SHA-256',
            'mgf1_digest': 'SHA-256',
            'openssl_version': version,
            'exporter_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'ciphertext_file': 'recovery.p7m',
            'ciphertext_sha256': hashlib.sha256(encrypted.read_bytes()).hexdigest(),
            'recipient_certificate_der_sha256': RECIPIENT_SHA256,
            'expected_signing_certificate_der_sha256': SIGNING_SHA256,
            'payload': {
                'schema_version': 1,
                'format': 'ZIP_STORED',
                'files': list(FILES),
                'keystore_encoding': 'original base64-decoded keystore bytes (JKS or PKCS#12)',
                'text_encoding': 'UTF-8 without added newline',
                'extra_entries_allowed': False,
                'paths_allowed': False,
            },
        }
        manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode('utf-8')
        ciphertext_bytes = encrypted.read_bytes()
    # Complete temporary cleanup BEFORE publishing any output. Atomic exclusive mkdir
    # reserves the destination; no final path exists until validation/cleanup succeeds.
    output.mkdir(mode=0o700)
    try:
        private_file(output / 'recovery.p7m', ciphertext_bytes)
        private_file(output / 'manifest.json', manifest_bytes)
    except BaseException:
        shutil.rmtree(output)
        raise


def main(argv=None):
    previous_umask = os.umask(0o077)
    try:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--recipient', default=str(Path(__file__).with_name('recipient.crt')))
        parser.add_argument('--output-dir', required=True)
        parser.add_argument('--openssl', default='openssl')
        parser.add_argument('--keytool', default='keytool')
        args = parser.parse_args(argv)
        export(args)
        return 0
    except (Exception, KeyboardInterrupt):
        sys.stderr.write(FAILURE)
        return 1
    finally:
        os.umask(previous_umask)


if __name__ == '__main__':
    sys.exit(main())
