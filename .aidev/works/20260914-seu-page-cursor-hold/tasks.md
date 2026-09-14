# タスク: SEU の PageUp/PageDown で境界ページに到達したときカーソル位置を保持する

## 実装方針

`design.md` の疑似コード通り、`Session5250` に (1) 直前送信 AID キーの保持、(2) 画面内容の
完全一致比較ヘルパー、の2つの小さな基盤を先に追加し、それらを使って (3) `handleRecord()` の
カーソル確定ロジックに新しい分岐を1つ挿入する。既存の2分岐（613-616, 617-634）はコードを
一切変更しない。最後に、新しい分岐そのものを検証する統合テスト（AC1: 最終ページ到達までの
PageDown、AC2: 先頭ページ到達までの PageUp——いずれも Rule1・Rule2 それぞれの合成 WTD で
境界到達時のカーソル維持を確認する。AC3: 途中ページ（非境界）遷移で既存の維持動作に回帰が
無いことを同じテスト内で確認する。この統合テスト自体が AC8 の充足でもある——実質1つの
テスト追加作業）と、既存シナリオの回帰確認（AC5/AC6/AC7。既存テストを実行して green を
維持することの確認）を行う。
AC4（実機トレースでの原因確認）は `research.md` で既に充足済みのため、coding では新規の作業を
発生させない。

## 作業順序と依存関係

下の `依存:` に従う。T1・T2 は互いに独立（並行着手可）。T3 は両方が終わってから。
T4・T5 は T3 の後に着手できるが、**いずれも `cursor-default.test.ts` に触れうるため
順に行う**（T5 は T4 にも依存させ、同一ファイルへの並行編集を避ける）。
T6 は依存が無く、いつ着手してもよい（実質は確認のみ）。

## リスク / 留意点

- **design.md の既知のトレードオフ**: 新しい分岐は PageUp/PageDown という AID キー種別にのみ
  作用するが、SEU 以外のホストプログラムが同キーで境界挙動を出す場合の回帰は実機で未検証
  （`research.md`「実現性/リスク」、`decisions.md` D2）。**この確認は T4 の対象に含める**
  （T4 は、指定の3ファイルを実行する前に `packages/tn5250/test/` と `packages/web-ui/test/` を
  `PageUp`/`PageDown` で横断検索し、他に影響しうる既存テストが無いか確認する）。
- Rule1（`movedToDeadZone`）は `cursorAddr !== cursorBefore` を必ず条件に含める
  （`design.md`「振る舞いの詳細」）。ここを落とすと `PR#387`（AC6）の退避ロジックと重なり、
  回帰する。T3 実装時に最も注意すべき1点。
- 画面内容比較ヘルパー（T2）は `isPageKey` のときだけ呼ぶ（design.md のエラー処理/異常系）。
  他の全 AID キー応答での追加コストをゼロに保つ。

## テスト方針

- 自動テストは**すべて実機接続なし**で完結させる（`packages/tn5250/test/cursor-default.test.ts` /
  `cursor-stale-on-protected.test.ts` と同じパターン——手作りの WTD バイト列を
  `applyDataStream` / `Session5250` に流し込む合成テスト）。
- 実機診断スクリプト（`scripts/diag-seu-page-cursor*.mjs`, `scripts/diag-seu-topboundary.mjs`）は
  自動テストには使わない（実機接続が前提のため CI では実行できない）。開発中の目視確認・
  回帰調査用の手動ツールとして残す。
- AC1, AC2, AC8: `Session5250` レベルの統合テスト（1画面目 WTD で本文行にカーソル →
  PageDown/PageUp 送信 → 2画面目 WTD を Rule1・Rule2 それぞれのパターン（境界到達）で用意し、
  `session.snapshot().cursor` が送信前の位置に維持されることを確認）。このテストの追加自体が
  AC8 の充足でもある。
- AC3: 上記と同じテストファイル内に、非境界（途中ページ）遷移のケースを1つ加え、
  ホストの IC がそのまま適用されて正しく維持される（新しい分岐が発火しない）ことを確認する。
