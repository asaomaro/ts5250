# 仕様: DSPFMT でフィールドのオプション入力欄の下線が消えたり、罫線のみ表示される不具合の調査・修正

## 概要

`research.md`（F7）で確認した「WEA（Write Extended Attribute, `ORDER.WEA = 0x12`）が
未実装のため、WTD 内に現れると同じ WTD 内の以降の全オーダーが丸ごと読み飛ばされる」という
確実に存在するプロトコル上の欠陥を修正する。`packages/tn5250/src/protocol/wtd-applier.ts` の
オーダー switch に `ORDER.WEA` 専用の `case` を追加し、その本体（2バイト）だけを正しく
読み飛ばして処理を継続する。意味的な効果（拡張属性の実際の見た目への反映）は実装しない
（2つの独立した参照実装 tn5250j・GNU tn5250 も同様に実装を見送っている）。

## 設計方針

代替案として「WEA の意味的な効果まで実装する」も検討したが、`research.md` F7 の通り
IBM の正式仕様書（SC30-3533）の該当箇所をこの work では直接参照できておらず、
成熟した参照実装2つがどちらも実装を見送っている以上、憶測で実装すると誤った見た目を
作り込むリスクの方が大きい。**「未実装のまま安全に読み飛ばす」**という、2つの参照実装と
同じ現実的なスコープに揃える。

これにより解消するのは「WEA が現れると、それより後ろのオーダーが失われる」という
**確実なバグ**であって、利用者が報告した具体的な症状（DSPFMT のオプション欄の下線消失）を
解消するという確証は無い（`research.md`「実現性/リスク」）。この点は `decisions.md` D1 に
明記済み。

## 対象範囲

- `packages/tn5250/src/protocol/wtd-applier.ts`: オーダー switch に `ORDER.WEA` の
  `case` を追加する。
- `packages/tn5250/test/`: 新規テストファイル（または既存の `wtd-applier.test.ts` への
  追加。ファイル名は tasks で決定）を追加し、AC6 が求める「合成 WTD に WEA オーダーを
  含め、その後ろのオーダーが正しく適用されることを確認する」回帰テストを実装する。
- 対象外（変更しない）: `ORDER.WEA` 定数自体（`constants.ts:97` に既存）、
  `packages/web-ui` 側の描画ロジック（今回は「読み飛ばしを直す」だけで、拡張属性を
  実際に描画へ反映する機能は追加しない）。

## 依拠する既存の事実

- `ORDER.WEA = 0x12` は `packages/tn5250/src/protocol/constants.ts:97` に既に定義済み
  だが、オーダー switch 側に対応する `case` が無く未使用のままだった
  （確認場所: `wtd-applier.ts` のオーダー switch 全体。`research.md` F7）。
- 未知オーダーの `default:` 節（`wtd-applier.ts:488-509`）は、次の ESC＋既知コマンドが
  見つかるまで読み飛ばす復旧処理——これに落ちると WEA より後ろの同一 WTD 内の
  全オーダーが失われる（`research.md` F7）。
- WEA のオーダー本体は2バイト（属性タイプ・属性値）——tn5250j（`tnvt.java`）・
  GNU tn5250（`lib5250/session.c` `tn5250_session_write_extended_attribute()`）の
  2つの独立した参照実装で確認済み。どちらも実際の属性適用は実装していない
  （`research.md` F7）。確認場所: 各リポジトリの該当ソース（`research.md` F7 の出典参照）。
- 同じ switch 文内の類似パターン（`ORDER.EA` の不正長チェック、`ORDER.UNKNOWN_1C` の
  専用ケース）が、オーダー本体を正確に消費してから `break` する書き方の前例になる。
  確認場所: `wtd-applier.ts:435-450`（EA）、`wtd-applier.ts:479-486`（UNKNOWN_1C）。

## インターフェース / データ構造

新しい公開 API・型は追加しない。`wtd-applier.ts` 内部の switch 文に1ケースを足すのみ。

