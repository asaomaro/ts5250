# 仕様: ACS のコア実装（DS5250/PS5250）と突き合わせた5250プロトコル処理の棚卸し（第1弾）

## 概要

`research.md` F4 で確認した「WTD 中のバイト値 0x1E が、ACS と同様に扱われず
`default:`（未知オーダー扱い）に落ち、以降の同一 WTD 内の全オーダーが失われる」
という欠陥を修正する。既存の `ORDER.UNKNOWN_1C`（0x1C）と対称的な専用 `case` を
`wtd-applier.ts` のオーダー switch に追加し、0x1E を文字 `;`（セミコロン）へ
置換して表示する。あわせて、`ORDER.UNKNOWN_1C` の doc コメントを、
`research.md` F2・F3 で判明した事実（0x1C/0x1E は「オーダー」ではなく、ACS の
`PS5250.addChar()` が行う表示データの文字置換）に基づいて更新する。

## 設計方針

代替案として「`ORDER` オブジェクトから 0x1C/0x1E を切り離し、新しい
`CHAR_SUBSTITUTE` のような専用の定数群・処理経路（main loop 内、オーダー switch
より前の「表示データ」判定チェーンに統合する）へ作り替える」も検討した。
これは `research.md` F2・F3 が明らかにした「実際はオーダーではなく表示データの
文字置換」という実態により忠実な設計になる。しかし:

- `ORDER.UNKNOWN_1C` は既存の公開定数であり、これを削除・移動すると
  `constants.ts` を参照する他のコードへの影響範囲を洗い出す必要が生じる
  （`requirements.md`「非機能要件」: 破壊的変更を避ける）。
- 0x1C の既存実装（オーダー switch の1ケースとして扱う）は、実機シナリオ
  （`WRKOBJPDM`/`DSPSPLF` 系、`research.md` F6）で既に検証済みの実績があり、
  触ると新たな回帰リスクを持ち込む。

そのため、**既存の `ORDER.UNKNOWN_1C` の構造・位置づけには手を加えず**、
0x1E にも同じ「オーダー switch の1ケースとして扱う」パターンをそのまま
適用する対称的な追加に留める。アーキテクチャ上のより正確な再設計（表示データの
文字置換として `ORDER` の外に出す）は、この work のスコープでは行わず、
コメントで「実態は表示データの文字置換だが、既存の実装との一貫性のため
オーダー switch の枠組みのまま扱っている」ことを明記するに留める
（`decisions.md` に記録する）。

## 対象範囲

- `packages/tn5250/src/protocol/constants.ts`: 0x1E 用の定数を `ORDER` オブジェクトに
  追加する（`UNKNOWN_1C` と対称的な命名）。`UNKNOWN_1C` の doc コメントを更新する。
- `packages/tn5250/src/protocol/wtd-applier.ts`: オーダー switch に 0x1E 用の
  `case` を追加する（`ORDER.UNKNOWN_1C` の既存 `case` と対称的な実装）。
- `packages/tn5250/test/wtd-applier.test.ts`: 新規回帰テスト（0x1E が `;` へ
  正しく置換されること、後続オーダーを失わないこと）を追加する。既存の
  「未知オーダーの後、SBA のパラメータを ESC と読み違えない」テスト
  （404〜415行）が 0x1E を「未知オーダー」の例として使っているため、
  別の未使用バイト値（0x16）へ差し替える（`research.md`「影響範囲」）。
- 対象外（変更しない）: `default:` 節の設計そのもの（ACS 式への全面的な作り替え。
  `research.md`「実現性/リスク」）、`ORDER.UNKNOWN_1C` の実装・位置づけの
  アーキテクチャ的な作り替え（コメント更新のみに留める）。

## 依拠する既存の事実

- ACS のオーダー switch と `wtd-applier.ts` の対応が1:1で一致すること
  （`research.md` F1）。
- ACS が未知バイト値を表示データとして扱い、0x1C→`*`・0x1E→`;` の特殊な
  文字置換を行うこと（`research.md` F2, F3。デコンパイル済みソースの直接引用）。
- 独立した参照実装（tn5250j）にはこの置換が無く、ACS 固有の実装上の癖である
  可能性が高いこと（`research.md` F5）。
- `wtd-applier.ts` の既存の `ORDER.UNKNOWN_1C` 実装（`buf.setChar(addr++, "*")`、
  rawByte を渡さない設計）。確認場所: `wtd-applier.ts` の
  `case ORDER.UNKNOWN_1C:` 節（`research.md` F4）。

## インターフェース / データ構造

