/**
 * 削除する対象を再帰的に列挙する（**消す順に並べるだけ。ここでは消さない**）。
 *
 * zip の `ifs-collect.ts` とは**別に書いている**。あちらは
 * - ファイルしか返さない（ディレクトリはキューに積むだけ）
 * - シンボリックリンクを飛ばす
 * - 上限がバイト数基準
 * で、削除には噛み合わない（研究 F6）。削除では**リンクも消さないと親が空にならず rmdir が rc=9 で止まる**し、
 * ディレクトリ自身も深い順に消す必要がある。
 *
 * 共有しているのは「ページングの罠」の扱いだけ——`entries` が空でも続きがあることがあり、
 * `canContinue` を見ずに続けると `/QSYS.LIB` で無限ループする（core の decisions D1・D6）。
 */
import type { IfsEntry, IfsListResult } from "@as400web/core";

/** 列挙に必要な操作だけを表す口（偽のリーダーでテストするため） */
export interface IfsDeleteReader {
  listFiles(
    path: string,
    opts?: { maxCount?: number; restartId?: number }
  ): Promise<IfsListResult>;
}

export interface DeleteLimits {
  /** 消す対象（ファイル・リンク・ディレクトリ）の総数の上限 */
  maxEntries: number;
  /** 辿るディレクトリ数の上限 */
  maxDirectories: number;
  /** 1 回の一覧要求で取る件数 */
  pageSize?: number;
}

export interface DeleteTarget {
  path: string;
  /** シンボリックリンクは `file`——**削除はファイル削除要求（0x000C）で行う**（リンク先は消えない） */
  kind: "file" | "directory";
}

export type DeletePlan =
  | { ok: true; targets: DeleteTarget[]; files: number; directories: number }
  /** 対象が多すぎる。**1 件も消さない** */
  | { ok: false; reason: "too-many"; entries: number }
  | { ok: false; reason: "too-many-directories"; directories: number }
  /**
   * 一覧を最後まで辿れないディレクトリがあった（`/QSYS.LIB` のように Restart ID が振られない場所）。
   * **部分削除は部分 zip より危険**なので、1 件も消さずに断る。
   */
  | { ok: false; reason: "incomplete"; path: string };

const DEFAULT_PAGE_SIZE = 1000;

/** 1 ディレクトリの中身を、ページングを最後まで辿って集める（`ifs-collect.ts` と同じ罠を踏まない） */
async function listAll(
  reader: IfsDeleteReader,
  path: string,
  pageSize: number
): Promise<{ entries: IfsEntry[]; complete: boolean }> {
  const all: IfsEntry[] = [];
  let restartId: number | undefined;
  for (;;) {
    const page = await reader.listFiles(path, {
      maxCount: pageSize,
      ...(restartId !== undefined ? { restartId } : {})
    });
    all.push(...page.entries);
    // **「空 = 終わり」と解釈しない。** `.` と `..` が件数上限を消費するため、
    // entries が空でも hasMore が真になりうる
    if (!page.hasMore) return { entries: all, complete: true };
    if (!page.canContinue || page.nextRestartId === undefined) {
      return { entries: all, complete: false };
    }
    restartId = page.nextRestartId;
  }
}

const join = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/**
 * 削除対象を**消す順（深い順・親は最後）**に並べて返す。
 *
 * 呼び出し側はこの順に「ファイルなら 0x000C・ディレクトリなら 0x000E」を出せばよい。
 * 順序が逆だと、中身の残ったディレクトリに rmdir を投げて rc=9 で止まる。
 */
export async function planDelete(
  reader: IfsDeleteReader,
  root: string,
  limits: DeleteLimits
): Promise<DeletePlan> {
  const pageSize = limits.pageSize ?? DEFAULT_PAGE_SIZE;
  const base = root.replace(/\/+$/, "") || "/";
  const targets: DeleteTarget[] = [];
  let files = 0;
  let directories = 0;

  /**
   * 深さ優先で潜り、**戻りがけに**自分を積む（子が先・親が後）。
   * 再帰の深さは IFS のパス長で頭打ちになるので、明示スタックにはしない。
   */
  async function walk(dir: string): Promise<DeletePlan | undefined> {
    directories++;
    if (directories > limits.maxDirectories) {
      return { ok: false, reason: "too-many-directories", directories };
    }
    const listed = await listAll(reader, dir, pageSize);
    if (!listed.complete) return { ok: false, reason: "incomplete", path: dir };

    for (const entry of listed.entries) {
      const full = join(dir, entry.name);
      // **リンクは辿らない（循環しうる・リンク先は対象外）が、対象には含める。**
      // 残すと親ディレクトリが空にならず rmdir が失敗する
      if (entry.isDirectory && !entry.isSymlink) {
        const failed = await walk(full);
        if (failed) return failed;
      } else {
        targets.push({ path: full, kind: "file" });
        files++;
      }
      if (targets.length + 1 > limits.maxEntries) {
        return { ok: false, reason: "too-many", entries: targets.length + 1 };
      }
    }
    // 中身を積んだ後に自分（親は最後）
    targets.push({ path: dir, kind: "directory" });
    // **ディレクトリを積むときも数える。** ファイルのループの中だけで判定していると、
    // 空フォルダばかりの木（ファイル 0 件）が件数上限をすり抜ける
    if (targets.length > limits.maxEntries) {
      return { ok: false, reason: "too-many", entries: targets.length };
    }
    return undefined;
  }

  const failure = await walk(base);
  if (failure) return failure;
  // ルート自身も対象に含めた分をディレクトリ数として数える
  return { ok: true, targets, files, directories: targets.length - files };
}
