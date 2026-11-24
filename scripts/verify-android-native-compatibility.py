#!/usr/bin/env python3
"""Fail-closed Android load-time API gate. Python stdlib; never extracts libraries.

The pure parser reads bounded ELF metadata, not code/model payloads. Verification
holds imports/dependency names for one ABI/profile and scans exports one library
at a time. NDK versioned stubs are the authority, not ELF build notes or filenames.
This is a loadability gate, not an emulator or a proof of guarded weak callsites.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import struct
import sys
import zipfile

ABIS = {'arm64-v8a': (2, 183, 'aarch64-linux-android'),
        'armeabi-v7a': (1, 40, 'arm-linux-androideabi'),
        'x86': (1, 3, 'i686-linux-android'),
        'x86_64': (2, 62, 'x86_64-linux-android')}
OPTIONAL = 'liblitertlm_jni.so'
CORE_MIN = 24
MAX_METADATA = 32 * 1024 * 1024


def require(value, message):
    if not value:
        raise ValueError(message)


def elf_hash(text):
    value = 0
    for byte in text.encode('utf-8'):
        value = (value << 4) + byte
        high = value & 0xf0000000
        if high: value ^= high >> 24
        value &= ~high
    return value


def inspect_elf(source, size=None):
    """Pure, seekable input -> needed, strong/weak imports, visible exports.

    Section tables are required. Unsupported/stripped metadata fails closed.
    Dynamic section addresses/links must agree with loader program headers;
    editing section metadata cannot hide the actual DT_NEEDED/SYMTAB.
    """
    stream = io.BytesIO(source) if isinstance(source, (bytes, bytearray)) else source
    if size is None:
        stream.seek(0, 2); size = stream.tell()

    def read(off, length):
        require(0 <= off <= size and 0 <= length <= min(size-off, MAX_METADATA), 'ELF range/metadata limit')
        stream.seek(off); data = stream.read(length)
        require(len(data) == length, 'Truncated ELF')
        return data

    ident = read(0, 16)
    require(ident[:4] == b'\x7fELF' and ident[4] in (1, 2) and ident[5:7] == b'\x01\x01', 'Invalid Android ELF encoding')
    wide = ident[4] == 2
    ehsize, phsize, shsize, symsize, dynsize = (64, 56, 64, 24, 16) if wide else (52, 32, 40, 16, 8)
    eh = struct.unpack('<HHIQQQIHHHHHH' if wide else '<HHIIIIIHHHHHH', read(16, ehsize-16))
    require(eh[0] == 3 and eh[2] == 1 and eh[7] == ehsize, 'Invalid shared ELF header')
    require(eh[8] == phsize and 0 < eh[9] <= 4096 and eh[10] == shsize and 0 < eh[11] <= 4096, 'Invalid ELF tables')
    programs = [struct.unpack('<IIQQQQQQ' if wide else '<IIIIIIII', p[0]) for p in
                struct.iter_unpack(f'{phsize}s', read(eh[4], phsize*eh[9]))]
    # iter_unpack above yields one-element tuples.
    loads = []
    dynamics = []
    for p in programs:
        off, addr, length, mem = (p[2], p[3], p[5], p[6]) if wide else (p[1], p[2], p[4], p[5])
        require(off <= size and length <= size-off and length <= mem, 'Invalid program range')
        if p[0] == 1: loads.append((off, addr, length))
        if p[0] == 2: dynamics.append((off, addr, length))
    require(loads and len(dynamics) == 1, 'Missing ELF LOAD/DYNAMIC segments')

    def address(addr, length):
        matches = [off+addr-start for off, start, span in loads if start <= addr and length <= span-(addr-start)]
        require(len(set(matches)) == 1, 'Unmapped/ambiguous dynamic address')
        return matches[0]

    sections = [struct.unpack('<IIQQQQIIQQ' if wide else '<IIIIIIIIII', s[0]) for s in
                struct.iter_unpack(f'{shsize}s', read(eh[5], shsize*eh[11]))]
    for s in sections:
        if s[1] != 8: require(s[4] <= size and s[5] <= size-s[4], 'Invalid section range')
    selected = {}
    for s in sections:
        if s[1] in (6, 11, 0x6fffffff, 0x6ffffffe, 0x6ffffffd) and s[5]:
            require(s[1] not in selected, 'Duplicate ELF metadata table')
            selected[s[1]] = s
    require(6 in selected and 11 in selected, 'Missing dynamic/symbol metadata')
    dynamic, sym = selected[6], selected[11]
    require(dynamic[4:6] == (dynamics[0][0], dynamics[0][2]) and dynamic[3] == dynamics[0][1], 'DYNAMIC metadata mismatch')
    require(sym[9] == symsize and sym[5] % symsize == 0 and dynamic[9] == dynsize and dynamic[5] % dynsize == 0, 'Invalid metadata entry size')
    require(sym[6] < len(sections) and dynamic[6] == sym[6], 'Invalid string table link')
    strings = sections[sym[6]]
    require(strings[1] == 3, 'Invalid ELF string table')
    # Fetch each bounded metadata table in file order, avoiding repeated ZIP seeks.
    tables = {s[4]: s for s in (*selected.values(), strings)}
    require(sum(s[5] for s in tables.values()) <= MAX_METADATA, 'ELF total metadata limit')
    blobs = {off: read(off, s[5]) for off, s in sorted(tables.items())}
    strs = blobs[strings[4]]

    def string(off):
        require(0 <= off < len(strs), 'Invalid ELF string offset')
        end = strs.find(b'\0', off)
        require(end >= off and end-off <= 65536, 'Unterminated ELF string')
        try: return strs[off:end].decode('utf-8')
        except UnicodeDecodeError as error: raise ValueError('Invalid ELF string') from error

    tags = {}; needed = []; terminated = False
    for tag, value in struct.iter_unpack('<qQ' if wide else '<iI', blobs[dynamic[4]]):
        if tag == 0: terminated = True; break
        if tag == 1: needed.append(string(value))
        else:
            require(tag not in tags, 'Duplicate dynamic tag')
            tags[tag] = value
    require(terminated, 'Unterminated dynamic table')
    require(tags.get(10) == strings[5] and tags.get(11) == symsize, 'Dynamic metadata size mismatch')
    for tag, s in ((5, strings), (6, sym), (0x6ffffff0, selected.get(0x6fffffff)),
                   (0x6ffffffe, selected.get(0x6ffffffe)), (0x6ffffffc, selected.get(0x6ffffffd))):
        if s is None:
            require(tag not in tags, 'Missing section for dynamic metadata')
        else:
            require(tag in tags and address(tags[tag], s[5]) == s[4] and tags[tag] == s[3], 'Dynamic/section address mismatch')
    require(all(re.fullmatch(r'[A-Za-z0-9_.+\-]+\.so', n) for n in needed), 'Unsafe DT_NEEDED name')
    versions = {}

    def unpack(fmt, buf, off):
        require(0 <= off and struct.calcsize(fmt) <= len(buf)-off, 'Malformed ELF version chain')
        return struct.unpack_from(fmt, buf, off)

    for typ, counttag in ((0x6ffffffe, 0x6fffffff), (0x6ffffffd, 0x6ffffffd)):
        s = selected.get(typ)
        if not s:
            require(tags.get(counttag, 0) == 0, 'Missing version table'); continue
        require(s[6] == sym[6], 'Invalid version strings link')
        buf = blobs[s[4]]; pos = 0; seen = set(); count = 0
        while True:
            require(pos not in seen and count < 65536, 'Cyclic ELF version chain')
            seen.add(pos); count += 1
            if typ == 0x6ffffffe:
                ver, cnt, file, aux, nxt = unpack('<HHIII', buf, pos)
                library = string(file)
                require(library in needed, 'Version provider not DT_NEEDED')
                require(ver == 1 and 0 < cnt <= 65536 and aux >= 16, 'Invalid version need')
                ap = pos+aux; auxseen = set()
                for i in range(cnt):
                    require(ap not in auxseen, 'Cyclic ELF version auxiliary chain'); auxseen.add(ap)
                    hashed, flags, index, name, anxt = unpack('<IHHII', buf, ap)
                    require(index > 1 and index not in versions, 'Invalid version index')
                    require(hashed == elf_hash(string(name)), 'Version name/hash mismatch')
                    versions[index] = (string(name), library)
                    require((anxt >= 16) if i < cnt-1 else anxt == 0, 'Invalid version auxiliary link')
                    ap += anxt
            else:
                ver, flags, index, cnt, hashed, aux, nxt = unpack('<HHHHIII', buf, pos)
                require(ver == 1 and 0 < cnt <= 65536 and aux >= 20 and index not in versions, 'Invalid version definition')
                name, _ = unpack('<II', buf, pos+aux)
                require(hashed == elf_hash(string(name)), 'Version name/hash mismatch')
                versions[index] = (string(name), None)
                ap = pos+aux; auxseen = set()
                for i in range(cnt):
                    require(ap not in auxseen, 'Cyclic ELF version definition chain'); auxseen.add(ap)
                    parent, anxt = unpack('<II', buf, ap)
                    string(parent)
                    require((anxt >= 8) if i < cnt-1 else anxt == 0, 'Invalid version definition link')
                    ap += anxt
            if not nxt: break
            require(nxt >= (16 if typ == 0x6ffffffe else 20), 'Invalid ELF version link')
            pos += nxt
        require(count == s[7] == tags.get(counttag), 'Version count mismatch')
    nsyms = sym[5]//symsize
    require(nsyms <= 262144, 'ELF dynamic symbol limit')
    versym = selected.get(0x6fffffff)
    if versym:
        require(versym[6] == sections.index(sym) and versym[5] == nsyms*2, 'Invalid version symbol table')
        indices = struct.unpack('<'+'H'*nsyms, blobs[versym[4]])
    else: indices = [1]*nsyms
    imports = []; exports = set(); symbol_bytes = 0
    for i, entry in enumerate(struct.iter_unpack('<IBBHQQ' if wide else '<IIIBBH', blobs[sym[4]])):
        name, info, other, index = (entry[0], entry[1], entry[2], entry[3]) if wide else (entry[0], entry[3], entry[4], entry[5])
        if not name: continue
        name = string(name); binding = info >> 4; vi = indices[i] & 0x7fff
        symbol_bytes += len(name)
        require(symbol_bytes <= MAX_METADATA, 'ELF symbol name budget')
        require(vi <= 1 or vi in versions, 'Unknown ELF symbol version')
        # VER_NDX_GLOBAL (1) is unversioned even when verdef[1] names SONAME.
        version, provider = versions.get(vi, (None, None)) if vi > 1 else (None, None)
        if index == 0 and binding in (1, 2):
            imports.append((name, binding, version, provider))
        elif index != 0 and binding in (1, 2, 10) and other & 3 in (0, 3) and vi != 0:
            exports.add((name, version, bool(indices[i] & 0x8000)))
    return {'class': ident[4], 'machine': eh[1], 'needed': tuple(needed), 'imports': imports, 'exports': exports}


def digest(file):
    h = hashlib.sha256()
    with open(file, 'rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''): h.update(chunk)
    return h.hexdigest()


def verify_archive(archive, format, ndk, contract):
    require(format in ('apk', 'aab'), 'Unknown archive format')
    config = json.loads(Path(contract).read_text(encoding='utf-8')) if isinstance(contract, (str, Path)) else contract
    floor = config.get('translation', {}).get('minimumAndroidSdk')
    require(type(floor) is int and CORE_MIN < floor <= 36, 'Missing/invalid translation.minimumAndroidSdk contract')
    before = digest(archive)
    ndk = Path(ndk)
    sysroots = list(ndk.glob('toolchains/llvm/prebuilt/*/sysroot/usr/lib'))
    require(len(sysroots) == 1, 'Missing/ambiguous NDK sysroot profile')
    prefix = 'lib' if format == 'apk' else 'base/lib'
    with zipfile.ZipFile(archive) as z:
        entries = {}; names = set()
        require(len(z.infolist()) <= 100000, 'Archive entry limit')
        for info in z.infolist():
            n = info.filename
            require(n not in names and not re.search(r'(^/|\\|(^|/)\.\.(/|$)|[\x00-\x1f:])', n), 'Unsafe/duplicate ZIP path')
            names.add(n)
            require(not info.flag_bits & 1 and (info.external_attr >> 16) & 0o170000 in (0, 0o100000, 0o040000), 'Unsafe ZIP member')
            if n.endswith('.so'):
                m = re.fullmatch(re.escape(prefix)+r'/([^/]+)/([^/]+\.so)', n)
                require(m and m[1] in ABIS, 'Unexpected native library path/ABI: '+n)
                entries.setdefault(m[1], {})[m[2]] = info
        require(set(entries) == set(ABIS), 'Missing packaged ABI profile')
        for abi, libs in entries.items():
            require({'libreactnative.so', 'librnwhisper.so'} <= libs.keys(), 'Missing core ABI libraries')
            require((OPTIONAL in libs) == (abi in ('arm64-v8a', 'x86_64')), 'Translation ABI profile mismatch')

            def parse(name, api):
                info = libs.get(name)
                if info:
                    with z.open(info) as stream: result = inspect_elf(stream, info.file_size)
                else:
                    stub = sysroots[0]/ABIS[abi][2]/str(api)/name
                    require(stub.is_file() and not stub.is_symlink(), f'Missing NDK dependency/profile {abi} API{api}: {name}')
                    with stub.open('rb') as stream: result = inspect_elf(stream, stub.stat().st_size)
                require((result['class'], result['machine']) == ABIS[abi][:2], f'ELF ABI/machine mismatch: {abi}/{name}')
                return result

            for api in (CORE_MIN, floor):
                roots = [name for name in libs if (name == OPTIONAL) == (api == floor)]
                if not roots: continue
                require((sysroots[0]/ABIS[abi][2]/str(api)).is_dir(), f'Missing NDK ABI profile: {abi} API{api}')
                graph = {}; pending = list(roots); import_count = 0; import_bytes = 0
                while pending:
                    name = pending.pop()
                    if name in graph: continue
                    require(len(graph) < 512, 'Native dependency graph limit')
                    item = parse(name, api)
                    import_count += len(item['imports']) if name in libs else 0
                    import_bytes += sum(len(s[0]) for s in item['imports']) if name in libs else 0
                    require(import_count <= 262144 and import_bytes <= MAX_METADATA, 'Native import metadata budget')
                    # NDK stubs are API/export profiles, not executable dependencies.
                    graph[name] = (item['needed'] if name in libs else (), item['imports'] if name in libs else ())
                    pending.extend(graph[name][0]); del item
                closures = {}
                for name in roots:
                    reachable = set(); pending = [name]
                    while pending:
                        dep = pending.pop()
                        if dep not in reachable:
                            reachable.add(dep); pending.extend(graph[dep][0])
                    closures[name] = reachable
                # Each dependency's strong imports must resolve in the root's local
                # load group, including siblings in that transitive closure.
                require(sum(sum(sum(s[1] == 1 for s in graph[dep][1]) for dep in closure) for closure in closures.values()) <= 262144,
                        'Native import resolution budget')
                unresolved = {name: {(sym, version, provider) for dep in closure for sym, binding, version, provider in graph[dep][1] if binding == 1}
                              for name, closure in closures.items()}
                for dep in graph:
                    item = parse(dep, api)
                    exports = item['exports']
                    exact = {(n, v) for n, v, hidden in exports}
                    default = {n for n, v, hidden in exports if not hidden}
                    for name, missing in unresolved.items():
                        if dep not in closures[name]: continue
                        missing.difference_update({(n, v, p) for n, v, p in missing
                                                   if (v is None and n in default) or (v is not None and (n, v) in exact)})
                    del item, exports, exact, default
                for name, missing in unresolved.items():
                    require(not missing, f'{format} {abi}/{name} API{api}: unavailable strong symbols '+', '.join(sorted(n+('@'+v if v else '') for n, v, _ in missing)[:12]))
    require(digest(archive) == before, 'Archive changed during native verification')
    return {'schemaVersion': 1, 'sha256': before, 'format': format, 'coreMinSdk': CORE_MIN,
            'translationMinSdk': floor, 'libraries': sum(len(v) for v in entries.values()), 'abis': sorted(entries)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk'); parser.add_argument('--aab')
    parser.add_argument('--ndk', required=True)
    parser.add_argument('--contract', default=str(Path(__file__).resolve().parent.parent/'config/product-contract.json'))
    args = parser.parse_args()
    require(args.apk or args.aab, 'Specify APK and/or AAB')
    reports = {fmt: verify_archive(file, fmt, args.ndk, args.contract) for fmt, file in (('apk', args.apk), ('aab', args.aab)) if file}
    print(json.dumps(reports, sort_keys=True))


if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, struct.error, zipfile.BadZipFile, EOFError) as error:
        print('Android native compatibility failed: '+str(error), file=sys.stderr)
        sys.exit(1)
