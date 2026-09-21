# 調査: ACS の KBDTYPE / CODEPAGE / CHARSET

## 判明した事実
- F1（原典）: `NVT5250.getHostDeviceOptions`: CHARSET・CODEPAGE は `CodePage.getHostCodePage_CharSet()`（`SBGIDTable` の行の GCSGID・CPGID）。
  GCSGID が 65535 なら 32000 に置き換える（`S390_CHRID_FOR_FFFF` → `AS400_CHRID_INSTEAD_OF_FFFF`）。KBDTYPE は `CodePage.getKbdType(codePageKey)`。
- F2（原典）: `getKbdType` の表: `KEY_JAPAN_ENGLISH_EX_EURO`（1399）→ JPE、`KEY_JAPAN_ENGLISH_EX`（939）→ JPB、`KEY_JAPAN_KATAKANA` / `_EX`（930）→ JKB、
  `KEY_JAPAN_KATAKANA_EX_EURO`（1390）→ JPB、`KEY_US` → USB。表に無いキー・キー無しは空白 3 つ。`SBGIDTable`: 1399 は GCSGID 65535・CPGID 1027、
  930 は 1172・290、939 は 1172・1027、290 は 332・290、37 は 697・37。`KEY_JAPAN_KATAKANA` は `CodePage` の構築で 290 として扱う。
- F3（実機・ACS のワイヤ）: プローブに `PROBE_CODEPAGE_KEY` を足し、タップ越しに PUB400 へ当てた（記録はパスワードを含むので値を伏せて解析し、消した）:
  1399＋`KEY_JAPAN_ENGLISH_EX_EURO` → `JPE / 1027 / 32000`、939＋`KEY_JAPAN_ENGLISH_EX` → `JPB / 1027 / 1172`、930＋`KEY_JAPAN_KATAKANA_EX` → `JKB / 290 / 1172`、
  930＋`KEY_JAPAN_KATAKANA` → `JKB / 290 / 332`、37＋`KEY_US` → `USB / 37 / 697`。キー無し（プローブの既定）は KBDTYPE が空白 3 つ。どれも ACS のコアはサインオンできた。
- F4（当 PJ）: `device-env.ts` は 1399 だけが ACS と違う（JEB・1172）。930（Katakana Extended と同じ）・939・37 は一致。
