# 調査: 長さの足りないコマンドと否定応答

## 調査の問い
- Q1: ACS の長さの検査の条件（原典）
- Q2: 実機での ACS のコアと当 PJ の振る舞い

## 判明した事実
- F1（Q1・原典 `DS5250.processCommand`）: WTD（`n5 + 2 > n2`）・READ 0x42/0x52/0x82（同じ）・ROLL（`n5 + 2 >= n2`＝3 バイト要る）・WRITE ERROR CODE 0x21/0x22（`n5 >= n2`＝1 バイトも無い）で 0x10050121 を立てて `return`（尾部の CC2 を飛ばす）。
  CLEAR UNIT ALTERNATE は `n5 > n2` で否定応答なしに戻る（引数が無いちょうどの長さでは読み進める）。
- F2（Q2・実測。2026-09-27・社内機）: DSM（`scripts/host-src/dscmd.c` の SHORTWTD / SHORTREAD / SHORTROLL / SHORTWEC）で「WTD（CC2＝メッセージ待ち・5 行に SHORT）＋長さの足りないコマンド」を 1 レコードで出させた（DSM は短いコマンドをそのまま通す。rc=0）。
  **ACS のコア: 5 通り（SHORTWECW を含む。下の追記）とも 5 行目に SHORT・mw=false・DSM の次の出力は CPFA303**（否定応答を受けた印。dscmd.log で 5 通りとも確かめた——WTD・READ・ROLL は review ラウンド 1 の指摘で測り足した）。
  **当 PJ（直す前。SHORTWECW 以外の 4 通り）**: SHORTWTD / SHORTREAD / SHORTROLL は `record parse error: unexpected end of record`（例外）で否定応答なし。SHORTWEC は否定応答なし・mw=true（CC2 が効いた）。
  続けて流すと 2 本目以降の CALL が効かない（ACS のコアでも当 PJ でも）——モードごとに繋ぎ直して測った。
  **SHORTWECW（0x22 の 0 バイト）も**同じく ACS のコアは SHORT・mw=false・次の出力が CPFA303（T3 の点検の指摘で足した）。
- F3（Q2・実測。直した後）: 当 PJ も 5 通りとも SHORT・mw=false・否定応答 0x10050121（`scripts/verify-short-command-sense.mjs`。4 通りで pass=12、SHORTWECW で pass=3）。

## 影響範囲
- `packages/tn5250/src/protocol/wtd-applier.ts` の WTD・READ・ROLL・WRITE ERROR CODE（0x21/0x22）の入口

## 実現性 / リスク
- 0x22 の 0 バイトは `20260926-wec-msgline-row` D4 で「0x21 と同じ位置」として受けていた——否定応答に変わる（ACS と同じ）。桁の片方だけ欠けた 0x22 は D4 のまま。

## 実装アンカー
- A1: `applyDataStream` の主ループ（`wtd-applier.ts`）・`abortRecord`

## design への申し送り
- CLEAR UNIT ALTERNATE の引数なしは backlog に残す。
