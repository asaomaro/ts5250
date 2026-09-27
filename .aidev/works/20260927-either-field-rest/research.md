# 調査: E 欄の残り

## 判明した事実
- F1: ACS `PS5250.pasteRect` は字ごとに `inputChar`（上書き）/ `insertChar`（挿入）を呼び、どちらも `checkDBCSField`（E 欄の規則）を通る。上書きは誤りの字の位置を進めて続け、挿入は誤りでエラーにしてその場で戻る（それまでに挿入した字は残る）
- F2: 当 PJ の挿入の貼り付けは、1 字でも不可なら何も貼らない（`firstRejection`。`20260719-paste-input-validation`）
- F3: 実機の ACS のコア（DSM の READDBCS の E 欄 17,10 `SO あ SI`。`scripts/acs-probe/either-empty.txt`）: SO の直後から Erase EOF した 0x82 の欄データは `0e`（SO だけ・SI は消える）、カーソルは 17,11。先頭に X を打った 0x52 は `e7`。当 PJ は空の値で何も送らない
- F4: 当 PJ の E 欄の状態は画面（`eitherSwitched`・値の先頭の字）とコア（`InternalField.eitherDbcsOn`。ホストの SO と送った値の先頭の字）に分かれ、空の値はコアの状態を変えない

## 実装アンカー
- A1: `packages/web-ui/src/components/ScreenGrid.vue` の `overwriteInto`・`insertInto`・`firstRejection`・貼り付けの DBCS の経路
