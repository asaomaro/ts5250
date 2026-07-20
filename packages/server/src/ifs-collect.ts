/**
 * IFS のフォルダを再帰的に辿り、zip に入れるファイルを集める。
 *
 * **上限判定は中身を読む前に行う。** 実効スループットは約 100KB/s しかない（実測）ので、
 * 500MB を読み切ってから「大きすぎます」と言うのは、利用者を 80 分待たせてから断ることになる。
 * 一覧が返すサイズを積算し、超えると分かった時点で 1 バイトも読まずに拒否する。
 */
import type { IfsEntry, IfsListResult } from "@as400web/core";

/**
 * 収集に必要な操作だけを表す口。
 *
 * `IfsConnection` そのものではなくこれを受け取るのは、**プレーンなオブジェクトで
 * テストできるようにするため**。具象クラスを要求すると、再帰と上限判定を確かめるのに
 * 実接続かそれに準ずるものが要る。
 */
export interface IfsReader {
  listFiles(
    path: string,
    opts?: { maxCount?: number; restartId?: number }
  ): Promise<IfsListResult>;
  readFile(path: string): Promise<Uint8Array>;
}

export interface CollectLimits {
  maxBytes: number;
  maxFiles: number;
  /** 1 回の一覧要求で取る件数。巨大ディレクトリ対策 */
  pageSize?: number;
  /**
   * 辿るディレクトリ数の上限。既定 5,000。
   *
   * ファイル数とバイト数だけを見ていると、**0 ファイル・10 万ディレクトリ**のツリーが
   * どの上限にも掛からないまま 10 万往復する。100KB/s のホストでは数時間かかり、
   * 「利用者を待たせない」という上限の目的が達成できない。
   *
   * **ファイル数の上限（既定 500）と同じにしない。** コストの性質が違う——
   * ファイルは転送量に律速されるが、ディレクトリは往復 1 回で済む。
   * ソースツリーやビルド成果物は 500 フォルダを簡単に超えるので、
   * 揃えると「合計 1MB しか無いのに弾かれる」ことが普通に起きる。
   */
  maxDirectories?: number;
}

export interface CollectedFile {
  /** zip の中でのパス（対象フォルダからの相対） */
  path: string;
  size: number;
  modifiedAt: number;
}

export type CollectResult =
  | { ok: true; files: CollectedFile[]; totalBytes: number }
  /** 上限を超えた。**この時点で中身は読んでいない** */
  | { ok: false; reason: "too-large"; files: number; bytes: number }
  /**
   * 一覧を最後まで辿れないディレクトリがあった。
   *
   * `/QSYS.LIB` のように Restart ID を振らないファイルシステムでは、
   * 件数上限で打ち切られた続きを取る手段が無い（core の decisions D6）。
   * **黙って部分的な zip を返さない**——欠けていることに気づけないアーカイブは、
   * 失敗するより悪い。どのディレクトリで辿れなくなったかを添えて拒否する。
   */
  | { ok: false; reason: "incomplete"; path: string }
  /** 辿るディレクトリが多すぎる。ファイル数・バイト数では止まらない形 */
  | { ok: false; reason: "too-many-directories"; directories: number };

const DEFAULT_PAGE_SIZE = 1000;
/** 辿るディレクトリ数の既定の上限（往復コストに見合う値）*/
export const DEFAULT_MAX_DIRECTORIES = 5000;

/**
 * 1 ディレクトリの中身を、ページングを最後まで辿って集める。
 *
 * ページングの罠が 2 つある（core の decisions D1・D2・D6）:
 * - **`entries` が空でも `hasMore` が true になりうる**（`.` と `..` が件数上限を消費する）。
 *   「空 = 終わり」と解釈すると、中身のあるディレクトリが空に見える
 * - **`canContinue` を見ずに `nextRestartId` を渡し続けると無限ループする**
 *   （`/QSYS.LIB` は全エントリの Restart ID が 0 で返る）
 */
