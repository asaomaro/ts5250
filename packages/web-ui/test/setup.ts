/**
 * テスト共通の後片付け（`20260801-web-ui-flaky`）。
 *
 * ## 何が起きていたか
 *
 * スイート全体を回すと **1〜14 件が回ごとに入れ替わりで落ちていた**。落ちるのは
 * ほぼ `document.activeElement` を見るテストで、単独でファイルを回すと必ず通る。
 *
 * 原因は**マウントの後片付けが揃っていないこと**。`mount()` が 893 回に対し
 * `unmount()` は 469 回で、**424 個が付けっぱなし**だった。`attachTo: document.body`
 * と併用しているので、終わったテストのコンポーネントが `document` に残り続け、
 * **フォーカスと키ーイベントの購読を保持する**。次のテストが `focus()` を呼んでも、
 * 残骸のハンドラが割り込んでフォーカスを奪い返す。
 *
 * ## なぜ「回ごとに変わる」のか
 *
 * 残骸が増えるほど、フォーカスの取り合いに関わる要素が増える。取り合いの結果は
 * 実行の速さ（＝並列実行の混み具合）で変わるので、**同じ入力でも回ごとに違う場所が落ちる**。
 * 落ちたテスト自身に原因は無い——だから追っても直らず、`test:flake-hunt` が要る状態が続いていた。
 *
 * ## 直し方
 *
 * **1 つのテストが終わったら、そのテストが作ったものを全部畳む。** 個々のテストに
 * `unmount()` を書き足して回るのではなく、ここで一律に行う——書き忘れは必ず再発するので、
 * 「書かなくても片付く」形にしておく。
 */
import { afterEach } from "vitest";
import { enableAutoUnmount } from "@vue/test-utils";

// マウントしたものを毎テスト後に unmount する（`unmount()` の書き忘れを構造的に潰す）
enableAutoUnmount(afterEach);

afterEach(() => {
  // **フォーカスを明示的に手放す。** unmount しても `document.activeElement` が
  // `<body>` に戻るとは限らず、次のテストの `activeElement` 判定に影響する
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  // `attachTo` の残骸・テストが直接足した要素を掃除する
  document.body.innerHTML = "";
});
