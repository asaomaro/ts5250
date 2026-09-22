# レビュー: Field Exit・Field± の前の検査

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目 9 の独立点検。`scratchpad/review-milestone9.md`）
- [should][conv:-] packages/web-ui/src/components/ScreenGrid.vue:2349 先頭が SO の DBCS 欄（J）では論理位置 0 が ACS の `startPos+1` なのに「欄の先頭」と見ていた。ME は MDT があっても 0021、MF は部分入力でも消して進んでいた / 対応: 列ビュー上の位置（`dbcsLayoutOf(f).caretOf(cursor) === 0`）で見る（`rejectExit`）。テスト `field-exit-checks-mdt.test.ts`
- [should][conv:-] packages/web-ui/src/composables/mandatoryCheck.ts:29 ME の MDT を「値が変わったか」で取っていて、(a) ホストの値と同じ字を打ち直した欄、(b) 継続欄の打っていない区間で 0021 になった / 対応: (a) 字を置いたら同じ値でも編集を出す（ACS `inputChar` / `insertChar` の `setMDT`。打鍵・DBCS の打鍵・ペースト・IME の 4 経路。`ScreenGrid.vue` の `charPlaced`）、(b) 継続欄は並びのどこかに MDT があれば全区間を MDT（ACS `PS5250.setMDT`。`mdtOf` に画面の全欄を渡す。呼び出し元 4 か所）
- 変更規模の割り当て: `ScreenGrid.vue` は `20260921-field-minus-zone-d` の表示の変更（`stripSentinels` の差し替え・`ccsid`）も含むが、変更の多いこちらに数えた

## ラウンド 3（通過）
- ラウンド 2 の 2 件を直し、DBCS の先頭・打ち直し（4 経路）・継続欄の MDT をテストで固定した。mutation（`scratchpad/mut-m9.py` / `mut-m9b.py`）でどれも落ちることを確かめた。指摘なし。

## ラウンド 4（節目 10 の独立点検。`scratchpad/review-milestone10.md`）
- [must][conv:verify-by-mutation!] packages/web-ui/src/components/ScreenGrid.vue:2376 ほか 継続欄の MDT を並び全体で見る修正は、画面の全欄を渡す配線 4 か所のうち 3 か所を戻しても全テストが緑（ScreenGrid を通る 50 ファイル・ペインを通る 76 ファイルでも生き残る）。work の「mutation でどれも落ちる」は偽 / 対応: `field-exit-checks-wiring.test.ts` で ScreenGrid・ペイン・送信前検査・ME をコンポーネントを通して固定し、変異を当て直した
- [should][conv:-] packages/web-ui/src/components/ScreenGrid.vue:2375 Field Exit の「欄の先頭」を型でなく中身で決めていて、G・O・空の J が ACS とずれた（G・O は節目 9 の修正の前は合っていた回帰） / 対応: 型で決める（J は SO が先頭・E は全角で始まるときだけ・G と O は論理位置 0）。実機の ACS のコアで G/O/J/E を測って確定（`scripts/acs-probe/dbcs-field-exit-me.txt`）
- [should][conv:-] packages/web-ui/src/components/ScreenGrid.vue SBCS 欄への貼り付け（主経路）が MDT にならない。decisions D3 は「ペースト」と広く書いていた / 対応: 主経路・単一行・DBCS の各経路で立てる。D3 を訂正
- [should][conv:-] packages/web-ui/src/components/ScreenGrid.vue 字以外の編集キー（Erase EOF・Delete・Backspace・Field Exit の消去）も ACS は値が変わらなくても MDT / 対応: 実機の ACS のコアで確定（`scripts/acs-probe/erase-eof-mdt.txt`）。`mdtKeyed`
- [should][conv:verify-by-mutation!] packages/web-ui/src/components/ScreenGrid.vue `charPlaced`・`ccsid`・3 区間のテストの穴。「mutation で全部検出」は言い過ぎ / 対応: 印の受け渡し（同期ごとに下ろす・置けなかったときは立てない・値が同じでも置いたら立てる）を ScreenGrid を通して固定し、点検役の生き残り 7 通りを含めて落ちることを確かめた
- [should][conv:-] packages/web-ui/src/components/EmulatorPane.vue:170 Field Exit は ACS では自己点検（Mod-10/11）も MF の検査も出た後には見ない。当 PJ は出た後の検査で止めていた / 対応: Field Exit・Field± では出た後の検査を掛けない（`onFieldFull` の `viaFieldExit`）。実機の ACS のコアで測った（`scripts/acs-probe/selfcheck-field-exit.txt`）。`20260921-mandatory-check-acs` の research の呼び出し元の誤りを取り消し線で直した
- [nit] 記録の同期漏れ（台帳の Field− の表示・`fieldEdit.ts` の注記・D3 の「ペースト」・`EmulatorPane.vue` の注記） / 対応: 取り消し線で直した
- [nit] 編集の印はモジュール変数を立てる側と読む側が離れている（`editAcrossContinued` が同期しないと持ち越す） / 対応: 同期しなかったときは印を下ろした（`else void takeMdtKeyed()`）。`charPlaced` を `mdtKeyed` に改名。作りの脆さは台帳へ
- [nit] 実機の測定が無い（G・O・E・字を置いた MDT・継続欄の MDT は原典の読みまで） / 対応: G/O/J/E の先頭・編集キーの MDT・Field Exit と自己点検を ACS のコアで測った
- [nit] G（`pure`）欄の SO/SI（`dbcsViewLayout` は全角の並びに常に足すので、G 欄の予算・列ビューが 2 桁ずれるはず） / 対応: 未検証として台帳へ

## ラウンド 5（通過）
- 節目 10 の指摘を直した。実機の ACS のコアで G/O/J/E の先頭・編集キーの MDT・Field Exit と自己点検を測ってから決めた。mutation は、直した後の 1 回目に生き残った箇所（Delete・印の持ち越し・貼り付け・IME・継続欄の挿入・FER・DBCS の Delete/Backspace）にテストを足して全部落とした。指摘なし。
- 変更規模の割り当て（目安）: 前回の累計に、今回の差分〔`ScreenGrid.vue`・`EmulatorPane.vue`・`field-exit-checks-wiring.test.ts`・`dscmd.c`・`scripts/acs-probe/` の 3 ファイル〕を足した。`fieldEdit.ts` の注記は `20260921-field-minus-zone-d` に数えた
