# タスク: ACS のコア実装（DS5250/PS5250）と突き合わせた5250プロトコル処理の棚卸し（第1弾）

## 実装方針

`design.md` の通り、`constants.ts` に `ORDER.UNKNOWN_1E` を追加し（T1）、
`wtd-applier.ts` のオーダー switch に対応する `case` を追加する（T2）。
`ORDER.UNKNOWN_1C` の doc コメントを研究結果に基づいて更新する（T1 に含める、
同じファイル・同じ定数群のため）。既存テストの 0x1E 使用箇所を差し替えつつ（T3）、
新規回帰テストを追加する（T4）。AC3（ACS のオーダー switch と `wtd-applier.ts`
の対応関係の一覧）は `research.md` F1 で既に充足済みのため、T5 はその確認のみで
新規実装を伴わない。分割は行わない（1ファイル1ケース+テストという
小規模なスコープのため）。

## 作業順序と依存関係

下の `依存:` に従う。**独立した起点が2つ**ある: T1（定数追加、T2〜T4 の実装連鎖の
起点）と T5（`research.md` の確認のみ、他のどのタスクとも独立して並行着手可能）。
T2（switch への case 追加）は T1 に依存。T3（既存テストの差し替え）と T4
（新規回帰テスト追加）は T2 の後に着手する（同じテストファイルを触るため直列に
行う——T3 を先に済ませてから T4 で新規ケースを追加する）。

## リスク / 留意点

- `research.md`「影響範囲」の通り、既存テスト `wtd-applier.test.ts` の
  「未知オーダーの後、SBA のパラメータを ESC と読み違えない」テスト
  （404〜415行）が 0x1E を使っている。T3 でこれを 0x16 へ差し替える際、
  テストの意図（ESC 誤認識の回避の検証）自体は変えないよう注意する。
- `design.md`「設計方針」の通り、`ORDER.UNKNOWN_1C` の実装構造自体
  （オーダー switch の1ケースとして扱う設計）には手を加えない。
  doc コメントの更新のみに留める。

## テスト方針

- 自動テストは実機接続なしで完結させる（既存の `wtd-applier.test.ts` と
  同じパターン——手作りの WTD バイト列を `applyDataStream` に流し込む合成テスト）。
- T3: 既存の「未知オーダーの後、SBA のパラメータを ESC と読み違えない」テストの
  0x1E を 0x16 に差し替え、テスト自体の green を確認する。
- T4: 0x1E を含む合成 WTD で、(a) `;` へ正しく置換されること、(b) 0x1E の
  **後ろ**にあるオーダー（SF 等）が正しく適用されること（修正前は失われていた
  部分）、の2点を確認する回帰テストを追加する。修正前のコードに対して
  実際に失敗すること（discrimination）を `git stash` 等で確認する。

## タスク

- [x] T1: `constants.ts` の `ORDER` オブジェクトに `UNKNOWN_1E: 0x1e` を追加し、
      `UNKNOWN_1C` の doc コメントを `research.md` F2・F3 の事実に基づいて
      更新する（「正体未確認・要再確認」の記述を削除し、ACS の文字置換である
      ことと、対の `UNKNOWN_1E` の存在を明記する）。
      対象: `packages/tn5250/src/protocol/constants.ts`（`ORDER.UNKNOWN_1C` 定数
      付近） / 根拠: design.md「インターフェース / データ構造」「振る舞いの詳細」
      依存: なし
      AC: AC2
- [x] T2: `wtd-applier.ts` のオーダー switch に `ORDER.UNKNOWN_1E` の `case` を
      追加する（`ORDER.UNKNOWN_1C` の既存 case と対称的な実装。`;` へ置換、
      rawByte は渡さない）。
      対象: `packages/tn5250/src/protocol/wtd-applier.ts`
      （`case ORDER.UNKNOWN_1C:` の直後） / 根拠: design.md「インターフェース / データ構造」
      依存: T1
      AC: AC1, AC4
- [x] T3: 既存テスト「未知オーダーの後、SBA のパラメータを ESC と読み違えない」
      （`wtd-applier.test.ts:404-415`）の 0x1E を 0x16 に差し替える。
      対象: `packages/tn5250/test/wtd-applier.test.ts:404-415` / 根拠: research.md「影響範囲」, design.md「対象範囲」
      依存: T2
      AC: AC5
- [x] T4: 0x1E の回帰テスト（`;` への置換、後続オーダーの保持）を追加する。
      実施結果: `wtd-applier.test.ts`「SF がフィールドを登録し、後続データが
      初期値になる」テストの直後に追加した（`ORDER.WEA` の回帰テストは main
      ブランチにまだマージされていない別 work・PR #397 側にあるため、それに
      代えてこの位置にした）。修正前のコードに対して実際に失敗すること
      （discrimination）を `git stash` で一時的に確認済み。
      対象: `packages/tn5250/test/wtd-applier.test.ts`（新規ケース） / 根拠: design.md「受け入れ基準との対応」AC1
      依存: T3
      AC: AC1
- [x] T5: AC3（ACS のオーダー switch と `wtd-applier.ts` の対応関係の一覧）は
      `research.md` F1 で既に充足済みであることを確認する。coding での
      新規作業は発生しない。
      対象: `.aidev/works/20260915-acs-protocol-order-audit/research.md` / 根拠: research.md F1
      依存: なし
      AC: AC3
