"""Small real ELF shared objects; no compiler, downloads, or app build."""
import struct
import zipfile

ABIS = {'arm64-v8a': (2, 183, 'aarch64-linux-android'),
        'armeabi-v7a': (1, 40, 'arm-linux-androideabi'),
        'x86': (1, 3, 'i686-linux-android'),
        'x86_64': (2, 62, 'x86_64-linux-android')}


def elf_hash(text):
    value = 0
    for byte in text.encode():
        value = (value << 4) + byte
        high = value & 0xf0000000
        if high: value ^= high >> 24
        value &= ~high
    return value


def elf(abi='x86_64', imports=(), exports=(), needed=('libc.so',)):
    """Symbols are (name, binding, version). All metadata has loader addresses."""
    cls, machine, _ = ABIS[abi]
    wide = cls == 2
    strings = bytearray(b'\0')

    def string(s):
        off = len(strings)
        strings.extend(s.encode() + b'\0')
        return off

    versions = {v: i + 2 for i, v in enumerate(dict.fromkeys(v for _, _, v in (*imports, *exports) if v))}
    syms = bytearray(b'\0' * (24 if wide else 16))
    vs = [0]
    for defined, items in ((False, imports), (True, exports)):
        for name, binding, version in items:
            args = (string(name), binding << 4 | 2, 0, 1 if defined else 0, 0, 0)
            syms.extend(struct.pack('<IBBHQQ', *args) if wide else
                        struct.pack('<IIIBBH', args[0], 0, 0, args[1], 0, args[3]))
            vs.append(versions.get(version, 1))
    req = list(dict.fromkeys(v for _, _, v in imports if v))
    defs = list(dict.fromkeys(v for _, _, v in exports if v))
    verneed = bytearray()
    if req:
        verneed.extend(struct.pack('<HHIII', 1, len(req), string('libc.so'), 16, 0))
        for i, v in enumerate(req):
            verneed.extend(struct.pack('<IHHII', elf_hash(v), 0, versions[v], string(v), 16 if i < len(req)-1 else 0))
    verdef = bytearray()
    for i, v in enumerate(defs):
        verdef.extend(struct.pack('<HHHHIII', 1, 0, versions[v], 1, elf_hash(v), 20, 28 if i < len(defs)-1 else 0))
        verdef.extend(struct.pack('<II', string(v), 0))
    needed_offsets = [string(n) for n in needed]
    sections = [('', 0, b'', 0, 0, 0), ('.dynstr', 3, bytes(strings), 0, 0, 0),
                ('.dynsym', 11, bytes(syms), 1, 1, 24 if wide else 16),
                ('.gnu.version', 0x6fffffff, struct.pack('<'+'H'*len(vs), *vs), 2, 0, 2),
                ('.gnu.version_r', 0x6ffffffe, bytes(verneed), 1, bool(req), 0),
                ('.gnu.version_d', 0x6ffffffd, bytes(verdef), 1, len(defs), 0)]
    ehsize, phsize, shsize = (64, 56, 64) if wide else (52, 32, 40)
    data = bytearray(b'\0' * (ehsize + 2 * phsize))
    offsets = [0]
    for _, _, content, *_ in sections[1:]:
        data.extend(b'\0' * (-len(data) % 8))
        offsets.append(len(data)); data.extend(content)
    tags = [(1, n) for n in needed_offsets] + [(5, offsets[1]), (10, len(strings)),
            (6, offsets[2]), (11, 24 if wide else 16), (0x6ffffff0, offsets[3])]
    if req:
        tags += [(0x6ffffffe, offsets[4]), (0x6fffffff, 1)]
    if defs:
        tags += [(0x6ffffffc, offsets[5]), (0x6ffffffd, len(defs))]
    dynamic = b''.join(struct.pack('<qQ' if wide else '<iI', *t) for t in tags + [(0, 0)])
    sections.append(('.dynamic', 6, dynamic, 1, 0, 16 if wide else 8))
    data.extend(b'\0' * (-len(data) % 8))
    offsets.append(len(data)); data.extend(dynamic)
    names = bytearray(b'\0'); nameoffs = []
    for name, *_ in sections + [('.shstrtab',)]:
        nameoffs.append(len(names)); names.extend(name.encode()+b'\0')
    sections.append(('.shstrtab', 3, bytes(names), 0, 0, 0))
    offsets.append(len(data)); data.extend(names)
    shoff = (len(data)+7)//8*8; data.extend(b'\0'*(shoff-len(data)))
    for i, (_, typ, content, link, info, entsize) in enumerate(sections):
        args = (nameoffs[i], typ, 2 if 0 < i < len(sections)-1 else 0, offsets[i], offsets[i], len(content), link, info, 1, entsize)
        data.extend(struct.pack('<IIQQQQIIQQ' if wide else '<IIIIIIIIII', *args))
    ident = b'\x7fELF' + bytes([cls, 1, 1, 0]) + b'\0'*8
    header = (3, machine, 1, 0, ehsize, shoff, 0, ehsize, phsize, 2, shsize, len(sections), len(sections)-1)
    data[:ehsize] = ident + struct.pack('<HHIQQQIHHHHHH' if wide else '<HHIIIIIHHHHHH', *header)
    loads = (1, 4, 0, 0, 0, len(data), len(data), 16384) if wide else (1, 0, 0, 0, len(data), len(data), 4, 16384)
    dyn = (2, 4, offsets[6], offsets[6], offsets[6], len(dynamic), len(dynamic), 8) if wide else (2, offsets[6], offsets[6], offsets[6], len(dynamic), len(dynamic), 4, 4)
    data[ehsize:ehsize+2*phsize] = struct.pack('<IIQQQQQQ' if wide else '<IIIIIIII', *loads) + struct.pack('<IIQQQQQQ' if wide else '<IIIIIIII', *dyn)
    return bytes(data)


def fixtures(root, core_new=False, optional_new=True):
    root.mkdir(parents=True, exist_ok=True)
    paths = {}
    for fmt, prefix in (('apk', 'lib'), ('aab', 'base/lib')):
        paths[fmt] = root / ('fixture.'+fmt)
        with zipfile.ZipFile(paths[fmt], 'w') as z:
            z.writestr('AndroidManifest.xml' if fmt == 'apk' else 'base/manifest/AndroidManifest.xml', 'fixture')
            if fmt == 'aab':
                z.writestr('BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map', 'exact R8 map')
            for abi in ABIS:
                imports = [('strtod_l', 1, 'LIBC_O')] if core_new else []
                for name in ('libreactnative.so', 'librnwhisper.so'):
                    z.writestr(f'{prefix}/{abi}/{name}', elf(abi, imports=imports))
                if abi in ('arm64-v8a', 'x86_64'):
                    z.writestr(f'{prefix}/{abi}/liblitertlm_jni.so', elf(abi, imports=[('strtod_l', 1, 'LIBC_O')] if optional_new else []))
    for abi, (_, _, triple) in ABIS.items():
        for api in (24, 26):
            profile = root/'ndk'/'toolchains'/'llvm'/'prebuilt'/'fixture'/'sysroot'/'usr'/'lib'/triple/str(api)
            profile.mkdir(parents=True, exist_ok=True)
            (profile/'libc.so').write_bytes(elf(abi, exports=[('strtod_l', 1, 'LIBC_O')] if api == 26 else [], needed=()))
    return paths
