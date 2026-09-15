# タスク: `PR#387` の ACS 前提が未検証だったことへの対応

## 実装方針

`design.md` の通り、`handleRecord()` から `PR#387` 分岐（および専用の
`cursorBeforeWasEnterable` 計算）を削除し（T1）、その分岐でのみ使われていた
`buffer.ts` の `isEnterableAt()`・`cursorIsUnenterable()` を削除する（T2）。
`cursor-stale-on-protected.test.ts` の1つ目の describe ブロックを新しい期待値
（寄せない）に書き直し、2つ目の describe ブロック（PageUp/PageDown、`decisions.md`
D5 で追加、`PR#387` 分岐が無くなると区別する力を失う）を削除する（T3）。
既存の関連テスト（`cursor-default.test.ts`、`screen-grid-cursor-restore.test.ts`）
を実行して回帰が無いことを確認する（T4）。分割は行わない（変更が1〜2ファイルへの
削除中心の小規模な変更のため）。

## 作業順序と依存関係

下の `依存:` に従う。T1 が起点。T2 は T1 に依存（`isEnterableAt`/
`cursorIsUnenterable` の呼び出し元が無くなったことを T1 の変更で確認してから
削除するため）。T3 は T1・T2 に依存（削除後の挙動に合わせてテストを書き直す
ため）。T4 は T3 の後に着手する（同じ変更を検証する対象なので、T3 が終わって
から実行する——並行させても得るものが無い）。T5・T6 は依存が無く、いつ着手
してもよい——T5 は既存文書の充足確認、T6 は deliver 工程で実施する backlog
記録であり、いずれも T1〜T4 のコード変更とは独立している。

## リスク / 留意点

- `isEnterableAt()`・`cursorIsUnenterable()` を削除する前に、`PR#387` 分岐
  以外に呼び出し元が本当に無いことを再確認する（`research.md`「依拠する既存の
  事実」で確認済みだが、T1 の変更後にもう一度 `grep` で確認する）。
- `cursor-stale-on-protected.test.ts` の2つ目の describe ブロックを削除する際、
  1つ目のブロックのヘルパー関数（`rx()`, `firstScreen()`, `secondScreen()`,
  `play()`）は1つ目のブロックで引き続き使うため、誤って削除しないこと。
- 実機確認（T4 の後、review 工程で実施予定）では、`.aidev/works/
  20260915-pdm-protected-cursor-pageup` で確立した「分岐ごとの直接ログ」の
  教訓を踏まえ、`cursorToFirstInputField()` の呼び出し有無を直接計装して
  確認する（生バイト検索は使わない）。

## テスト方針

- 自動テストは実機接続なしで完結させる（既存パターンと同じ）。
- T3: 1つ目の describe ブロックの4テストを、「動いていない・保護欄」でも
  ホストの指定にそのまま従う（寄せない）という新しい期待値に書き直す。
  修正前のコード（`PR#387` 分岐が残っている状態）に対してこれらのテストが
  実際に失敗すること（discrimination）を確認する。2つ目の describe ブロックは
  削除する。
- T4: 既存の関連テスト（`cursor-default.test.ts`、
  `screen-grid-cursor-restore.test.ts`）を実行し、T1・T2 の変更後も green の
  ままであることを確認する。
- test 工程で、実機（SR-OSAKA/ASAOLIB）に対して `scripts/diag-cursor-after-expand.mjs`
  （CURSORCL3）・`scripts/diag-seu-protected-cursor-pageup.mjs`（SEU）を再実行し、
  分岐削除後の実際の挙動を確認する（AC3 の一部。coding では行わず test 工程で
  実施——`design.md`「受け入れ基準との対応」AC3 参照）。

## タスク

- [x] T1: `handleRecord()` から `PR#387` 分岐（`else if` 節）と、専用の
      `cursorBeforeWasEnterable` 計算箇所を削除する。
      対象: `packages/tn5250/src/session/session.ts`（`research.md` A1, A2）
      / 根拠: design.md「インターフェース / データ構造」
      依存: なし
      AC: AC1
- [x] T2: `buffer.ts` の `isEnterableAt()`・`cursorIsUnenterable()` を削除する
      （T1 の変更後、呼び出し元が無いことを確認してから）。
      対象: `packages/tn5250/src/screen/buffer.ts`（`research.md` A3）
      / 根拠: design.md「インターフェース / データ構造」, requirements.md AC1
      依存: T1
      AC: AC1
- [x] T3: `cursor-stale-on-protected.test.ts` の1つ目の describe ブロックを
      新しい期待値に書き直し、2つ目の describe ブロックを削除する。修正前の
      コードに対して新しい期待値のテストが実際に失敗すること（discrimination）
      を確認する。
      対象: `packages/tn5250/test/cursor-stale-on-protected.test.ts`
      （`research.md` A4） / 根拠: design.md「対象範囲」「受け入れ基準との対応」AC4
      依存: T1, T2
      AC: AC4
- [x] T4: 既存の関連テスト（`cursor-default.test.ts`、
      `screen-grid-cursor-restore.test.ts`）を実行し、T1・T2 の変更後も
      green のままであることを確認する。**当初の想定に反し、
      `cursor-default.test.ts` には `cursorIsUnenterable()` の単体テスト
      （「カーソルが入力できない桁にあるかを見分ける」describe、4テスト）が
      あり、T2 でメソッドを削除したことで失敗した——このブロックも削除する
      形で T4 を完了した（`decisions.md` D1。当初 `research.md` の grep が
      `src/` のみを対象にしており `test/` の呼び出し元を見落としていた）。**
      `screen-grid-cursor-restore.test.ts` は変更不要のまま green。
      対象: `packages/tn5250/test/cursor-default.test.ts`,
            `packages/web-ui/test/screen-grid-cursor-restore.test.ts`
      / 根拠: design.md「受け入れ基準との対応」AC3
      依存: T3
      AC: AC3
- [x] T5: AC2（発見の経緯・実機同時比較ができない制約・将来の再検証の余地）は
      `research.md`・`design.md`・`decisions.md` で既に充足済みであることを
      確認する。coding での新規作業は発生しない。
      対象: `.aidev/works/20260915-pr387-acs-premise-unverified/decisions.md`
      / 根拠: research.md F1-F4, design.md「概要」「エラー処理 / 異常系」
      依存: なし
      AC: AC2
- [x] T6: `.aidev/backlog/acs-parity.md` に、今回の発見（`PR#387` の前提が
      未検証だったこと）と、実機 ACS による再確認が今後の課題として残って
      いることを記録する。deliver 工程で実施する（coding では新規作業は
      発生しない）。
      対象: `.aidev/backlog/acs-parity.md` / 根拠: design.md「受け入れ基準との対応」AC5
      依存: なし
      AC: AC5
