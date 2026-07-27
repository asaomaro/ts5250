# タスク: CCSID テーブルの同梱単位を見直し、web-ui のバンドルから DBCS 表を外す

**T1 を最初にやること。** 表を分割した後では変更前の `katakanaChar` の値を取れず、
「変わっていない」ことを証明する手段そのものを失う（plan R1）。

## 基準の採取（変更前に）

- [x] **T1**: 変更前の基準を固定する（依存: なし）
  - `katakanaChar` の**全 256 バイト**の出力を採取し、
    `packages/ebcdic/test/katakana.test.ts` に**期待値として書き込む**
  - **この時点でテストが緑になることを確認**してから次へ進む（変更前の値であることの担保）
  - web-ui の本番バンドルを測り、baseline が **1,407,469 バイト**であることを再確認する
  - バンドル内に `ibm-930_P120-1999` / `ibm-939_P120-1999` の識別子があることも確認する
    （後で「消えた」と言うための対照）

## 生成器と生成物（ここから一時的に赤）

- [x] **T2**: `emit-stateful.ts` を 3 モジュール出力に変える（依存: T1）
  - 戻り値を 1 文字列から `{ sbcs, dbcs, index }` に変更する
  - **flag による方向規則の振り分けロジックは 1 行も変えない**（出力の分け方だけを変える）
  - 3 ファイルすべてに出典ヘッダ（AUTO-GENERATED / ICU / Unicode License V3 / 再生成コマンド）を付ける
  - 合成モジュールは `ibm930Sbcs` / `ibm930Dbcs` を import して
    `StatefulTable` を組むだけにする（既存の `ibm930` の値・型・名前は不変）
  - `tools/gen-tables/src/main.ts` を 3 ファイル書き出しに対応させる
  - `gen.test.ts` に `emitStatefulTable` の分割の検査を追加する（現状は未テスト。R7）

- [x] **T3**: 表を再生成し、冪等であることを確認する（依存: T2）
  - `npm run gen:tables` を実行し、`tables/` が 5 → 11 ファイルになることを確認
  - **もう一度実行して `git diff --exit-code` が差分なし**であること（冪等）
  - 旧 5 ファイルのうち置き換わらないもの（`ibm37.ts` / `ibm273.ts`）が無変更であること

## ebcdic 側の付け替え

- [x] **T4**: `katakanaChar` を専用モジュールへ移す（依存: T3）→ **完了時点でビルドが緑に戻ること**
  - `packages/ebcdic/src/katakana.ts` を新規作成し、`tables/ibm930-sbcs.js` **だけ**を import する
  - `packages/ebcdic/src/codec.ts` から `katakanaChar` の定義を削除し、`./katakana.js` から再輸出する
    （`@as400web/ebcdic` バレルと `@as400web/ebcdic/codec` の公開面は不変）
  - `packages/ebcdic/package.json` に `./katakana` サブパスを追加
  - `packages/ebcdic/src/index.ts` の入口一覧の表に `./katakana` を追記
  - T1 の 256 バイトテストが**引き続き緑**であることを確認（＝移設で値が変わっていない）

- [x] **T5**: `pure-dbcs.ts` の import 先を DBCS 部に絞る（依存: T3）
  - `tables/ibm1399.js` → `tables/ibm1399-dbcs.js`（`ibm1399.dbcs` しか使っていないため）
  - `pure-dbcs.test.ts` が通ることを確認

## 利用側

- [x] **T6**: `core/browser.ts` に `katakanaChar` を足す（依存: T4）
  - `@as400web/ebcdic/katakana` から re-export する（**バレルや `/codec` ではない**）
  - なぜ browser に置くのかをコメントで残す（`browser.ts` の既存の意味づけに乗せる）

- [x] **T7**: `ScreenGrid.vue` の import を統合する（依存: T6）
  - 41 行目の `import { katakanaChar } from "@as400web/core/codec";` を削除し、
    43〜48 行の `@as400web/core/browser` の import にまとめる
  - **これで web-ui のモジュールグラフから `@as400web/core/codec` が消える**

## 検査

- [x] **T8**: 到達検査を追加する（依存: T4）
  - `packages/ebcdic/test/` に、`katakana` 入口から到達可能なモジュールに
    `*-dbcs.ts` と合成モジュールが含まれないことの検査を置く
  - 既存の `catalog-no-tables.test.ts` の手法（import グラフを実際にたどる）を再利用する
  - **実際に壊して落ちることを確認**してから完成とする（AGENTS.md／前作業 retro の原則）

## 通し確認

- [x] **T9**: 受け入れ基準を通しで確認する（依存: T5, T7, T8）
  - クリーンビルド（`dist` を消してから `npm run build`。R6）
  - `npm test`（全 workspace）／ `npm run lint`
  - `npm run build -w @as400web/web-ui`（`vue-tsc` 込み。R8）
  - **バンドル実測**: `ibm-930_P120-1999` / `ibm-939_P120-1999` の識別子が消えていること、
    サイズが baseline 1,407,469 から **400,000 バイト以上**小さいこと（R5。届かなければ着地しない）
  - `git diff --stat -- packages/server/src` が**空**であること
  - `npm run gen:tables` → `git diff --exit-code`
  - `codec-reexport.test.ts` が**無変更で**通ること
