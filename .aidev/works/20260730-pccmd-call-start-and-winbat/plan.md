# 計画: Windows 実機で見つかった 2 件を直す

## 実装方針

**小さい方から当てる**（`start.bat` → `pc-command.ts` → テスト → 文書）。
subtask には割らない（3 ファイル・独立した 2 件）。

`pc-command.ts` は純関数を足して `spawn` の直前で呼ぶだけ。既存の判定・待ち・
上限打ち切りには触らない（回帰の範囲を「置換が挟まったこと」だけに閉じる）。

## 作業順序と依存関係

1. `start.bat` に `--auto-secret-key`（依存: なし）
2. `pc-command.ts`: `stripCallBeforeStart` ＋ 適用 ＋ `detached: true`（依存: なし）
3. 回帰テスト（境界・順序）（依存: 2）
4. 既存テスト・lint・build（依存: 3）
5. 空振り検証（依存: 4）
6. 文書（backlog の結論・decisions）（依存: 5）

## リスク / 留意点

- **置換の位置**（`isAllowed` の後）を間違えると許可判定の意味が変わる
- **`g` を付ける**（原資料は 1 回だけ。`&` で 2 つ並ぶと 2 つ目が残る）
- **Windows で確認できない**。実機の裏付けは原資料。PR に穴として明記する
- `detached: true` で既存テスト（終了コード・上限打ち切り・cwd）が壊れないか実行して確かめる
- 引用符の中の `CALL START` も落とす（既知の限界。コメントに書く）

## テスト方針

- `stripCallBeforeStart`: spec の境界表をそのままテストにする
- `runPcCommand`: **置換が許可判定より後**であること（`CALL START …` を許可した設定で
  実行できる／`START …` だけを許可した設定では弾かれる）
- 既存 11 件が通ること（`detached` の影響を見る）

## 空振り検証（mutation）

- 置換を `isAllowed` の前に移す（許可判定の意味が変わる）
- `g` を外す（2 つ目が残る）
- `i` を外す（小文字の `call start` が残る）
- 語境界（`\b`）を外す（`MYCALL START` を壊す）
- 置換を呼ばない（元の文字列で spawn する）
- `start.bat` から `--auto-secret-key` を落とす（**テストが無い＝空振りするはず**。
  Windows 専用スクリプトなのでここは正直に「テストで守れない」と記録する）
