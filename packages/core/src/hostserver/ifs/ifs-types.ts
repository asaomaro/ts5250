/**
 * IFS の一覧が返す形。
 *
 * **ブラウザからも import される**（web-ui は `@as400web/core/browser` 経由でしか core を使えない）。
 * そのため、このファイルには `node:*` にも I/O にも依存するものを置かない——型だけに保つこと。
 */

/** ディレクトリの中の 1 件 */
export interface IfsEntry {
  /** ファイル名。パスではなく、そのディレクトリ内での名前 */
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  /** バイト数。シンボリックリンクではリンク先パスの長さになる（実機で確認） */
  size: number;
  /** 更新日時（UNIX ミリ秒） */
  modifiedAt: number;
  /**
   * サーバーがエントリごとに振る ID。**診断用**。
   *
   * **ページングにこれを使わないこと**——続きの起点は `IfsListResult.nextRestartId` を見る。
   * ここから取ると、`.` と `..` だけで件数上限に達した場合に `entries` が空になり、
   * 続きの起点を失う（そしてエラーにならないので気づけない）。
   *
   * 値は連番とは限らない。実機の `/home` では 6 → 1401 → 2157 と飛んだ。
   */
  restartId: number;
}

export interface IfsListResult {
  entries: IfsEntry[];
  /**
   * サーバーが件数上限で打ち切ったか（続きがある）。
   *
   * **`entries` が空でも true になりうる**——`.` と `..` もサーバーの件数上限を消費するため、
   * 上限が小さいとその 2 件だけで枠を使い切る。「空 = 終わり」と解釈しないこと。
   */
  hasMore: boolean;
  /**
   * 続きを取るとき次の要求へ渡す値。`hasMore` が true のときだけ意味を持つ。
   *
   * **`entries` の最後ではなく、除外した `.` / `..` を含む「受信した最後のエントリ」の値**。
   * 除外後の最後から取ると、全件が除外されたときに続きの起点を失う。
   *
   * **`hasMore` が true でも undefined になりうる**——`/QSYS.LIB` のように
   * Restart ID を振らない（全エントリ 0 を返す）ファイルシステムがあるため。
   * その場合は続きを取る手段が無い（`canContinue` を見ること）。
   */
  nextRestartId?: number;
  /**
   * 続きを取れるか。`hasMore && !canContinue` は「まだあるが、この場所では辿れない」を意味する。
   *
   * 実機で `/QSYS.LIB` は全エントリの Restart ID が 0 で返ることを確認した。
   * これを無検査で次の要求に渡すと**毎回先頭から同じ数件が返り、無限ループになる**
   * （原典の注記と整合する: QSYS は Restart *Name* を使い、/root は Restart *ID* を使う）。
   */
  canContinue: boolean;
}