- AC5〜AC7: 既存テストをそのまま実行し green を維持することで確認する（新しい分岐が
  `isPageKey` で排他されているため、コード変更なしで通るはずだが、実際に実行して確認する）。

## タスク

- [x] T1: `Session5250` に直前送信 AID キーを保持する非公開フィールド `lastSentAid` を追加し、
      `sendAid()` 内でレコード送信時に更新する。
      対象: `packages/tn5250/src/session/session.ts:130`（フィールド宣言付近）,
            `packages/tn5250/src/session/session.ts:322-386`（`sendAid()`） / 根拠: design.md「インターフェース / データ構造」
      依存: なし
      AC: なし
- [x] T2: 画面内容が2時点間で完全に一致するかを軽量に判定するヘルパーを追加する
      （`isPageKey` のときだけ呼ばれる想定。新しい公開 API は増やさない）。
      対象: `packages/tn5250/src/session/session.ts`（private ヘルパーとして追加が第一候補）、
            または `packages/tn5250/src/screen/buffer.ts:834-841` 付近（`cursorIsUnenterable()` の
            隣に置く案）。どちらにするかは既存コードの構造を見て coding 時に決定する。
            / 根拠: design.md「対象範囲」「振る舞いの詳細」
      依存: なし
      AC: なし
- [x] T3: `handleRecord()` のカーソル確定ロジック（既存の613-616, 617-634分岐）の手前に、
      `lastSentAid` が PageUp/PageDown のときだけ効く新しい分岐を追加する。
      Rule1（`result.cursorSet` かつ `cursorAddr !== cursorBefore` かつ
      `cursorIsUnenterable()`）または Rule2（画面内容が送信前後で完全一致）のいずれかが
      成立すれば `this.buf.cursorAddr = cursorBefore` とする。既存の2分岐はコードを変更しない。
      対象: `packages/tn5250/src/session/session.ts:613-634` / 根拠: design.md「振る舞いの詳細」
      依存: T1, T2
      AC: なし
      （撤去済み。当初は AC1, AC2, AC3 だったが、AC1/AC2 は `decisions.md` D7 により撤去済み。
      AC3 は本タスクの実装が無くても——ホストの IC/MC をそのまま信用する元の2分岐に
      戻したことで——満たされる）
      実施結果（coding 中に追加した条件。design.md「coding 中に判明した追加条件」参照）:
      Rule1・Rule2 共通で `cursorBeforeWasEnterable`（送信前カーソルが入力可能だったか）
      も条件に加えた。無いと Rule2 単独でも `PR#387`（AC6）と重なりうる欠陥があったため
      （タスク単位の独立点検の must 指摘）。
      **T8（`decisions.md` D7）でこの分岐自体を撤去した**——ACS のコア実装
      （`DS5250`/`PS5250`）に相当する専用ロジックが見当たらなかったため。
- [x] T4: `packages/tn5250/test/` と `packages/web-ui/test/` を `PageUp`/`PageDown` で
      横断検索し、T3 の新しい分岐が影響しうる既存テストが他に無いか確認する
      （リスク/留意点 参照）。そのうえで、既存の回帰シナリオ（F1ヘルプ/27x132切替の
      カーソル既定移動、保護欄からの退避 `PR#387`、SEU 走査検索でのカーソル復元）に対する
      既存テストを実行し、T3 の変更後も green のままであることを確認する。新しい分岐との
      重なりが疑わしい箇所があれば、念のためのケースを追記する。
      対象: `packages/tn5250/test/cursor-default.test.ts`,
            `packages/tn5250/test/cursor-stale-on-protected.test.ts`,
            `packages/web-ui/test/screen-grid-cursor-restore.test.ts`
            （横断検索は `packages/tn5250/test/`, `packages/web-ui/test/` 全体） / 根拠: design.md「受け入れ基準との対応」AC5-7
      依存: T3
      AC: AC5, AC6, AC7
