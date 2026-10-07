/**
 * IFS 一覧の並べ替え（`IfsPane.vue`）。**純関数だけ**を置く（Vue にも `localStorage` にも触れない）。
 *
 * - **フォルダを先に出す**（昇順・降順どちらでも）。エクスプローラーと同じで、降順にしたとき
 *   フォルダが末尾へ流れて「開けない」と見えるのを避ける。
 * - **`server`（既定）は並べ替えない**。サーバーが返した順をそのまま見せる従来の挙動で、
 *   選ばなければ何も変わらない。
 * - **名前は自然順**（`file2` を `file10` の前に。大文字小文字・濃淡は区別しない）。
 * - **同点は名前の昇順で決める**——並びが毎回同じになり、再読み込みで行が入れ替わらない。
 * - 並べ替えるのは**読み込み済みの分だけ**。1000 件を超えるフォルダは続きを読むまで全体の
 *   先頭・末尾にならない（呼び出し側が注記を出す）。
 */
import type { IfsEntry } from "../ifsApi.js";

export type IfsSortKey = "server" | "name" | "size" | "modified";
export type IfsSortDir = "asc" | "desc";

export const IFS_SORT_KEYS: readonly { key: IfsSortKey; label: string }[] = [
  { key: "server", label: "サーバー順" },
  { key: "name", label: "名前" },
  { key: "size", label: "サイズ" },
  { key: "modified", label: "更新日時" }
];

/** 保存値などから来た文字列を検査する（書き換えられうる値を型へ入れない） */
export function isIfsSortKey(v: unknown): v is IfsSortKey {
  return IFS_SORT_KEYS.some((k) => k.key === v);
}

const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

/** 名前の昇順。自然順で並べ、区別が付かない（大文字小文字違いなど）ときは生の文字列で決める */
function byName(a: IfsEntry, b: IfsEntry): number {
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * 並べ替えた**新しい配列**を返す（元は変えない。`entries` はツリーの状態そのもの）。
 *
 * サイズは**フォルダには意味が無い**（`sizeText` も空にしている）ので、フォルダ同士は名前で並べる。
 * 方向（`dir`）は主キーにだけ掛かり、同点の名前順は常に昇順。
 */
export function sortEntries(entries: readonly IfsEntry[], key: IfsSortKey, dir: IfsSortDir): IfsEntry[] {
  if (key === "server") return [...entries];
  const sign = dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let primary = 0;
    if (key === "name") primary = byName(a, b);
    else if (key === "modified") primary = a.modifiedAt - b.modifiedAt;
    else if (!a.isDirectory) primary = a.size - b.size;
    return primary !== 0 ? primary * sign : byName(a, b);
  });
}
