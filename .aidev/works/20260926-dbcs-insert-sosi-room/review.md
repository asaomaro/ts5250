# レビュー記録

## タスク点検ログ（coding 工程内・「3.3」(b)）
- [should][conv:comment-provenance!] packages/web-ui/src/components/ScreenGrid.vue:2233 コメントの「実機の測定 F1」が本 work の research F1（原典の読み）と取り違えられる / 対応: 修正済（`scripts/acs-probe/dbcs-insert-room.txt` の測定 F1 と明記。T1・ラウンド1）
- [should][conv:verify-by-mutation!] packages/web-ui/test/dbcs-insert-sosi-room.test.ts:118 境界（空き＝必要桁）を固定しておらず `room <= need`・(i) の `need = 3` が生き残った。題名「空き 4」とデータ（空き 7）も食い違い / 対応: 修正済（(i) 空き 4 で入る・空き 3 で 0012、(ii) 空き 3 で入るを追加。題名を直した。T2・ラウンド1）
- [should][conv:verify-by-mutation!] packages/web-ui/test/dbcs-insert-sosi-room.test.ts:190 「J 欄には掛けない」が判定に届かない位置で、O 欄の条件を外しても緑 / 対応: 修正済（J 欄では (i)(ii) が起きないので等価変異と記録し、題名を「従来どおり」に。decisions D5。T2・ラウンド1）
- [nit][conv:-] packages/web-ui/test/dbcs-insert-sosi-room.test.ts:177 上書きのテストが `not.toBeUndefined` だけ / 対応: 修正済（具体値 `Aあいうえ`）
- [nit][conv:test-input-shape] packages/web-ui/test/dbcs-insert-sosi-room.test.ts:50 継続欄が first だけで last が無い / 対応: 修正済（次の欄を last に）
- [should][conv:paired-artifact-sync] packages/web-ui/src/components/ScreenGrid.vue:3883 IME の確定で選択を置き換えた回、全部の字に `replaced` が渡り、新しい必要桁の判定（と既存の最終桁の判定）が 2 字目以降に掛からない。打鍵は置き換え 1 字だけ / 対応: 修正済（`replacedSelection && i === 0`。テストを追加し、戻すと落ちることを確認。cross・ラウンド1）
- [should][conv:verify-by-mutation] packages/web-ui/test/dbcs-insert-sosi-room.test.ts:71 3 経路で規則が揃うことが打鍵でしか固定されていない / 対応: 修正済（貼り付け 2 件・IME の確定 2 件を追加。cross・ラウンド1）
- [nit][conv:comment-provenance] packages/web-ui/src/components/ScreenGrid.vue:3778 貼り付けの「途中で止まる理由」が最終桁だけ。事前の検査と必要桁の検査で空きの数え方が違うことも書いていない / 対応: 修正済（cross・ラウンド1）

## ラウンド 1（2026-09-27）

`aidev coverage`: gap 0（tasks 時と同じ。AC1・AC3・AC4 とも被覆）。差分は `ScreenGrid.vue`（+37/−2）と新しいテスト 1 ファイル。

- **要件適合**: AC1（C3・C4 が 0012・値は変わらない。3 経路とも）・AC3（表の一致例・境界が変わらない）・AC4（継続欄の手順を research F7 に記録し D3 で割る）を満たす。旧 AC2（入ったあとのバイト列）は D2 で対象外にし、起票で残す。
- **価値適合**: ACS で 0012 になる挿入が当 PJ でも 0012 になるので、利用者が「ACS では入らなかったのに入った」に出会わない。入ったあとの桁の使い方の差は残る（起票に書く）。
- **正確性**: 判定は ACS と当 PJ の桁数が食い違う 2 つの場合だけに絞り、他の場合は既存の判定のまま（research F5）。独立点検で見つかった IME の置き換えの抜けは直した。
- **規約適合**: 原典は事実の確認だけに使い、表現は書き起こした。コメントに出所（work slug・research ID・測定ファイル）を付けた。
- **経緯の記録**: T2 の独立点検の委譲先が、変異を当てたあとファイルを自分の手元の写しで戻したため、同時期に当てた T1 の点検の修正（コメントの出所）が一度消えた。review で差分を読んで気づき、当て直した。
  **並行で点検を委譲するときは、委譲先に作業ツリーを書き換えさせない**（変異は写しで行わせる）——次の work から守る。

指摘なし（コード）。
