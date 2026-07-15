# レビュー記録（01-core-sbcs）

## ラウンド 1（2026-07-15）

原典（GNU tn5250 lib5250: session.c / display.c、SC30-3533-04）と照合しての単独レビュー。

- [must] `packages/core/src/protocol/wtd-applier.ts` EA（Erase to Address）オーダーのパース誤り /
  対応: 差し戻し・修正
  - **内容**: EA オーダーを `行 桁` の 2 バイトのみ読んでいるが、正しくは `行 桁 length [属性タイプ×(length-1)]`
    （length=2〜5）。tn5250 `erase_to_address` は length バイトと属性バイト群を消費する。実データに EA を含む画面が
    来ると、length 以降のバイトを誤ってオーダー/文字として解釈し、**そのレコードの以降のパースが全崩れ**する。
    現行の実機 trace（サインオン/メニュー）は EA 不使用のため露見しなかったが、EA を使う画面（領域クリア）で顕在化。
  - **原典照合**: tn5250 `erase_to_address` は y,x,length を読み (length-1) 属性バイトをスキップ。消去範囲は
    `erase_region` により target を**含む**（`j < endcol` で 0-based target まで）＝現行の inclusive と一致。
    再開アドレスは tn5250 が target に設定（現行は target+1）。
  - **修正**: length バイトと (length-1) 個の属性バイトを読み飛ばす。再開アドレスは tn5250 に合わせ target とする。

- [nit] `packages/core/src/session/session.ts` `ConnectOptions.screenSize` は現状 "24x80" 固定で未使用
  （subtask 04 の 27x132 で活用予定）/ 対応: 許容（プレースホルダとして意図的）。
- [nit] SOH / TD / RA / SF の各オーダー長は原典と一致（SOH=len+本体、TD=u16 len+本体、RA=行桁+fill 1、
  SF=FFW+FCW*+attr+len）。問題なし。

判定: must 1 件 → coding へ差し戻し。

## ラウンド 2（2026-07-15・差し戻し後の再レビュー）

- [must] EA パース誤り → **修正済み**。`wtd-applier.ts` が EA の length（2〜5 検証）と (length-1) 属性バイトを
  読み飛ばすよう修正。再開アドレスを target に変更（tn5250 一致）。不正 length は警告してレコード打ち切り。
  回帰テスト 2 件追加（属性バイト読み飛ばし・不正 length）。全 83 テスト合格、実機自動サインオン→メニュー維持。
- must/should なし。nit（screenSize プレースホルダ）は許容。

判定: 指摘解消。review 通過。

