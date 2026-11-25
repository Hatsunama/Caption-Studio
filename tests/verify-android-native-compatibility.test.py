import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.dont_write_bytecode = True


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


f = module(HERE/'native-compatibility-fixtures.py', 'fixtures')
GATE = ROOT/'scripts'/'verify-android-native-compatibility.py'


class NativeCompatibility(unittest.TestCase):
    def setUp(self):
        # Honor the user's write boundary during local verification.
        self.temp = tempfile.TemporaryDirectory(dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.paths = f.fixtures(self.root)
        self.contract = self.root/'contract.json'
        self.contract.write_text(json.dumps({'translation': {'minimumAndroidSdk': 26}}))

    def gate(self, fmt='apk', **kwargs):
        return module(GATE, 'gate').verify_archive(self.paths[fmt], fmt, self.root/'ndk', self.contract, **kwargs)

    def rewrite(self, name, data, fmt='apk'):
        with zipfile.ZipFile(self.paths[fmt]) as z:
            entries = {i.filename: z.read(i) for i in z.infolist()}
        entries[name] = data
        with zipfile.ZipFile(self.paths[fmt], 'w') as z:
            for n, b in entries.items(): z.writestr(n, b)

    def test_core_api26_rejected_in_both_actual_archive_formats(self):
        self.paths = f.fixtures(self.root, core_new=True)
        for fmt in ('apk', 'aab'):
            with self.subTest(fmt=fmt), self.assertRaisesRegex(ValueError, 'strtod_l.*LIBC_O'):
                self.gate(fmt)

    def test_optional_api26_allowed_without_raising_core_floor(self):
        for fmt in ('apk', 'aab'):
            result = self.gate(fmt)
            self.assertEqual(result['libraries'], 14)
            self.assertEqual(result['coreMinSdk'], 24)
            self.assertEqual(result['translationMinSdk'], 26)

    def omit_sqlite(self, abis, fmt):
        prefix = 'lib' if fmt == 'apk' else 'base/lib'
        omitted = {f'{prefix}/{abi}/libexpo-sqlite.so' for abi in abis}
        with zipfile.ZipFile(self.paths[fmt]) as z:
            entries = [(i, z.read(i)) for i in z.infolist() if i.filename not in omitted]
        with zipfile.ZipFile(self.paths[fmt], 'w') as z:
            for info, data in entries: z.writestr(info, data)

    def test_sqlite_required_on_every_abi_in_apk_and_aab(self):
        for fmt in ('apk', 'aab'):
            for missing in [(abi,) for abi in f.ABIS] + [('armeabi-v7a', 'x86', 'x86_64')]:
                with self.subTest(fmt=fmt, missing=missing):
                    self.paths = f.fixtures(self.root)
                    self.omit_sqlite(missing, fmt)
                    with self.assertRaisesRegex(ValueError, 'libexpo-sqlite[.]so'):
                        self.gate(fmt)

    def test_sqlite_is_checked_at_core_api24_in_both_formats(self):
        for fmt in ('apk', 'aab'):
            prefix = 'lib' if fmt == 'apk' else 'base/lib'
            self.rewrite(f'{prefix}/x86_64/libexpo-sqlite.so',
                         f.elf(imports=[('strtod_l', 1, 'LIBC_O')]), fmt)
            with self.subTest(fmt=fmt), self.assertRaisesRegex(ValueError, 'libexpo-sqlite[.]so API24.*strtod_l'):
                self.gate(fmt)

    def test_actual_producer_rejects_missing_sqlite_archive_bytes(self):
        for fmt in ('apk', 'aab'):
            self.paths = f.fixtures(self.root)
            self.omit_sqlite(('armeabi-v7a', 'x86', 'x86_64'), fmt)
            (self.root/'aab-native.zip').unlink(missing_ok=True)
            result = self.producer()
            with self.subTest(fmt=fmt):
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('libexpo-sqlite.so', result.stderr)

    def test_core_cannot_transitively_load_optional_library(self):
        self.rewrite('lib/x86_64/libreactnative.so', f.elf(needed=('liblitertlm_jni.so',)))
        with self.assertRaisesRegex(ValueError, 'strtod_l'):
            self.gate()

    def test_missing_needed_library_is_fatal_even_for_weak_imports(self):
        self.rewrite('lib/x86_64/libreactnative.so', f.elf(imports=[('missing', 2, None)], needed=('libabsent.so',)))
        with self.assertRaisesRegex(ValueError, 'libabsent.so'):
            self.gate()

    def test_missing_weak_symbol_allowed_but_strong_rejected(self):
        for binding in (2, 1):
            self.rewrite('lib/x86_64/libreactnative.so', f.elf(imports=[('unavailable', binding, None), ('strtod_l', binding, 'LIBC_O')]))
            if binding == 2: self.gate()
            else:
                with self.assertRaisesRegex(ValueError, 'unavailable'): self.gate()

    def test_optional_dependency_available_only_at26_is_not_checked_at24(self):
        self.rewrite('lib/x86_64/liblitertlm_jni.so', f.elf(imports=[('optional_api', 1, None)], needed=('libonly26.so',)))
        profile = next((self.root/'ndk').rglob('x86_64-linux-android/26/libc.so')).parent
        (profile/'libonly26.so').write_bytes(f.elf(exports=[('optional_api', 1, None)], needed=()))
        self.gate()
        self.rewrite('lib/x86_64/libreactnative.so', f.elf(needed=('libonly26.so',)))
        with self.assertRaisesRegex(ValueError, 'API24.*libonly26.so'): self.gate()

    def test_version_mismatch_and_hidden_definition_rejected(self):
        self.rewrite('lib/x86_64/libreactnative.so', f.elf(imports=[('present', 1, 'LIBC_O')]))
        stub = next((self.root/'ndk').rglob('x86_64-linux-android/24/libc.so'))
        stub.write_bytes(f.elf(exports=[('present', 1, 'LIBC_N')], needed=()))
        with self.assertRaisesRegex(ValueError, 'present.*LIBC_O'): self.gate()
        stub.write_bytes(f.elf(exports=[('present', 1, 'LIBC_O')], needed=()))
        self.gate()
        data = bytearray(stub.read_bytes())
        # Second Elf64_Sym st_other: hidden exports cannot satisfy imports.
        eh = struct.unpack_from('<HHIQQQIHHHHHH', data, 16)
        shoff = eh[5]
        dynsym = struct.unpack_from('<IIQQQQIIQQ', data, shoff+2*64)
        data[dynsym[4]+24+5] = 2
        stub.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'present'): self.gate()

    def test_unrelated_packaged_export_cannot_mask_failure(self):
        self.rewrite('lib/x86_64/libreactnative.so', f.elf(imports=[('missing', 1, None)]))
        self.rewrite('lib/x86_64/libunrelated.so', f.elf(exports=[('missing', 1, None)]))
        with self.assertRaisesRegex(ValueError, 'missing'): self.gate()

    def test_missing_profile_unknown_abi_and_machine_mismatch_fail(self):
        profile = next((self.root/'ndk').rglob('i686-linux-android/24/libc.so'))
        profile.unlink()
        with self.assertRaisesRegex(ValueError, 'profile|libc.so'): self.gate()
        f.fixtures(self.root)
        self.rewrite('lib/mips/libunexpected.so', f.elf())
        with self.assertRaisesRegex(ValueError, 'ABI'): self.gate()

    def test_bad_elf_and_truncated_or_invalid_metadata_fail(self):
        for data in (b'bad ELF', f.elf()[:63], f.elf()[:-1], b'\x7fELF'+b'\0'*100):
            with self.subTest(size=len(data)):
                self.rewrite('lib/x86_64/libreactnative.so', data)
                with self.assertRaises(ValueError): self.gate()
        self.rewrite('lib/x86_64/libreactnative.so', f.elf('x86'))
        with self.assertRaisesRegex(ValueError, 'ABI|machine'): self.gate()

    def test_contract_missing_or_invalid_fails_closed(self):
        for v in ({}, {'translation': {'minimumAndroidSdk': True}}, {'translation': {'minimumAndroidSdk': 24}}):
            self.contract.write_text(json.dumps(v))
            with self.assertRaisesRegex(ValueError, 'contract|translation'): self.gate()

    def test_zip_duplicate_unsafe_and_empty_fail(self):
        for entries in ([('lib/x86_64/libreactnative.so', f.elf())]*2,
                        [('../lib/x86_64/libevil.so', f.elf())], []):
            with zipfile.ZipFile(self.paths['apk'], 'w') as z:
                for n, data in entries: z.writestr(n, data)
            with self.assertRaises(ValueError): self.gate()

    def producer(self):
        (self.root/'mapping.txt').write_text('exact R8 map')
        objdump = 'fixture'
        if os.environ.get('ANDROID_NDK_HOME'):
            objdump = str(next(Path(os.environ['ANDROID_NDK_HOME']).glob('toolchains/llvm/prebuilt/*/bin/llvm-objdump*')))
        return subprocess.run(['node', str(HERE/'native-compatibility-producer-probe.mjs'),
            str(ROOT/'scripts/unsigned-store-build.mjs'), str(self.root), 'unused', objdump],
            capture_output=True, text=True, timeout=60)

    def test_actual_producer_rejects_incompatible_core_archive_bytes(self):
        self.paths = f.fixtures(self.root, core_new=True)
        result = self.producer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('strtod_l@LIBC_O', result.stderr)

    def test_actual_producer_accepts_optional_api26_archive_bytes(self):
        result = self.producer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PRODUCER_ACCEPTED_ARCHIVES', result.stdout)

    def test_parser_rejects_dynamic_pointer_version_hash_and_chain_corruption(self):
        parser = module(GATE, 'gate').inspect_elf
        original = f.elf(imports=[('strtod_l', 1, 'LIBC_O')])
        eh = struct.unpack_from('<HHIQQQIHHHHHH', original, 16)
        sections = [struct.unpack_from('<IIQQQQIIQQ', original, eh[5]+i*64) for i in range(eh[11])]
        changes = [(sections[4][4]+16, '<I', 0),  # wrong GNU version hash
                   (sections[4][4]+12, '<I', 4),  # cyclic/backwards version link
                   (sections[2][4]+24, '<I', 0x7fffffff),  # out-of-range string
                   (sections[6][4]+16+8, '<Q', 0x7fffffffffff)]  # unmapped DT_STRTAB
        for offset, fmt, value in changes:
            bad = bytearray(original); struct.pack_into(fmt, bad, offset, value)
            with self.subTest(offset=offset), self.assertRaises(ValueError): parser(bad)

    def test_parser_reads_metadata_only_and_has_no_import_side_effects(self):
        class Tracked(io.BytesIO):
            total = 0
            maximum = 0
            def read(self, size=-1):
                self.total += size; self.maximum = max(self.maximum, size)
                if size < 0 or size > 8192: raise AssertionError('Unbounded ELF read')
                return super().read(size)
        stream = Tracked(f.elf(imports=[('strtod_l', 1, 'LIBC_O')]))
        result = module(GATE, 'gate').inspect_elf(stream)
        self.assertEqual(result['imports'][0][:3], ('strtod_l', 1, 'LIBC_O'))
        self.assertLess(stream.total, 8192)

    def test_global_version_index_is_unversioned_even_with_base_definition(self):
        data = bytearray(f.elf(imports=[('unversioned', 1, None)], exports=[('exported', 1, 'FILE_BASE')]))
        eh = struct.unpack_from('<HHIQQQIHHHHHH', data, 16)
        sections = [struct.unpack_from('<IIQQQQIIQQ', data, eh[5]+i*64) for i in range(eh[11])]
        struct.pack_into('<H', data, sections[5][4]+4, 1)  # verdef base index
        struct.pack_into('<H', data, sections[3][4]+4, 1)  # exported symbol index
        value = module(GATE, 'gate').inspect_elf(data)
        self.assertEqual(value['imports'][0], ('unversioned', 1, None, None))

    def test_real_ndk_api24_25_26_versioned_stub_probes_when_available(self):
        ndk = os.environ.get('ANDROID_NDK_HOME')
        if not ndk: self.skipTest('Set ANDROID_NDK_HOME for existing NDK probes; no downloads')
        parser = module(GATE, 'gate').inspect_elf
        sysroot = next(Path(ndk).glob('toolchains/llvm/prebuilt/*/sysroot/usr/lib'))
        for abi, (cls, machine, triple) in f.ABIS.items():
            for api in (24, 25, 26):
                with (sysroot/triple/str(api)/'libc.so').open('rb') as stream: value = parser(stream)
                self.assertEqual((value['class'], value['machine']), (cls, machine))
                self.assertEqual(any(n == 'strtod_l' and v == 'LIBC_O' for n, v, _ in value['exports']), api == 26, (abi, api))


if __name__ == '__main__':
    unittest.main()
