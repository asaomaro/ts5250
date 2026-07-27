# タスク: 反転ブロックの窓誤判定と、SEU ソース欄の埋め込み属性の色落ちを直す

**T1 / T3 は「落ちること」を確認してから次へ進む。** 落ちないなら原因の特定が誤っている。

## 不具合 1: 反転ブロックの窓誤判定

- [x] **T1**: 落ちるテストを書く（依存: なし）
  - `packages/web-ui/test/reverse-frame-window.test.ts` に追記
  - **全面反転の矩形ブロック**（内側に非反転セルが無い）で `detectWindowRect` が `null` を返すこと
  - 内側に**全幅の反転強調行**がある窓は窓と判定されること（R1 の担保）
  - **この時点で 1 件目が落ちることを確認する**

- [x] **T2**: `detectReverseFrame` に条件 4 を足す（依存: T1）
  - 側面チェックの直後・`area` 計算の前に「内側に非反転セルが 1 つ以上あるか」を見る
  - 探索順・最小幅・上下端完全一致・優先順位は**触らない**（spec D2）
  - JSDoc の条件一覧に 4 番目を追記する
  - 既存テストが全通過することを確認

## 不具合 2: SEU ソース欄の色落ち

- [x] **T3**: 落ちるテストを書く（依存: なし）
  - `packages/web-ui/test/screen-grid-embedded-attr.test.ts` に追記
  - **値にセンチネルを持たない欄**（DBCS 欄相当）でセルの色が途中で変わるとき、
    オーバーレイが**複数の色クラス**を持つこと
  - **全角を含む場合に桁がずれない**こと（オーバーレイの連結＝入力欄の表示値）
  - **この時点で落ちることを確認する**

- [x] **T4**: `overlayRuns` を 2 経路にする（依存: T3）
  - 値に属性センチネルがあれば従来どおり（**この経路は 1 行も触らない**。spec D3）
  - 無ければ `seg.colorBands` から塗る。文字ごとに `isFullWidth` で桁を進める（spec D4）
  - `classAtColumn` 補助関数を足す
  - **なぜ DBCS 欄だけ違うのか**（core が SO/SI の都合でセンチネルを載せられない）と、
    **色が編集に追従しない**こと（spec D5）をコメントで残す
  - `isFullWidth` を `composables/fieldValidate.js` から import する
    （`columnViewLayout` と同じ規則。桁の数え方を 2 つ作らない）

## 通し確認

- [x] **T5**: 受け入れ基準を通しで確認する（依存: T2, T4）
  - `cd packages/web-ui && npx vitest run`（AGENTS.md。ルートから実行しない）
  - `npm run build`（`tsc -b`）／ `npm test`（全 workspace）／ `npm run lint`
  - `npm run build -w @as400web/web-ui`（`vue-tsc` 込み。R5）
  - **T1 / T3 のテストを `git stash` で修正前へ戻し、落ちることを再確認**（R4）
  - 既存の `screen-grid-embedded-attr.test.ts` の 3 件が**無変更で**通ること（R3）
