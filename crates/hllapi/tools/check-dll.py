#!/usr/bin/env python3
"""出来上がった共有ライブラリを検査する（PE / ELF）。

**ビルドが通ったこと自体は何の保証にもならない。** HLLAPI の利用者から見て要るのは

1. 4 つのエントリが **装飾なしの名前**で出ていること
   （32bit の `stdcall` は普通 `_hllapi@16` に装飾される。VBA の `Declare` は
   装飾なしの名前を引くので、装飾されていると「関数が見つかりません」になる）
2. 32bit Windows 版が **本当に `stdcall`** になっていること
   （`extern "C"`（cdecl）のままだと VBA から呼んだ瞬間にスタックが壊れる。
   **名前からは判別できない**ので、機械語の `ret` を見るしかない）

外部ライブラリを使わずに読む（この検査のために依存を増やしたくない）。

    python3 crates/hllapi/tools/check-dll.py <dll または so> [...]
"""

import struct
import sys

WANT = {"hllapi", "HLLAPI", "WinHLLAPI", "hllc"}


class Fail(Exception):
    pass


def pe_sections(d: bytes):
    pe = struct.unpack_from("<I", d, 0x3C)[0]
    if d[pe : pe + 4] != b"PE\0\0":
        raise Fail("PE ヘッダが見つかりません")
    nsec = struct.unpack_from("<H", d, pe + 6)[0]
    optsz = struct.unpack_from("<H", d, pe + 20)[0]
    optoff = pe + 24
    magic = struct.unpack_from("<H", d, optoff)[0]
    secs = [struct.unpack_from("<8sIIII", d, optoff + optsz + 40 * i) for i in range(nsec)]
    return magic, optoff, secs


def pe_exports(d: bytes):
    """(64bit か, 名前 → ファイル内オフセット)"""
    magic, optoff, secs = pe_sections(d)
    is64 = magic == 0x20B

    def r2o(rva: int):
        for _n, vsz, va, rsz, praw in secs:
            if va <= rva < va + max(vsz, rsz):
                return praw + (rva - va)
        raise Fail(f"RVA {rva:#x} がどのセクションにも入りません")

    erva = struct.unpack_from("<I", d, optoff + (112 if is64 else 96))[0]
    if erva == 0:
        raise Fail("エクスポートテーブルがありません")
    eo = r2o(erva)
    n_name = struct.unpack_from("<I", d, eo + 24)[0]
    func_tbl, name_tbl, ord_tbl = struct.unpack_from("<III", d, eo + 28)
    out = {}
    for i in range(n_name):
        nr = struct.unpack_from("<I", d, r2o(name_tbl) + 4 * i)[0]
        o = r2o(nr)
        name = d[o : d.index(b"\0", o)].decode("ascii", "replace")
        ordi = struct.unpack_from("<H", d, r2o(ord_tbl) + 2 * i)[0]
        frva = struct.unpack_from("<I", d, r2o(func_tbl) + 4 * ordi)[0]
        out[name] = r2o(frva)
    return is64, out


def ret_kind(body: bytes):
    """最初に現れる `ret` を読む。`C2 imm16` = 呼ばれた側が引数を片付ける = stdcall"""
    for j in range(len(body) - 2):
        if body[j] == 0xC2:
            return struct.unpack_from("<H", body, j + 1)[0]
        if body[j] == 0xC3:
            return 0
    return None


def elf_exports(d: bytes):
    """ELF の .dynsym から関数名を拾う（Linux 版の確認用。規約は見ない）"""
    is64 = d[4] == 2
    if not is64:
        raise Fail("32bit ELF は想定していません")
    e_shoff = struct.unpack_from("<Q", d, 0x28)[0]
    e_shentsize, e_shnum, e_shstrndx = struct.unpack_from("<HHH", d, 0x3A)
    shs = [
        struct.unpack_from("<IIQQQQIIQQ", d, e_shoff + e_shentsize * i) for i in range(e_shnum)
    ]
    names_off = shs[e_shstrndx][4]

    def sname(sh):
        o = names_off + sh[0]
        return d[o : d.index(b"\0", o)].decode()

    dynsym = next((s for s in shs if sname(s) == ".dynsym"), None)
    dynstr = next((s for s in shs if sname(s) == ".dynstr"), None)
    if not dynsym or not dynstr:
        raise Fail(".dynsym / .dynstr がありません")
    out = set()
    for off in range(dynsym[4], dynsym[4] + dynsym[5], 24):
        nameoff, info = struct.unpack_from("<IB", d, off)
        if info & 0xF != 2:  # STT_FUNC
            continue
        o = dynstr[4] + nameoff
        out.add(d[o : d.index(b"\0", o)].decode("ascii", "replace"))
    return out


def check(path: str) -> bool:
    d = open(path, "rb").read()
    print(f"{path}")
    try:
        if d[:2] == b"MZ":
            is64, exp = pe_exports(d)
            arch = "x86-64" if is64 else "x86 (32bit)"
            missing = WANT - set(exp)
            if missing:
                raise Fail(f"エントリが足りません: {', '.join(sorted(missing))}")
            decorated = [n for n in exp if "@" in n or n.startswith("_")]
            if decorated:
                raise Fail(
                    f"名前が装飾されています（VBA の Declare から引けません）: {decorated}"
                )
            print(f"  PE {arch} / エントリ 4 つ（装飾なし）: {', '.join(sorted(exp))}")

            got = ret_kind(d[exp["hllapi"] : exp["hllapi"] + 256])
            if is64:
                # x86-64 は規約が 1 つしかない。片付けは呼び出し側
                print(f"  呼び出し規約: x86-64 は単一（ret {got if got else ''}）")
            elif got == 16:
                print("  呼び出し規約: **stdcall**（ret 0x10 = 4 引数を呼ばれた側が片付ける）")
            elif got == 0:
                raise Fail(
                    "**cdecl になっています**（ret に引数の片付けが無い）。"
                    "32bit Office の VBA から呼ぶとスタックが壊れます。"
                    'エクスポートは extern "system" にしてください'
                )
            else:
                raise Fail(f"想定外の ret 0x{got:x}（4 引数なら 0x10 のはず）")
        elif d[:4] == b"\x7fELF":
            exp = elf_exports(d)
            missing = WANT - exp
            if missing:
                raise Fail(f"エントリが足りません: {', '.join(sorted(missing))}")
            print(f"  ELF x86-64 / エントリ 4 つ: {', '.join(sorted(WANT))}")
        else:
            raise Fail("PE でも ELF でもありません")
    except Fail as e:
        print(f"  NG: {e}")
        return False
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    ok = all([check(p) for p in sys.argv[1:]])
    print("OK" if ok else "失敗あり")
    sys.exit(0 if ok else 1)
