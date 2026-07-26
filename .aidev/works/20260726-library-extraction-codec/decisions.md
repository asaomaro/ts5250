# 決定記録

## D1: web-ui は今も `@as400web/core/codec` を使っている（requirement の記述を訂正）

- 背景: requirement 工程で影響範囲を測ったとき、検索対象を `*.ts` / `*.tsx` に限っており
  **`.vue` を含めていなかった**。その結果「web-ui は codec / scs を一切 import していない」
  「backlog にあった `katakanaChar` 経由の依存は解消済み」と誤って断定した。
  coding 開始前にバンドルのベースラインを測ったところ、web-ui の本番バンドル
  （`dist/assets/index-*.js` = 1,407,469 バイト）に **ibm-930 / ibm-939 の DBCS 表が入っていた**。
  追跡すると `packages/web-ui/src/components/ScreenGrid.vue:41` の
  `import { katakanaChar } from "@as400web/core/codec";` が残っていた。
  **backlog の記述（「web-ui が import しているのは `katakanaChar` の 1 関数だけ」）の方が正しかった。**

- 決定:
  1. requirement.md の「影響範囲の実測」を訂正し、core 外部の利用を **3 ファイル → 5 ファイル**に改めた
     （`ScreenGrid.vue` の `katakanaChar` と、`IfsPane.vue` の `TEXT_CCSIDS`/`ccsidLabel` を追加）
  2. 受け入れ基準に 2 項目を追加した
     - `ScreenGrid.vue` の `@as400web/core/codec` からの import が**無変更のまま解決**すること
     - web-ui のバンドルサイズが **1,407,469 バイトから増えていない**こと
  3. **スコープは広げない**。`katakanaChar` 1 関数のために全 5 表がバンドルへ到達する問題は
     backlog の別項目（「CCSID テーブルの同梱単位を見直す」）であり、
     requirement の「対象外」に明記済み。本作業では**現状のサイズを悪化させないこと**だけを保証する

- 理由 / 代替案:
  - 訂正せずに進めると、`@as400web/core/codec` サブパスの後方互換が
    「server の 1 ファイルのため」の要件に見え、**web-ui のビルドを壊しても
    受け入れ基準では検出できない**（web-ui は root の `tsc -b` に含まれないため。plan R8）。
    実際 spec D4 は `exports["./codec"]` を変えない方針なので設計自体は正しく、
    危ういのは「検証の網」の方だった
  - 代替案として「ついでに `katakanaChar` を表非依存にしてバンドルを削る」ことも検討したが、
    backlog が「(a) 遅延 import 化 / (b) サブパス export の分割 / (c) 生成物の形式変更 のいずれかが要り、
    **ブラウザのバンドル方法に影響する**。バンドルサイズを実測しながら進める独立作業にすること」と
    明記しているため、混ぜない

- 影響:
  - requirement.md: 「影響範囲の実測」と「完了条件」を更新（完了条件 9 → 11 項目）
  - spec.md: **変更なし**。D3（`./catalog` サブパスで表ゼロの入口を維持）と
    D4（`exports` マップを変更しない）は、この事実を踏まえてもそのまま妥当
    ——むしろ `IfsPane.vue` が `TEXT_CCSIDS` を**値**で import している事実が、
    D3 が実際に効いている箇所であることを裏づけた
  - plan.md / tasks.md: T12 のバンドルサイズ比較に**具体的な baseline 値**が入った。
    R8（web-ui のビルドを T12 で必ず実行する）の重要度が上がった

## D2: `@as400web/ebcdic` に `./codec` サブパスを足し、core のファサードはバレルを経由しない

- 背景: T12 のバンドル比較で、web-ui の本番バンドルが **1,407,469 → 1,408,097 バイト（+628）**に
  増えていた。`main` を worktree に取って再ビルドし、同一条件で突き合わせて確認した実測値。
  増分をたどると、baseline に無かった `ibm-1399_P110-2003` と
  `ibm-16684 (from ibm-1399 DBCS part)` がバンドルに現れていた＝**`pure-dbcs.ts` が
  module graph に入っていた**。
  原因は経路の変化だった:
  - 分割前: `@as400web/core/codec` → `codec.ts` **1 モジュール**を直接指す（表だけの狭い入口）
  - 分割後（修正前）: 同じサブパス → 互換ファサード → **`@as400web/ebcdic` のバレル** →
    `pure-dbcs` / `ccsid-text` まで到達
  つまり spec D4 の「`exports` マップを変えない」は守れていたが、**その先の入口が広がっていた**。

- 決定:
  1. `@as400web/ebcdic` に **`./codec` サブパス**（`dist/codec.js`）を追加した
  2. `packages/core/src/codec/codec.ts`（互換ファサード）の参照先を
     `@as400web/ebcdic` → **`@as400web/ebcdic/codec`** に変更した
  3. `codec-reexport.test.ts` に、ファサードがバレルを参照していないことの検査を追加した

- 理由 / 代替案:
  - 628 バイト（+0.045%）を許容する案もあったが、**サイズそのものより経路の性質**が問題。
    「狭い入口が広がった」ことに気づけたのは今回たまたまバイト数を測ったからで、
    次に誰かがバレル経由に戻しても**ビルドもテストも通る**。数値ではなく参照先を固定する
  - `@as400web/ebcdic` の入口が 3 つ（`.` / `./codec` / `./catalog`）になるが、
    これは分割前の core が既に持っていた構造（root / `./codec` / `./browser`）の写しであり、
    新しい概念を足したわけではない
  - **tree-shaking の改善はしていない**（backlog の別項目）。分割前の状態に戻しただけ

- 影響:
  - 修正後のバンドルは **1,407,469 バイト**で baseline と一致。
    さらに Vite のコンテンツハッシュまで `index-CG8HnPjB.js` で一致しており、
    **バイト単位で同一**であることが確認できた（サイズ偶然一致ではない）
  - spec.md「インターフェース」の表に無かった `./codec` 入口が増えた。
    spec の設計方針（D3「表を引き込まない入口を維持する」）と同じ動機の追加で、方針の変更ではない

## D3: `zip-writer.test.ts` の 4 件失敗は環境要因として扱い、本作業では直さない

- 背景: `npm test`（全 workspace）で `@as400web/server` の
  `test/zip-writer.test.ts > 外部の unzip が受け付けること` が 4 件失敗する。
  エラーは `spawnSync unzip EACCES`。

- 決定: **本作業では扱わない**（失敗したまま test 工程へ送り、事実として報告する）。

- 理由 / 代替案:
  - この環境に `unzip` が入っていない（`which unzip` が空・`/usr/bin/unzip` も `/bin/unzip` も不在）。
    テストのコメントどおり「自前の ZIP を自前のパーサで読み返しても証明にならないので
    外部の `unzip` に通す」という設計で、**外部コマンドの存在が前提**
  - `zip-writer.test.ts` が import するのは `../src/zip-writer.js` のみで、
    core も codec も scs も経由しない。**本作業の変更と接点がない**
  - 単体実行（`npx vitest run test/zip-writer.test.ts`）でも同じ 4 件が同じ理由で落ちる＝
    分割による回帰ではなく、この環境で常に落ちる
  - `unzip` を導入する / テストを skip する案は、どちらも**本作業のスコープ外**の
    環境・テスト方針の変更になるため採らない

- 影響: test 工程はこの 4 件を「環境要因の既知失敗」として扱い、
  requirement の完了条件「`npm test` が従来と同じ結果で成功する」は
  **分割前と同じ 4 件が同じ理由で落ちる**ことをもって満たすとみなす
