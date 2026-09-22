# 調査

## 判明した事実
- F1: JPS（`PrintSCS5250JPS`）: 印字は `JPSPrintableCharacters.process` が 1 字ずつ `drawString`。CR は x を 0 に戻すだけ（左余白を見ない）。BS・UBS は何もしない。下線・強調の SA も何も描かない——JPS が下線・太字を出す道は重ね打ちだけ（R11 の `scs-format` §2.1）。
- F2: 本物の JPS を headless で動かした合成ベクタ（R11。17 通り）: `ABC` CR `___` は両方描く。`ABCDEF` CR `␠␠␠XY` は空白が下の字を消さない。
- F3: 当 PJ: `put`・`putWide`（`packages/scs/src/scs.ts`）はセルへ上書きし、空白も書く。SO/SI だけは「書かずに位置を進める」（`20260921-scs-sosi-columns`）。

## 実装アンカー
- A1: `put`・`putWide`（`packages/scs/src/scs.ts`）。