- [x] T5: PageUp/PageDown で境界ページ（先頭/最終）に到達したときカーソル位置が維持される
      ことを検証する新規テストを追加する（Rule1 相当・Rule2 相当それぞれの合成 WTD ケース。
      AC1=PageDownで最終ページ、AC2=PageUpで先頭ページ。このテスト自体がAC8を満たす）。
      あわせて、途中ページ（非境界）遷移で新しい分岐が発火せず、既存の維持動作に
      回帰が無いことを確認するケースを1つ加える（AC3）。
      対象: `packages/tn5250/test/`（新規ファイル、または `cursor-default.test.ts` への追加。
            ファイル名は coding 時に決定） / 根拠: design.md「受け入れ基準との対応」AC1, AC2, AC3, AC8
      依存: T3, T4
      AC: なし
      （撤去済み。当初は AC1, AC2, AC3, AC8 だったが、AC1/AC2/AC8 は `decisions.md` D7 により
      撤去済み。AC3 は本タスクが追加したテストが無くても既存の2分岐で満たされる）
      **T8（`decisions.md` D7）でこのタスクが追加したテストファイル
      （`cursor-page-boundary.test.ts`）自体を削除した**（Rule1/Rule2 撤去に伴い検証対象が
      消滅したため）。
- [x] T6: AC4（境界ページ到達時のホスト応答を実機トレースで確認し記録が残っている）は
      `research.md` で既に充足済みであることを確認する。coding での新規作業は発生しない。
      対象: `.aidev/works/20260914-seu-page-cursor-hold/research.md` / 根拠: research.md F1-F6
      依存: なし
      AC: AC4
- [x] T7（deliver 後、利用者報告を受けて追加）: `sendAid()` が `opts.cursor` を受け取った時点で
      `buf.cursorAddr` をそれに同期する。web-ui のクリックでカーソルを移してから
      PageUp/PageDown した場合、`cursorBefore`（`buf.cursorAddr`）が古い位置のままで
      新分岐が無関係な位置へ復元してしまう回帰を直す（`decisions.md` D5）。
      対象: `packages/tn5250/src/session/session.ts:339-361`（`sendAid()`） / 根拠: decisions.md D5, research.md「実装時の注意」
      依存: なし
      AC: AC9
      （当初は AC1, AC2 の回帰修正として着手したが、AC1/AC2 は `decisions.md` D7 により
      撤去済み。本タスクの成果そのものが新設された AC9 の定義になった）
- [x] T8（Rule1/Rule2 撤去、`decisions.md` D7）: T3 が追加した新分岐（Rule1/Rule2）・T1 の
      `lastSentAid`・T2 の `cellsSignature()` を撤去し、既存の2分岐（`!cursorSet` → 先頭入力欄／
      `cursorAddr === cursorBefore && cursorIsUnenterable()` → 先頭入力欄）のみの元の設計へ戻す。
      ACS（`acsbundle.jar`）のコア実装（`DS5250`/`PS5250`）をデコンパイルして確認したところ、
      ホストの IC/MC より送信前のカーソル位置を優先する専用ロジックに相当するものが
      見当たらなかったため（利用者の明示的な指示）。T5 が追加したテストファイル
      （`cursor-page-boundary.test.ts`）と T2 のテスト（`cells-signature.test.ts`）を削除し、
      T7（AC9）の回帰テストのみを `sendaid-cursor-sync.test.ts` として独立させる。
      対象: `packages/tn5250/src/session/session.ts:341-346,532-664`（削除対象の分岐一式）,
            `packages/tn5250/src/screen/buffer.ts`（`cellsSignature()` の削除）,
            `packages/tn5250/test/cursor-page-boundary.test.ts`（削除）,
            `packages/tn5250/test/cells-signature.test.ts`（削除）,
            `packages/tn5250/test/sendaid-cursor-sync.test.ts`（新規） / 根拠: decisions.md D6, D7
      依存: T3, T5, T7
      AC: AC3
      （本タスクの撤去そのものが新たな AC を満たすわけではないが、AC3——途中ページでの
      既存の正しい挙動に回帰が無いこと——は、Rule1/Rule2 という新ルールを一切持たない
      元の2分岐に戻すことで保たれる。design.md「受け入れ基準との対応」AC3 参照。
      あわせて AC1/AC2/AC8 を `requirements.md` から取り消し
      `.aidev/backlog/acs-parity.md` へ引き継ぐ前提作業でもある）