```ts
// packages/tn5250/src/protocol/wtd-applier.ts のオーダー switch 内、
// ORDER.WDSF の case と ORDER.UNKNOWN_1C の case の間に追加する想定
case ORDER.WEA: {
  const attrType = r.u8();
  const attrValue = r.u8();
  warn(`WEA order (type=0x${attrType.toString(16)}, value=0x${attrValue.toString(16)}) received — not applied`);
  break;
}
```

## 振る舞いの詳細

- WEA オーダーを受信すると、属性タイプ・属性値の2バイトを読み進めるだけで、
  画面の見た目には一切反映しない（`buf` への書き込みを行わない）。
- `warn()` を1回呼ぶ（受信した生の値つき）。目的は診断——利用者の実機で WEA が
  実際に使われているかどうかを、今後 `traceRecords: true` を使った実機診断
  （`scripts/diag-dspfmt-underline.mjs` 等）で確認できるようにする
  （`research.md`「design への申し送り」、AC6）。
- WEA オーダーの**後ろ**にある同じ WTD 内の全てのオーダー（フィールド定義・属性設定・
  文字データ等）は、修正前は `default:` 節に落ちて丸ごと読み飛ばされていたが、
  修正後は正しく処理される。

## ドメイン固有の考慮

- 該当なし（5250 プロトコルの標準オーダーの1つを正しく消費するだけで、
  SEU 等の特定プログラムに依存した判定は行わない）。

## エラー処理 / 異常系

- `r.u8()` は残りバイトが無ければ `PROTOCOL_ERROR` を投げる（既存の `ByteReader` の
  標準動作。WEA 専用の特別なエラー処理は追加しない——他のオーダーと同じ扱いにする）。

## 受け入れ基準との対応

- ~~AC1~~ / ~~AC2~~: **撤去（`decisions.md` D1）**。目標は `.aidev/backlog/acs-parity.md` へ
  引き継ぐ。
- AC3: `research.md` F5・F6 に、実機トレースで試した具体的な条件（WRKOBJPDM の Opt 欄、
  F1 ヘルプ窓の開閉、PageDown＝F5／DDS コンパイルでの全色 CS 検証＝F6）と結果
  （再現せず／DDS コンパイルは通ったが実行時確認はできず）が記録済み。
  次の調査の手掛かり（`QRPGLESRC` の整備、利用者の実機での直接確認）は
  `research.md`「実現性/リスク」に記録済み。
- AC4: 修正方針は `research.md` F7（コードの読解＋2つの参照実装との突き合わせ）に
  基づいており、推測のみに基づく修正ではない。
- AC5: この修正は `ORDER.WEA` という**新しいケースを追加するだけ**で、既存の
  `ORDER.SF`/`ORDER.WDSF`/`ORDER.EA`/`ORDER.UNKNOWN_1C`/`default:` の各ケースには
  一切触れない（上記「対象範囲」）。既存の属性描画テスト（DSPATR(CS)
  `screen-grid-colsep.test.ts`、下線 `grid-input-underline.test.ts`／
  `field-attr-bound.test.ts`／`screen-buffer-attr-bounds.test.ts`、埋め込み属性
  `screen-grid-embedded-attr.test.ts`、グリッド罫線 `wdsf-grid-border.test.ts`／
  `screen-grid-gridlines.test.ts`、EDTMSK 継続欄 `continued-field-attr.test.ts`。
  いずれも `requirements.md` AC5 に列挙済み）が入力として使う合成 WTD は、
  これらのテストファイル自身が明示的に組み立てたバイト列であり、`ORDER.WEA`（0x12）を
  含めていない（各テストファイルのテスト対象オーダーの記述による。coding 時に
  実際にテストを実行して green のままであることを確認する）。
- AC6: WEA が実際に使われているかは実機トレースでは確認できなかった
  （`research.md` F5——WRKOBJPDM・F1ヘルプ窓のシナリオでは一度も出現しなかった）。
  一方、**使われた場合に確実に発生していた欠陥**（WEA 以降の全オーダー消失）を修正し、
  自動テスト（合成 WTD に WEA オーダーを含め、その後ろのオーダーが正しく適用されることを
  確認する）でこれを固定化する。
