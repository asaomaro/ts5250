# 調査: WEA の否定応答

## 判明した事実
- F1（原典 `DS5250.processWriteToDisplay` の `case 18`・`PS5250.writeExtAttribute`）: 長さ不足は 0x10050121。`writeExtAttribute` は値 ≥256 → 2、`currSBA >= Size` → 3、
  タイプ 5 以外 → 1、タイプ 5 で SBCS のセッション → 1、タイプ 5 の値が 0x81・0x80・0x00 以外 → 2。呼び出し側は 1 → 0x1005012D（`SC_Invalid_AttributeType`）・2 → 0x1005012F（`SC_Invalid_Attribute`）・
  3 → 0x1005012A（`SC_WritePastDisplayEnd`）で `return`（WTD を打ち切る）。
- F2（実測。2026-09-27。DSM の `dscmd.c` の WTDERRWEA*・`scripts/acs-probe/wea-sense.txt`・`scripts/tap-proxy.mjs` のワイヤ）: 1 本の WTD（CC2＝メッセージ待ち・5 行に WTDERR）の後ろに WEA ＋ 6 行の NEXT。
  社内機・930: タイプ 1 → `04 80 00 00 10 05 01 2d`、タイプ 5 値 0x42 → `…01 2f`、EA で 24,80 まで消した後のタイプ 5 → `…01 2a`、タイプ 5 値 0x00 → 否定応答なし・NEXT が書かれる（対照）。
  否定応答の 3 つはどれも NEXT が書かれず、メッセージ待ちは点いた。PUB400・37（社内機は SBCS の装置を自動構成せず接続が切れた。PUB400 のプローブは画面のサインオンが通らず、ACS の自動サインオン〔`PROBE_BYPASS_SIGNON=clear`〕で通した）:
  タイプ 5 値 0x00 → `…01 2d`・NEXT なし・メッセージ待ちが点く。各モード 1 回ずつの測定だが、原典（F1）という別の経路と一致し、930 と 37 の対照も取れている。
- F3（当 PJ）: `wtd-applier.ts` の `case ORDER.WEA` はタイプ 5 の 3 値（DBCS）だけ効かせ、それ以外は警告して続ける。`fail(sense, msg)` は他のオーダーの否定応答と同じく WTD を打ち切り尾部（CC2）を走らせる。

## 実装アンカー
- A1: `packages/tn5250/src/protocol/wtd-applier.ts` `case ORDER.WEA`・`SENSE`
