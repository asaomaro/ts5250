/**
 * PDF に埋め込む**等幅 CJK フォント**をシステムから探す。
 *
 * スプールの PDF は端末の桁をそのまま紙に落とすので、
 * **半角 1 : 全角 2** の等幅でないと桁が崩れる。
 *
 * ## なぜ環境ごとに探すのか
 *
 * 以前は Linux の Noto のパスを 1 本だけ焼き込んでいた。Windows で自動出力すると
 * そのパスに `C:` が付いて `C:\usr\share\fonts\...` を探しに行き、必ず失敗して
 * Courier（DBCS 化け）に落ちていた（利用者の報告）。
 *
 * ## 名前を焼き込まない
 *
 * `.ttc` は複数の書体を束ねているので、pdfkit には**どの書体か**を postscript 名で
 * 渡す必要がある。名前を焼き込むと、版やロケールで中身が違ったときに黙って外れる。
 * そこで**ファイルを開いて等幅の面を選ぶ**——`i` と `W` の送り幅が等しく、
 * かつ `あ` のグリフを持つ面。実測でこの判定は効く:
 *
 * | ファイル | 面 | i | W | あ | |
 * |---|---|---|---|---|---|
 * | `msgothic.ttc` | `MS-Gothic` | 128 | 128 | 256 | **等幅** |
 * | 〃 | `MS-PGothic` | 54 | 190 | 241 | プロポーショナル |
 * | `NotoSansCJK-Regular.ttc` | `NotoSansMonoCJKjp-Regular` | 500 | 500 | 1000 | **等幅** |
 * | 〃 | `NotoSansCJKjp-Regular` | 275 | 878 | 1000 | プロポーショナル |
 *
 * 候補のファイル名だけを platform ごとに持ち、面の選択は実物に聞く。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openSync, type FontkitFace } from "fontkit";

/** 選んだフォント。`face` は `.ttc` から選んだ postscript 名（単一フォントなら未指定） */
export interface MonoFont {
  path: string;
  face?: string;
}

/**
 * 探す候補（ファイルのパス）。**先に来たものを優先**する。
 *
 * - Windows: `MS ゴシック` は日本語 Windows に必ずある古株。`BIZ-UDGothic` は
 *   Windows 10 1809 以降。どちらも等幅であることを利用者の環境で実測した。
 *   フォントの置き場は `%WINDIR%` から引く（`C:\Windows` 決め打ちにしない）。
 *   ユーザーが「自分だけにインストール」したフォントは `%LOCALAPPDATA%` 側に入る。
 * - Linux: 従来どおり Noto CJK。Debian/Ubuntu の既定の置き場。
 * - macOS: **確かめられていないので候補を置かない**（Courier に落ちる。従来と同じ）。
 *   実機で等幅 CJK を確認できたら足す。
 */
export function candidateFontPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform === "win32") {
    const dirs = [
      join(env["WINDIR"] ?? env["SystemRoot"] ?? "C:\\Windows", "Fonts"),
      ...(env["LOCALAPPDATA"] ? [join(env["LOCALAPPDATA"], "Microsoft", "Windows", "Fonts")] : [])
    ];
    const names = ["msgothic.ttc", "BIZ-UDGothicR.ttc", "msmincho.ttc"];
    return dirs.flatMap((d) => names.map((n) => join(d, n)));
  }
  return [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansMonoCJK-Regular.ttc",
    "/usr/local/share/fonts/NotoSansCJK-Regular.ttc"
  ];
}

/** 半角 1 : 全角 2 の等幅で、かつ日本語のグリフを持つか */
function isMonoCjk(font: FontkitFace): boolean {
  try {
    if (font.hasGlyphForCodePoint && !font.hasGlyphForCodePoint(0x3042)) return false; // 「あ」
    const i = font.layout("i").advanceWidth;
    const w = font.layout("W").advanceWidth;
    const kana = font.layout("あ").advanceWidth;
    return i > 0 && i === w && kana === i * 2;
  } catch {
    return false;
  }
}

/**
 * 1 つのファイルから等幅 CJK の面を選ぶ。見つからなければ `undefined`。
 *
 * **開けないファイルで落ちない**——探索中に壊れたフォントを踏んでも、
 * 次の候補へ進めるようにする。
 */
export function pickMonoFace(path: string): MonoFont | undefined {
  try {
    const opened = openSync(path);
    if ("fonts" in opened) {
      const hit = opened.fonts.find((f) => isMonoCjk(f));
      return hit ? { path, face: hit.postscriptName } : undefined;
    }
    return isMonoCjk(opened) ? { path } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * システムから等幅 CJK フォントを 1 つ選ぶ。無ければ `undefined`（呼び出し側は Courier へ）。
 *
 * 候補を**存在するものだけ**開くので、無い環境でも無駄な例外を出さない。
 */
export function findMonoCjkFont(env: NodeJS.ProcessEnv = process.env): MonoFont | undefined {
  for (const path of candidateFontPaths(env)) {
    if (!existsSync(path)) continue;
    const hit = pickMonoFace(path);
    if (hit) return hit;
  }
  return undefined;
}
