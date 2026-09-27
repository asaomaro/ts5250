# 調査: WTD の中のオーダーの誤り

## 調査の問い
- Q1: ACS はどのオーダーの誤りでどのセンスを返すか（原典）
- Q2: 実機で ACS のコアと当 PJ は同じか

## 判明した事実
- F1（Q1・原典 `DS5250.processWriteToDisplay`）: 誤りで `sense_code` を立てて戻る（コマンドのループは条件で抜け、**尾部の CC2 は走る**）。
  SOH: 本体がレコードを越える → 0x10050121、長さ 0 か 8 以上 → 0x1005012B（フォーマットテーブルは変えない）。長さのバイトの検査（`n+1 > n2`）は SOH がレコードの最後のバイトでも通り抜け、ACS はレコードの外を読む——
  「長さのバイトが無い」「本体が 1 バイトだけ足りない」形の ACS の結果は外の値に依存し再現できない（当 PJ は 0x10050121 にする——独自の決め）。
  RA: 3 バイト未満 → 0x121、行・桁が外 → 0x122、後戻り → 0x123。EA: 3 バイト未満・属性タイプがレコードを越える → 0x121、行・桁が外 → 0x122、長さ 2〜5 以外 → 0x12D、後戻り → 0x123。
  SBA・IC・MC: 2 バイト未満 → 0x121、行・桁が外 → 0x122（SBA の行 1・桁 0 だけは番地 -1 として受ける）。TD・SF・WEA: 長さ不足 → 0x121。
- F2（Q2・実測。2026-09-27・社内機）: DSM（`scripts/host-src/dscmd.c` の WTDERRSBA / WTDERRRA / WTDERRSOH / WTDERREA / WTDERRSHORT）で「WTD（CC2＝メッセージ待ち・5 行に WTDERR）＋誤ったオーダー」を 1 モードずつ出させた。
  **ACS のコア: 5 通りとも WTDERR を書き、mw=true（CC2 は効く）、DSM の次の出力が CPFA303**。ワイヤ（`scripts/tap-proxy.mjs` を挟んで 5 通り記録。記録は読み終えて消した）で ACS が返したセンスは
  SBA 0x10050122・RA 0x10050123・SOH 0x1005012B・EA 0x1005012D・SHORT 0x10050121——原典どおり。
  **当 PJ（直す前）**: SBA・RA・SHORT は例外（`record parse error`）で mw=false・否定応答なし。SOH は受けて mw=true・否定応答なし。EA は「残りを捨てる」で mw=true・否定応答なし。
- F3（Q2・実測。直した後）: 当 PJ も 5 通りとも WTDERR・mw=true・同じセンス（`scripts/verify-wtd-order-sense.mjs` pass=15）。

## 影響範囲
- `packages/tn5250/src/protocol/wtd-applier.ts` の `applyWtd`（オーダーの入口）と主ループ（WTD の後）

## 実現性 / リスク
- 「偽の否定応答」の危険（backlog の注意）: 例外を一括で否定応答に変えず、ACS の条件を 1 つずつ写す。SBA の 1,0 は受理側を揃えるまで例外のまま。

## 実装アンカー
- A1: `applyWtd` のオーダーの switch（`wtd-applier.ts`）

## design への申し送り
- SF の中身・WEA の属性・TD の長さが画面を超える・SBA の 1,0 は backlog に残す。
