# 決定記録

## D1: ペインの Tab・Backtab は置き換えない

- ペイン（`EmulatorPane.vue`）は DOM のフォーカスと欄の中のキャレットで判定しており、既に ACS と同じ（`20260921-backtab-acs`）。純関数へ寄せるのは別の作業にする
  （対になる実装が 2 つある状態は残る。台帳に記録）。

## D2: カーソル送りの番号は継続欄の 2 区間目以降を数えない並びで引く（節目 9 の独立点検）
- 背景: design の「欄の番号はスナップショットの `index`」は原典の手順（`FFT5250.getStandardFieldList`）と違った。台帳の「ペインは既に ACS と同じ」もこの点では成り立たなかった。
- 決定: `progressionTarget` / `progressionNumberOf`（tn5250）で引き、HLLAPI とペインの両方がそれを使う。
