# レビュー記録: 02-datastream-inbound

## ラウンド 1（2026-08-15T09:49:58Z）

差分: `packages/tn3270/src/` に 5 ファイル追加（`protocol/constants.ts` / `protocol/address.ts` /
`protocol/inbound.ts` / `screen/types.ts` / `screen/attributes.ts` / `screen/buffer.ts` /
`screen/snapshot.ts`）、テスト 3 本と検証ハーネス 2 本、fixture 1 本。

### 実測で確定させたこと（推測で書いていない）

親 plan の最上位リスクが「属性ビットの割り当てが未確定。推測で進めない」だったので、
`s3270` の `-trace` が受信ストリームを**意味へ復号する**性質を使って総当たりで確定させた。
採取したトレースは `artifacts/` に保存（`attr.trc` / `order.trc` / `wcc3.trc` / `color2.trc`）。

- **フィールド属性**: 0x01=MDT / 0x04=detectable / 0x08=intensified / 0x0C=nondisplay /
  0x10=numeric / 0x20=protected。**0x02・0x40・0x80 は無意味**（実測で `default` と復号）。
  **保護＋数字＝自動スキップ**（0xF0 が `protected,skip` と復号された）。
- **オーダー**: 11=SBA / 1D=SF / 13=IC / 29=SFE / 28=SA / 3C=RA / 12=EUA / 08=GE / 05=PT / 2C=MF。
- **WCC**: 01=resetMDT / 02=restore / 04=alarm / 40=reset。08・10・20・80 は表示端末では無視。
- **色**: F0=neutralBlack / F1=blue / F2=red / F3=pink / F4=green / F5=turquoise / F6=yellow /
  F7=neutralWhite。**F0 は「既定」ではなく黒**（指定なしは 0x00）。
- **ハイライト**: F0=normal / F1=blink / F2=reverse / **F3=未定義** / F4=underscore。

> 初稿では色とハイライトの一部を標準知識で埋めていた。AGENTS.md の「原典を先に確認する・
> 推測で書き始めない」に反するので**書き直して実測に置き換えた**。F0 が「既定」ではなく
> 「黒」だったこと、F3 が未定義だったことは、推測のままなら誤ったまま残っていた。

### 指摘と対応

- [must] `test/harness/s3270.ts` — **同期呼び出し（`execFileSync`）が in-process の
  `mini3270` を殺す**。照合ハーネスは同じ Node プロセスでサーバを動かすため、同期実行が
  イベントループを止めるとサーバが接続を受け付けられない。「s3270 が 3270 モードに入らない」
  という紛らわしい形で失敗した。
  / 対応: **修正済**。ハーネス全体を非同期（`promisify(execFile)`）に書き換え、
  「in-process サーバと同居する前提なので非同期であることが要件」とコメントに明記した。

- [must] 照合テストが**空画面と比較して緑になりうる**。`waitReady` は `connected-3270` で返るが、
  これは BINARY/EOR の合意で立つのでデータ到着前。実際、自実装は中身を持っているのに
  s3270 側が真っ白のまま比較が走った（このときは属性桁 0 件 vs 156 件で落ちたので露見したが、
  **両方が空なら緑になっていた**）。
  / 対応: **修正済**。`waitForContent()` を足し、本テストでも `expect(refAttrs.length).toBeGreaterThan(0)`
  で空振り検査を入れた。

- [should] **照合方法を plan から変更した**。実ホストへ 2 本繋いで比べる方式は成立しない——
  Hercules は装置ごとに状態を持ち、2 本目の接続には別の画面（または空画面）が返る。実測で確認。
  / 対応: **同じバイトを両方に流す**方式へ変更。そのため `mini3270` ハーネスを subtask 04 から
  前倒しで作った。TK4- から実採取した fixture（`tk4-welcome.jsonl`）を両者に食わせて照合する。
  04 は DBCS のデータストリームを足すだけで済むようになった。

- [should] `snapshot()` のフィールド導出は**属性桁を毎回走査する**（design D8）。
  3,564 桁の線形走査は無視できる費用で、`MF`・`RA`・`EW` が絡む増分更新の
  組み合わせ爆発を構造的に避けられる。**意図どおりで、性能上の懸念は現状なし**
  （照合テストで 24x80 全面を 2 レコード適用しても体感差なし）。

- [nit] `test/inbound.test.ts` のヘルパで三項演算子を文として使っていた（lint が検出）。
  / 対応: **修正済**（if/else へ）。lint は緑。

### 検証

- `npm run build`（`tsc -b` ＋ web-ui の `vue-tsc`）: 緑
- `npm run lint`: 緑
- 単体: tn3270 62 件（E2E 4 件は既定スキップ）
- **照合（`TN3270_E2E=1`）: 66 件すべて緑**。中核は
  **自実装と s3270 の属性桁 156 箇所が完全一致 ＋ 表示テキスト 24 行が完全一致**
- 他パッケージ: base 48 / ebcdic 83 / scs 25 / hostserver 872 / tn5250 451 / server 1176 いずれも緑
- 依存方向テスト: `ebcdic` を依存に足した状態で緑（宣言と実 import の双方向一致）

### 未対応（後段へ送る）

- `WSF`（構造化フィールド）は記録して読み飛ばすだけ。Query Reply の最小応答は 03 以降。
- `GE`（Graphic Escape）は次の 1 文字を普通に置くだけ。拡張文字集合の区別は未実装。
- 拡張属性の背景色・文字セット（`XA.BACKGROUND` / `XA.CHARSET`）は解釈していない（DBCS は 04）。
