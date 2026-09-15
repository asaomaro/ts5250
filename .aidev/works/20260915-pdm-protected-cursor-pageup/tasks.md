# タスク: SEU でカーソルを保護欄に置いた状態で PageUp/PageDown すると、
カーソルがヘッダーの入力欄へ強制移動してしまう不具合の修正

## 実装方針

`design.md` の通り、`Session5250` に `lastSentAid` を再追加し（T1）、
`handleRecord()` の**2つの分岐**（`!result.cursorSet` 分岐・`PR#387` 分岐）両方に
`isPageKey` 除外条件を追加する（T2、`decisions.md` D3 の通り片方だけでは効かない）。
新規回帰テスト（T3）と既存シナリオの回帰確認（T4）を行う。AC3（実機トレースの記録）は
`research.md` で既に充足済みのため、coding では新規作業を発生させない（T5）。
分割は行わない（変更が1ファイルへの小規模な追加のため）。

## 作業順序と依存関係

下の `依存:` に従う。T1 が起点。T2 は T1 に依存。T3（新規テスト追加）・T4（既存テスト実行）
は T2 の後に着手できるが、**異なるファイルを扱うため並行着手してよい**（`依存:` は
どちらも T2 のみ）。T5 は依存が無く、いつ着手してもよい。

## リスク / 留意点

- `design.md`「インターフェース / データ構造」の通り、`isPageKey` 条件は
  **2つの分岐両方**に追加する。片方だけに追加すると、`decisions.md` D3 の通り
  もう片方が代わりに発火してしまい、修正が効かない。T2 実装時に特に注意する。
- `lastSentAid` の更新は Attn/SysReq を除外する（`design.md`「インターフェース /
  データ構造」）。この除外の副作用（既知の残存リスク、`design.md`「エラー処理 /
  異常系」）はこの work のスコープでは対応しない。

## テスト方針

- 自動テストは実機接続なしで完結させる（既存の `cursor-stale-on-protected.test.ts` 等と
  同じパターン——手作りの WTD バイト列を `Session5250` に流し込む合成テスト）。
- T3: 保護欄にカーソルがある状態で PageUp/PageDown を送り、(a) ホストが IC/MC を
  送ってこない場合にカーソル位置が変わらないこと、(b) 対称性の確認として
  PageUp・PageDown 両方向で同じ結果になること、を確認する。修正前のコードに対して
  実際に失敗すること（discrimination）を確認する。
- T4: 既存の関連テスト（`cursor-stale-on-protected.test.ts`＝`PR#387` 本来のシナリオ、
  `cursor-default.test.ts`＝F1ヘルプ・27x132切替、`screen-grid-cursor-restore.test.ts`＝
  SEU 走査検索）を実行し、green のままであることを確認する。

## タスク

- [x] T1: `Session5250` に非公開フィールド `lastSentAid?: AidKey` を再追加し、
      `sendAid()` 内でレコード送信時に更新する（Attn/SysReq は除外）。
      対象: `packages/tn5250/src/session/session.ts`（フィールド宣言付近、
      `sendAid()` 内） / 根拠: design.md「インターフェース / データ構造」
      依存: なし
      AC: なし
- [x] T2: `handleRecord()` の `!result.cursorSet` 分岐・`PR#387` 分岐の**両方**に
      `isPageKey`（`lastSentAid` が PageUp/PageDown か）の除外条件を追加する。
      対象: `packages/tn5250/src/session/session.ts:638-659`
      （2分岐の条件式） / 根拠: design.md「インターフェース / データ構造」, decisions.md D3
      依存: T1
      AC: AC1
- [x] T3: 保護欄でのカーソル維持を検証する回帰テストを追加する（既存の
      `cursor-stale-on-protected.test.ts` へ追加）。PageUp・PageDown を送り、
      ホストが**送信前と同じ保護欄位置を明示的に指し直す**合成 WTD
      （`cursorSet=true` かつ `cursorAddr === cursorBefore` かつ
      `cursorIsUnenterable()`——実機で観測した実際の形。`research.md` F2〜F5 で
      判明。当初は `cursorSet=false` のケースを想定していたが、実機トレースで
      `cursorSet=true` だったと判明したため修正した。`decisions.md` D4）で、
      送信前のカーソル位置（保護欄）が変わらないことを確認する。PageUp・PageDown
      両方向のケースを含める。修正前のコードに対してこのテストが実際に失敗する
      こと（discrimination）を `git stash` で確認済み。
      対象: `packages/tn5250/test/`（ファイル名は coding で決定） / 根拠: design.md「受け入れ基準との対応」AC1
      依存: T2
      AC: AC1
- [x] T4: 既存の関連テスト（`cursor-stale-on-protected.test.ts`、`cursor-default.test.ts`、
      `screen-grid-cursor-restore.test.ts`）を実行し、T2 の変更後も green のままで
      あることを確認する。
      対象: `packages/tn5250/test/cursor-stale-on-protected.test.ts`,
            `packages/tn5250/test/cursor-default.test.ts`,
            `packages/web-ui/test/screen-grid-cursor-restore.test.ts` / 根拠: design.md「受け入れ基準との対応」AC2, AC5
      依存: T2
      AC: AC2, AC5
- [x] T5: AC3（実機トレースで試した具体的な条件と結果の記録）・AC4（修正方針が
      実機トレースの事実に基づいていること）は `research.md` で既に充足済みで
      あることを確認する。coding での新規作業は発生しない。
      対象: `.aidev/works/20260915-pdm-protected-cursor-pageup/research.md` / 根拠: research.md F1-F5
      依存: なし
      AC: AC3, AC4
