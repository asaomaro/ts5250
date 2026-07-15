/**
 * ICU .ucm（UniCode Mapping）ファイルの最小パーサ。
 * 対応: SBCS（uconv_class "SBCS"）。EBCDIC_STATEFUL（DBCS）は subtask 04 で拡張する。
 * 書式: https://unicode-org.github.io/icu/userguide/conversion/data.html
 */

export interface UcmHeader {
  codeSetName: string;
  uconvClass: string;
  subchar: number[];
  mbCurMax: number;
}

/** CHARMAP 1 エントリ。flag: 0=roundtrip 1=fallback(U→B) 2=subchar1 3=reverse fallback(B→U) */
export interface UcmEntry {
  unicode: number;
  bytes: number[];
  flag: 0 | 1 | 2 | 3;
}

export interface UcmFile {
  header: UcmHeader;
  entries: UcmEntry[];
  /** スキップした複数コードポイント合成エントリ数 */
  skipped: number;
}

const HEADER_RE = /^<(\w+)>\s+(.+?)\s*$/;
const ENTRY_RE = /^<U([0-9A-Fa-f]{4,6})>\s+((?:\\x[0-9A-Fa-f]{2})+)\s+\|(\d)\s*$/;

export function parseUcm(text: string): UcmFile {
  const header: Partial<UcmHeader> = {};
  const entries: UcmEntry[] = [];
  let inCharmap = false;
  let skipped = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line === "CHARMAP") {
      inCharmap = true;
      continue;
    }
    if (line === "END CHARMAP") {
      inCharmap = false;
      continue;
    }
    if (!inCharmap) {
      const m = HEADER_RE.exec(line);
      if (!m) continue;
      const key = m[1];
      const value = (m[2] ?? "").replace(/^"|"$/g, "");
      switch (key) {
        case "code_set_name":
          header.codeSetName = value;
          break;
        case "uconv_class":
          header.uconvClass = value;
          break;
        case "subchar":
          header.subchar = parseByteSeq(value);
          break;
        case "mb_cur_max":
          header.mbCurMax = Number(value);
          break;
      }
      continue;
    }
    const m = ENTRY_RE.exec(line);
    if (!m) {
      // 複数コードポイント（<U..><U..> の合成列）は単純な cp→bytes Map で表せないためスキップする
      // （日本語 DBCS の常用文字には影響しない稀な合成マッピング）
      if (line.startsWith("<U")) {
        skipped++;
        continue;
      }
      continue;
    }
    const flag = Number(m[3]);
    if (flag !== 0 && flag !== 1 && flag !== 2 && flag !== 3) {
      throw new Error(`unsupported fallback flag |${flag}: ${line}`);
    }
    entries.push({
      unicode: parseInt(m[1] ?? "", 16),
      bytes: parseByteSeq(m[2] ?? ""),
      flag
    });
  }

  if (
    header.codeSetName === undefined ||
    header.uconvClass === undefined ||
    header.subchar === undefined ||
    header.mbCurMax === undefined
  ) {
    throw new Error("incomplete .ucm header");
  }
  return { header: header as UcmHeader, entries, skipped };
}

function parseByteSeq(s: string): number[] {
  const bytes: number[] = [];
  const re = /\\x([0-9A-Fa-f]{2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    bytes.push(parseInt(m[1] ?? "", 16));
  }
  return bytes;
}
