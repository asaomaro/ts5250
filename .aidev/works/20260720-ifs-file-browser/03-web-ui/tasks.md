# タスク: 03-web-ui（IFS パネル）

- [x] T1: `packages/web-ui/src/ifsApi.ts` を新規作成し、`/api/host/ifs/*` を呼ぶ薄い層を作る。
      **コンポーネントから直接 `fetch` しない**（描画を通さずにロジックを検証できなくなる）。
      サーバーの応答をそのまま返し、解釈はしない。
      型は `@as400web/core/browser` の `IfsEntry` / `IfsListResult` を使う（root は不可）

- [x] T2: `composables/useIfsTree.ts` を新規作成する（依存: T1）。
      `Map<path, TreeNode>` で持ち、`unloaded / loading / partial / loaded / error` を管理する。
      **ページングの罠を 2 つとも吸収する**——
      `entries` が空でも `hasMore` なら続きを取る、`canContinue` が false なら止めて
      「この場所は先頭 N 件まで」と伝えられるようにする。
      木構造を入れ子オブジェクトで持たない（任意ノードの更新に親を辿らせない）

- [x] T3: `composables/usePreview.ts` を新規作成する（依存: T1）。
      拡張子で テキスト / PDF / 画像 / その他 に振り分ける。
      blob URL の解放は**次を表示する直前**と**ペイン破棄時**の 2 箇所だけ
      （`PrinterPane.vue` の `click()` 直後に解放する形を転用すると表示前に消える）。
      **`content: null`（`UNSUPPORTED_ENCODING`）はエラー扱いにしない**——
      「この文字コードは未対応。ダウンロードしてください」を示す状態として持つ

- [x] T4: パネルを登録する（4 箇所を同時に）。
      `paneLabels.ts` の `PANE_PREFIXES` に `"ifs:"`、`PANE_LABELS` に `"ifs:files": "IFS"`、
      `WorkspaceNode.vue` の import・computed・`v-else-if` チェーン、
      `LauncherPane.vue` の `FEATURES`。
      `paneLabels.ts` の 2 箇所は片方だけだと `csv.test.ts` が落ちる

- [x] T5: `components/IfsPane.vue` を新規作成する（依存: T2, T3, T4）。
      左ペインにツリー、右ペインに一覧。選択でプレビュー。
      ダウンロード / zip / アップロード / 新規フォルダ / 削除の操作。
      `docs/UI-DESIGN.md` に従う（配色は CSS 変数、ボタンは設置面の系統、
      ローディングは `useDelayedLoading` + `LoadingBar`、エラーは `<p class="error">`）。
      **ファイル名をそのまま描画しない**（実機に端末エスケープを含む名前が実在する）。
      上書きになる書き込みは事前に確認する

- [x] T6: テストを書く（依存: T5）。
      `useIfsTree` は偽の `fetch` で「空ページでも続きを取る」「`canContinue` で止まる」
      「エラー後に再試行できる」を固定。`usePreview` は振り分けと解放のタイミング。
      `IfsPane` は `mount` + `globalThis.fetch` 差し替えで一覧・選択・エラー文言・
      `content: null` の見せ方。
      **変異させて、本体の分岐を通っていることを確かめる**（02 で 3 回踏んだ）

- [x] T7: 実ブラウザで確認する（依存: T6）。
      `npm run build -w @as400web/web-ui`（`vue-tsc` を含む）を通し、サーバーを起動して
      実機に接続。**テキスト（UTF-8）/ PDF / 画像のプレビュー**、ツリーの展開、
      ダウンロード、zip、アップロード、新規フォルダ、削除を実際に操作する。
      `/QSYS.LIB` を開いて「先頭 N 件まで」の表示と、zip が 409 で断られる文言も見る

- [x] T8: `npm test` 全体と `npm run lint`、`npm run build -w @as400web/web-ui` が通ることを確認する（依存: T7）

- [x] T9: 【review からの差し戻し】must 8 件 + should の主要分を修正する。
      M1 scoped で効かないクラスをやめ素の button に / M2 システム切替で状態を捨てる /
      M3 アップロードの失敗を集約 / M4 一覧が不完全なら上書きの可能性を伝える /
      M5 アップロード経路のテスト / M6 プレビュー失敗でも操作を残す /
      **M7 ツリーを実装する（作っていないのに完了と記録していた）** / M8 キーボード操作。
      S2 操作中は disabled / S4 移動時にメッセージを消す / S5 成功時に error を落とす /
      S8 input の値を戻す（FileList のコピーが必要だった）

- [x] T10: 【review ラウンド 2 からの差し戻し】must 4 件 + should の主要分を修正する。
      RM1 恒真の check を実測に置き換え（開閉が両方向に効くことを確認、13/13 に）/
      RM2 アップロード中のシステム切替で別システムに書かれる経路を塞ぐ /
      RM3 ツリーの移動を run() に通し disabled を効かせる /
      RM4 符号化を要求本文で検証（defineExpose で直接叩く）。
      S1 loadPage の canContinue を検証 / S6 RESOURCE_BUSY の案内 /
      RS1 現在地をツリーに示す / RS2 キャレットと名前を分ける / RS3 ルートの aria-expanded /
      RS4 死にコード削除 / RS5 切替後の案内 / RS7 確認を 1 回に / RS8 ドロップの二重起動。
      ツリーのテスト 5 件を追加（それまで 0 件・変異 0/7 捕捉だった）

- [x] T11: 【review ラウンド 3 からの差し戻し】QM1 + should の記録追随。
      QM1 操作中の禁止（disabled）を回帰テストで固定（2 度直したのに未検証だった）/
      QS1 切替後ガード / QS2 二重起動・読み込み済みでの個別上書き確認 のテスト。
      5 変異すべてが落ちることを確認。QS3 spec の未実装（プレビュー上限・ヌルバイト）を
      decisions D11 に理由付きで記録 / QS4 test-result を実態に追随。
      QN4 コメントに肥大の論点を補足

- [x] T12: 【統合 review からの派生・ユーザー判断】テキストの編集・保存を実装する。
      textarea で編集、変更時に保存ボタン、writeFile を utf8 で。
      UTF-8 で読めたものに限る（undecodable は編集させない・二重防御）。
      UI 経由テストで要求本文を固定、実ブラウザで保存→読み戻しを確認（decisions D13）
