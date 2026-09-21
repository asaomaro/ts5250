# レビュー: Field Exit・Field± の前の検査

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目 9 の独立点検。`scratchpad/review-milestone9.md`）
- [should][conv:-] packages/web-ui/src/components/ScreenGrid.vue:2349 先頭が SO の DBCS 欄（J）では論理位置 0 が ACS の `startPos+1` なのに「欄の先頭」と見ていた。ME は MDT があっても 0021、MF は部分入力でも消して進んでいた / 対応: 列ビュー上の位置（`dbcsLayoutOf(f).caretOf(cursor) === 0`）で見る（`rejectExit`）。テスト `field-exit-checks-mdt.test.ts`
- [should][conv:-] packages/web-ui/src/composables/mandatoryCheck.ts:29 ME の MDT を「値が変わったか」で取っていて、(a) ホストの値と同じ字を打ち直した欄、(b) 継続欄の打っていない区間で 0021 になった / 対応: (a) 字を置いたら同じ値でも編集を出す（ACS `inputChar` / `insertChar` の `setMDT`。打鍵・DBCS の打鍵・ペースト・IME の 4 経路。`ScreenGrid.vue` の `charPlaced`）、(b) 継続欄は並びのどこかに MDT があれば全区間を MDT（ACS `PS5250.setMDT`。`mdtOf` に画面の全欄を渡す。呼び出し元 4 か所）
- 変更規模の割り当て: `ScreenGrid.vue` は `20260921-field-minus-zone-d` の表示の変更（`stripSentinels` の差し替え・`ccsid`）も含むが、変更の多いこちらに数えた

## ラウンド 3（通過）
- ラウンド 2 の 2 件を直し、DBCS の先頭・打ち直し（4 経路）・継続欄の MDT をテストで固定した。mutation（`scratchpad/mut-m9.py` / `mut-m9b.py`）でどれも落ちることを確かめた。指摘なし。
