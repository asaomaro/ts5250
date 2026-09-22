# レビュー: J の詰め物

## タスク点検ログ
- T1・cross: 同じセッションで差分を読み直した。指摘なし。

## ラウンド 1（同じセッション。独立点検は節目で）
- 要件適合: `aidev coverage` は tasks 承認時と同じ（gap 0）。AC1〜AC3 を単体と mutation で固定した。
- 価値適合: J の途中の空きへ打っても Enter で送れる。
- 正確性: G と同じ `wideFill`・`trimPad` を J へ広げた。E・O は変えていない。J の挿入の既存テストの期待値は破棄した前提（末尾の全角空白を値に含める）を D1 に記録して更新した。
- 規約適合: 台帳の起票を `[x]` に更新した。
- 指摘なし。

## ラウンド 2（節目 11 の独立点検。`scratchpad/rv11/review-webui.md`。担当 B）
- [should] **B-S2** `packages/web-ui/src/components/ScreenGrid.vue`（Field Exit の DBCS 枝・Field±・`eraseEofKey`）／`composables/fieldEdit.ts`（`eraseToEnd`）: J・G 欄で Erase EOF の後に右へ動いて打つと、値に半角空白が残って core が「全角しか入力できない」で拒否していた（j-wide-fill AC1 が偽）。DBCS の欄は `eraseToEnd`（カーソル以降を半角空白 1 つずつで埋める）をそのまま使っており、`padDbcs`（J・G は全角空白で詰める）を通さなかった。貼り付け・IME・Delete・Backspace は `padDbcs` を通るので問題なかった。DBCS 専用の `eraseToEndDbcs`（カーソル以降を切り、`padDbcs` で詰め直す）を新設し、Erase EOF・Field Exit・Field± の 3 か所で使うように直した。

対応: `eraseToEndDbcs` を新設し、J・G の Erase EOF・Field Exit・Field± の後で右へ動いて打っても半角空白が混ざらないことをテストで固定（J・G × 3 操作の 6 通り＋E の桁数の確認）。mutation で検出を確認した。

## ラウンド 3（通過）
- ラウンド 2 の指摘（should 1）を直した。`eraseToEndDbcs` をテストで固定し、mutation 4 通り検出。「43 ファイル 647 passed」の未再現の記録も直した（B-N5 と合わせて対応）。指摘なし。
