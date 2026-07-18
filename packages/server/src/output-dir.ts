import { stat, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * PDF 自動出力先（printer.autoPdfDir）の保存時検証。
 *
 * 受信時まで失敗が分からないと、設定した場所・時点から離れたところで ENOENT が出て原因を追いにくい。
 * 保存時に「存在する / ディレクトリである / 実際に書ける」を確認し、その場でエラーにする。
 *
 * **ディレクトリは作成しない**（タイポで意図しない場所を掘るのを避ける。作成は利用者に委ねる）。
 * また保存経路（canEditProfiles ゲート下）でのみ呼ぶ。起動時や接続時には検証しない
 * （出力先が一時的に見えないだけで起動不能・既存設定破壊になるのを避ける）。
 */
export type DirCheck = { ok: true; path: string } | { ok: false; reason: string };

/** 書き込みテスト用の一時ファイル名（衝突回避のため pid＋連番） */
let seq = 0;
function tempName(): string {
  seq += 1;
  return `.as400-write-test-${process.pid}-${seq}`;
}

/**
 * 出力先を検証する。成功時は解決後の絶対パスを返す（相対パス・タイポを UI で気づけるように）。
 *
 * 書き込み可否は `access(W_OK)` ではなく**実際に書いて消す**ことで確認する。読み取り専用 FS や
 * ACL では access の結果が実態と食い違うことがあり、「保存は通ったのに受信時に失敗」が起きるため。
 */
export async function checkOutputDir(dir: string): Promise<DirCheck> {
  const path = resolve(dir);
  try {
    const st = await stat(path);
    if (!st.isDirectory()) {
      return { ok: false, reason: `PDF 出力先がフォルダではありません: ${path}` };
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return { ok: false, reason: `PDF 出力先が見つかりません: ${path}（先にフォルダを作成してください）` };
    }
    return { ok: false, reason: `PDF 出力先を確認できません: ${path}（${err.message}）` };
  }

  // 実書き込みテスト。成功・失敗いずれでも一時ファイルを残さない
  const probe = join(path, tempName());
  try {
    await writeFile(probe, "");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { ok: false, reason: `PDF 出力先に書き込めません: ${path}（${err.message}）` };
  } finally {
    await unlink(probe).catch(() => {
      /* 書き込みに失敗していれば存在しない。後始末なので無視してよい */
    });
  }
  return { ok: true, path };
}
