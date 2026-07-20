import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip, crc32, type ZipEntry } from "../src/zip-writer.js";

/**
 * ZIP は自前で組んでいるので、**自分のパーサで読み返しても正しさの証明にならない**
 * （同じ誤解で書いて同じ誤解で読めば一致する）。外部の `unzip` に通して確かめる。
 */
let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** ZIP を一時ディレクトリに書き出してパスを返す */
function writeZip(entries: readonly ZipEntry[]): string {
  dir = mkdtempSync(join(tmpdir(), "zip-test-"));
  const path = join(dir, "out.zip");
  writeFileSync(path, buildZip(entries));
  return path;
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Python の `zipfile` で名前一覧を読む。
 * bit 11（UTF-8 名）を正しく実装している**独立した実装**として使う。
 * 自前のパーサで読み返しても、同じ誤解で書いて同じ誤解で読めば一致してしまう。
 */
function readNamesWithPython(zipPath: string): string[] {
  const out = execFileSync(
    "python3",
    [
      "-c",
      [
        "import sys, zipfile, json",
        "z = zipfile.ZipFile(sys.argv[1])",
        "assert z.testzip() is None",
        "print(json.dumps(z.namelist()))"
      ].join("\n"),
      zipPath
    ],
    { encoding: "utf8" }
  );
  return JSON.parse(out) as string[];
}

describe("外部の unzip が受け付けること", () => {
  it("整合性検査（unzip -t）を通る", () => {
    const zip = writeZip([
      { path: "a.txt", data: bytes("hello") },
      { path: "sub/b.txt", data: bytes("world") }
    ]);
    const out = execFileSync("unzip", ["-t", zip], { encoding: "utf8" });
    expect(out).toContain("No errors detected");
  });

  it("展開した中身がバイト単位で一致する", () => {
    const payload = bytes("日本語の中身\nsecond line\n");
    const zip = writeZip([{ path: "nested/dir/file.txt", data: payload }]);
    execFileSync("unzip", ["-q", zip, "-d", dir as string]);
    const got = readFileSync(join(dir as string, "nested/dir/file.txt"));
    expect(new Uint8Array(got)).toEqual(payload);
  });

  /**
   * bit 11 を立て忘れると、展開側が OEM コードページと解釈して名前が化ける。
   *
   * 検証に Python の `zipfile` を使うのは、**`unzip` 6.00（2009）が bit 11 を
   * 既定で尊重しないため**（`-O UTF-8` を明示すれば正しく展開できることは確認済み）。
   * 化けるのはこちらの ZIP ではなく展開側の既定挙動、という切り分けができている。
   */
  it("非 ASCII のファイル名が UTF-8 として読める", () => {
    const zip = writeZip([{ path: "日本語ファイル.txt", data: bytes("x") }]);
    const names = readNamesWithPython(zip);
    expect(names).toEqual(["日本語ファイル.txt"]);
  });

  it("空のファイルを含められる", () => {
    const zip = writeZip([
      { path: "empty.txt", data: new Uint8Array(0) },
      { path: "notempty.txt", data: bytes("x") }
    ]);
    expect(execFileSync("unzip", ["-t", zip], { encoding: "utf8" })).toContain("No errors detected");
    execFileSync("unzip", ["-q", zip, "-d", dir as string]);
    expect(readFileSync(join(dir as string, "empty.txt")).length).toBe(0);
  });

  /** 収集結果が 0 件のときに壊れた ZIP を返さないこと */
  it("エントリが 1 件も無くても正当な ZIP になる", () => {
    const zip = writeZip([]);
    expect(readNamesWithPython(zip)).toEqual([]);
  });

  it("大きめのデータでも往復する", () => {
    const big = new Uint8Array(300_000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const zip = writeZip([{ path: "big.bin", data: big }]);
    execFileSync("unzip", ["-q", zip, "-d", dir as string]);
    expect(new Uint8Array(readFileSync(join(dir as string, "big.bin")))).toEqual(big);
  });
});

describe("圧縮方式の選択", () => {
  /** 圧縮して大きくなるデータは格納に落とす。落とさないとアーカイブが元より膨らむ */
  it("圧縮が効かないデータは格納（method=0）にする", () => {
    // 決定的な擬似乱数（圧縮が効かない）
    const noise = new Uint8Array(4096);
    let state = 0x12345678;
    for (let i = 0; i < noise.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      noise[i] = (state >>> 24) & 0xff;
    }
    const zip = buildZip([{ path: "noise.bin", data: noise }]);
    // 局所ヘッダ offset 8 が圧縮方式
    expect(new DataView(zip.buffer).getUint16(8, true)).toBe(0);
    // 格納なので、アーカイブは元データより極端には膨らまない
    expect(zip.length).toBeLessThan(noise.length + 200);
  });

  it("圧縮が効くデータは deflate（method=8）にする", () => {
    const compressible = bytes("a".repeat(4096));
    const zip = buildZip([{ path: "z.txt", data: compressible }]);
    expect(new DataView(zip.buffer).getUint16(8, true)).toBe(8);
    expect(zip.length).toBeLessThan(compressible.length);
  });
});

/**
 * 更新日時は**端から端まで無検証**だった（review S1）。
 * `modifiedAt` を渡すテストが 1 件も無かったため、日付が全部 1980-01-01 になっていても
 * 誰も気づかない状態だった。Python の `zipfile` で読み返して固定する。
 */
describe("更新日時（MS-DOS 形式）", () => {
  function readDateWithPython(zipPath: string): number[] {
    const out = execFileSync(
      "python3",
      [
        "-c",
        [
          "import sys, zipfile, json",
          "z = zipfile.ZipFile(sys.argv[1])",
          "print(json.dumps(list(z.infolist()[0].date_time)))"
        ].join("\n"),
        zipPath
      ],
      { encoding: "utf8" }
    );
    return JSON.parse(out) as number[];
  }

  it("渡した日時が zip に載る", () => {
    // MS-DOS 形式は秒が 2 秒単位なので、22 秒は 22 のまま残る
    const at = new Date(2024, 2, 5, 14, 30, 22);
    const zip = writeZip([{ path: "f.txt", data: bytes("x"), modifiedAt: at }]);
    expect(readDateWithPython(zip)).toEqual([2024, 3, 5, 14, 30, 22]);
  });

  /** 1980 年より前は MS-DOS 形式で表現できないので下限に丸める */
  it("1980 年より前は下限に丸める", () => {
    const zip = writeZip([
      { path: "f.txt", data: bytes("x"), modifiedAt: new Date(1970, 0, 1) }
    ]);
    expect(readDateWithPython(zip).slice(0, 3)).toEqual([1980, 1, 1]);
  });

  /**
   * 上端も無防備だと 2108 年で 1980 年に化ける。
   * **範囲チェックでは足りない**——ガードを外すと 2200 年は 2072 年になり、
   * 「1980〜2107 の範囲内」という緩い主張は通ってしまう（review RS4）。下端と同じく厳密に固定する。
   */
  it("表現できない未来も下限に丸める（巻き戻らない）", () => {
    const zip = writeZip([
      { path: "f.txt", data: bytes("x"), modifiedAt: new Date(2200, 0, 1) }
    ]);
    expect(readDateWithPython(zip)).toEqual([1980, 1, 1, 0, 0, 0]);
  });
});

describe("非対応の線引き", () => {
  /** zip64 を実装していないので、件数が溢れる前に落とす */
  it("65,535 件を超えるエントリは受け付けない", () => {
    const many = Array.from({ length: 65_536 }, (_, i) => ({
      path: `f${i}`,
      data: new Uint8Array(0)
    }));
    expect(() => buildZip(many)).toThrow(RangeError);
  });
});

describe("CRC-32", () => {
  /** 既知のベクタ（"123456789" → 0xCBF43926）で表の生成を確かめる */
  it("既知の値と一致する", () => {
    expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

/**
 * オフセットは 32 ビットしか持てない。溢れると `setUint32` が黙って 2^32 で巻き戻り、
 * **例外なく壊れた ZIP が返る**（review M2）。上限は呼び出し側の設定ではなくここで守る。
 */
describe("4GB の防波堤", () => {
  /**
   * 以前のこのテストは**ガードに到達していなかった**（review RM1）——
   * 偽オブジェクトが `deflateRawSync` で `TypeError` を起こし、
   * 型を指定しない `toThrow()` がそれで通っていた。
   * いまは見積もりで先に落ちるので、**`RangeError` であることまで固定する**。
   */
  it("アーカイブが 32 ビットのオフセットに収まらないなら RangeError", () => {
    // 4GB を実際に確保しない。長さだけ巨大な view を作る（見積もりは data.length しか見ない）
    const huge = { length: 0x8000_0000, byteLength: 0x8000_0000 } as unknown as Uint8Array;
    expect(() => buildZip([{ path: "a", data: huge }, { path: "b", data: huge }])).toThrow(
      RangeError
    );
  });

  it("上限の内側なら通る", () => {
    expect(() => buildZip([{ path: "a.txt", data: bytes("x") }])).not.toThrow();
  });
});