async function listAll(
  reader: IfsReader,
  path: string,
  pageSize: number
): Promise<{ entries: IfsEntry[]; complete: boolean }> {
  const all: IfsEntry[] = [];
  let restartId: number | undefined;
  for (;;) {
    const page: IfsListResult = await reader.listFiles(path, {
      maxCount: pageSize,
      ...(restartId !== undefined ? { restartId } : {})
    });
    all.push(...page.entries);
    if (!page.hasMore) return { entries: all, complete: true };
    // **まだあるのに辿れない。** ここで黙って打ち切ると、呼び出し側は
    // 「全部取れた」と思い込む。取りこぼしたことを伝える
    if (!page.canContinue || page.nextRestartId === undefined) {
      return { entries: all, complete: false };
    }
    restartId = page.nextRestartId;
  }
}

/**
 * フォルダ配下のファイルを再帰的に列挙する（**中身は読まない**）。
 *
 * シンボリックリンクは辿らない。IFS のリンクは循環しうるうえ、
 * リンク先が対象フォルダの外に出ると「このフォルダを固めた」ことにならないため。
 */
export async function collectFiles(
  reader: IfsReader,
  root: string,
  limits: CollectLimits
): Promise<CollectResult> {
  const pageSize = limits.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxDirectories = limits.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  const files: CollectedFile[] = [];
  let totalBytes = 0;
  let directories = 0;
  // **入口で 1 回だけ正規化する。** 末尾のスラッシュは何本でも落とす。
  // 特別扱いを複数箇所に散らすと噛み合わなくなる——`root === "/"` だけを見る版では
  // `"//"` で base が "/" になり、相対パスの計算が 1 文字ずれてファイル名が欠けた
  const base = root.replace(/\/+$/, "");
  // 空文字を一覧に渡すと core が「path is empty」で弾くので、ルートは "/" に戻す
  const queue: string[] = [base || "/"];

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    directories++;
    if (directories > maxDirectories) {
      return { ok: false, reason: "too-many-directories", directories };
    }
    const listed = await listAll(reader, dir, pageSize);
    if (!listed.complete) {
      // 部分的な zip を返さない（欠けに気づけないアーカイブは失敗より悪い）
      return { ok: false, reason: "incomplete", path: dir };
    }
    for (const entry of listed.entries) {
      // ルート直下では dir が "/" なので、素直に連結すると "//name" になる。
      // 規則は 1 つに保つ（base の正規化と対で辻褄を合わせない）
      const full = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
      if (entry.isSymlink) continue;
      if (entry.isDirectory) {
        queue.push(full);
        continue;
      }
      files.push({
        // zip の中は対象フォルダからの相対にする（先頭の `/` を落とす）
        path: full.slice(base.length + 1),
        size: entry.size,
        modifiedAt: entry.modifiedAt
      });
      totalBytes += entry.size;
      if (files.length > limits.maxFiles || totalBytes > limits.maxBytes) {
        // **ここで打ち切る。中身はまだ 1 バイトも読んでいない**
        return { ok: false, reason: "too-large", files: files.length, bytes: totalBytes };
      }
    }
  }
  return { ok: true, files, totalBytes };
}

export type ReadResult =
  | { ok: true; files: { path: string; data: Uint8Array; modifiedAt: Date }[] }
  /** 読み取り中に上限を超えた（列挙時のサイズと実際が食い違った） */
  | { ok: false; bytes: number };

/** 列挙したファイルの中身を読む。上限を通過した後にだけ呼ぶこと */
export async function readCollected(
  reader: IfsReader,
  root: string,
  files: readonly CollectedFile[],
  maxBytes?: number
): Promise<ReadResult> {
  const base = root.replace(/\/+$/, "");
  const out: { path: string; data: Uint8Array; modifiedAt: Date }[] = [];
  let total = 0;
  for (const f of files) {
    const data = await reader.readFile(base === "" ? `/${f.path}` : `${base}/${f.path}`);
    total += data.length;
    // 列挙時のサイズと実際の読み取りが食い違うことがある（列挙後に肥大した等）。
    // **例外にしない**——列挙段で超えたら 413、読み取り段で超えたら別のステータス、では
    // 利用者から見て区別のつかない同じ事象が経路によって違う扱いになる
    if (maxBytes !== undefined && total > maxBytes) {
      return { ok: false, bytes: total };
    }
    out.push({ path: f.path, data, modifiedAt: new Date(f.modifiedAt) });
  }
  return { ok: true, files: out };
}
