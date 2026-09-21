# 決定記録

## D1: 1399 の JEB・1172 を破棄し、ACS の JPE・32000 にする

- 背景: 以前の値は PUB400 の総当たりで通ったものを採っていた（`device-env.ts` の旧注記）。
- 決定: ACS の原典と ACS のワイヤ（research F3）に合わせる。新しい値でも両方の実機で 5250 のサインオンと日本語の往復、3270 の接続、PUB400 の VT が通った。

## D2: 930 は Katakana Extended の値のまま

- ACS の 930 には選択肢が 2 つあり、「Katakana」（`KEY_JAPAN_KATAKANA`）は 290 として扱われ CHARSET が 332 になる。当 PJ の 1172 は「Katakana Extended」と一致する。利用者の ACS がどちらかは未確認なので変えない（台帳に残す）。