新しい公開 API は追加しない。`constants.ts` の `ORDER` オブジェクトに1エントリを
追加するのみ（既存エントリの**値**の変更・削除は無い——`UNKNOWN_1C: 0x1c` の値は
そのまま。doc コメントの更新はある。下記コード例・「振る舞いの詳細」参照）。

```ts
// packages/tn5250/src/protocol/constants.ts の ORDER オブジェクトに追加
export const ORDER = {
  // ...既存のエントリ...
  UNKNOWN_1C: 0x1c, // 既存（doc コメントを更新）
  UNKNOWN_1E: 0x1e, // 新規。ACS の PS5250.addChar() が「;」へ置換する文字（research.md F3）
  SF: 0x1d
} as const;
```

```ts
// packages/tn5250/src/protocol/wtd-applier.ts のオーダー switch 内、
// ORDER.UNKNOWN_1C の case の直後に追加する想定
case ORDER.UNKNOWN_1E:
  // 表示は ";" 1 文字（桁を 1 つ占有）。ORDER.UNKNOWN_1C と対称的な扱い。
  // 詳細は ORDER.UNKNOWN_1C / ORDER.UNKNOWN_1E の doc コメント参照。
  buf.setChar(addr++, ";");
  break;
```

## 振る舞いの詳細

- WTD 中にバイト値 0x1E（30）が現れると、1桁を占有する文字 `;`（セミコロン）
  として画面へ書き込む。`rawByte` は渡さない——既存の `ORDER.UNKNOWN_1C` の
  実装コメント（`research.md` F4 が確認場所として引用する
  `wtd-applier.ts` の `case ORDER.UNKNOWN_1C:` 節）が記す理由（カタカナ表示
  モードが生バイトを再解釈して文字化けする）をそのまま踏襲する。
- 0x1E の**後ろ**にある同じ WTD 内の全てのオーダー（フィールド定義・属性設定・
  文字データ等）は、修正前は `default:` 節に落ちて丸ごと失われていたが、
  修正後は正しく処理される。これは `20260914-dspfmt-field-underline-instability`
  で WEA（`ORDER.WEA`、拡張属性オーダー）に対して行った修正と同じ効果・同じ
  構造の欠陥修正である（`research.md` F4「WEA と同じ構造の欠陥」）。
- `ORDER.UNKNOWN_1C` の doc コメントを、以下の内容で更新する:
  - 従来の「正体未確認・要再確認」という記述を削除する。
  - ACS のデコンパイル済みソース（`PS5250.addChar()`）で、この文字が
    「オーダー」ではなく「表示データ書き込み時の特殊な文字置換」であることが
    判明した旨を記録する（`research.md` F2, F3 への参照を添える）。
  - 同じ置換機構の対（0x1E→`;`、`ORDER.UNKNOWN_1E`）が存在することを記録する。

## ドメイン固有の考慮

- 該当なし（ACS 固有の実装上の癖を再現するものであり、SEU 等の特定プログラムへの
  依存は無い）。

## エラー処理 / 異常系

- 該当なし。`ORDER.UNKNOWN_1C` と同様、1バイトを消費して1文字を書き込むだけの
  単純な処理であり、新たな異常系は発生しない。

## 受け入れ基準との対応

- AC1: 0x1E が `default:` 節に落ちず、`;` へ置換されて表示されることを
  `wtd-applier.test.ts` の新規回帰テストで確認する（「対象範囲」参照）。
  修正前のコードでこのテストが実際に失敗すること（discrimination）を
  coding 時に確認する。
- AC2: `ORDER.UNKNOWN_1C` の doc コメントを、`research.md` F2・F3 の事実に
  基づいて更新する（「振る舞いの詳細」参照）。「正体未確認・要再確認」という
  記述を、確認済みの事実（ACS の文字置換であること）に置き換える。
- AC3: `research.md`「判明した事実」F1（ACS のオーダー switch と `wtd-applier.ts`
  の対応関係の一覧）に記録済み。
- AC4: この design の全ての判断は `research.md` の F1〜F6（ACS のデコンパイル
  済みソースコードの直接引用、および tn5250j という独立した参照実装との
  突き合わせ）に基づく。推測に基づく判断は無い。
- AC5: 既存の `ORDER.UNKNOWN_1C` 関連テスト・実機 fixture を使うテスト
  （`pub400-signon.jsonl` 等）は、この修正が新しい `case` を1つ追加するだけで
  既存の `case` に触れないため、無関係のまま green を維持する見込み。
  「未知オーダーの後、SBA のパラメータを ESC と読み違えない」テスト
  （404〜415行）は 0x1E を別のバイト値（0x16）へ差し替えたうえで、
  同じ検証内容（ESC 誤認識の回避）を維持する。
