# 仕様: 欄の外の End

## 設計方針
- ペインの `endKey`: 5250 なら、保護でない欄のうち継続欄の先頭の区切りだけを候補にし、カーソルより後で始まる最初の欄（無ければ先頭）へ `focusFieldStart`。
  末尾へは着いた欄の input に End を渡して置く（DBCS・行をまたぐ欄の末尾の求め方は ScreenGrid が持つ）。3270 は従来どおり。

## 依拠する既存の事実
- 欄の中の End は ScreenGrid の `onInputKeydown` / `onDbcsKeydown` が `end` で置き、割り当てが無ければ伝えない（`20260921-acs-default-keys`）。
- ペインの `end` は End に割り当てが無いときだけ来る（`classifyKey`）。

## 受け入れ基準との対応
- AC1: `pane-nav.test.ts`「欄の外の End はカーソルより後の最初の入力欄へ」「継続欄は先頭の区切りだけ」
- AC2: 同「着いた欄の末尾に置く」
- AC3: mutation
