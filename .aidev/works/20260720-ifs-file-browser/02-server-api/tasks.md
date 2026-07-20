# タスク: 02-server-api（zip-writer + /api/host/ifs/*）

- [x] T1: `packages/server/src/host-api.ts` の `statusOf()` に
      `NOT_FOUND` → 404、`ACCESS_DENIED` → 403、`ALREADY_EXISTS` → 409 を追加し、
      **戻り型に 409 を加える**（現在は `400 | 403 | 404 | 502`）。既存テストを壊さないこと

- [x] T2: rc=1（使用中）/ 32（共有違反）/ 33（ロック違反）を写せるようにする（依存: T1）。
      **これらは core が `PROTOCOL_ERROR` で投げており、`statusOf()` は `e.code` で分岐するため、
      02 の中だけでは区別できない**（D11 の前提が誤っていた）。
      core の `ErrorCode` に `RESOURCE_BUSY` を足して `fileFailure` で投げ分け、409 に写す。
      「他の誰かが掴んでいる → 時間をおいて再試行」は利用者が対処できるので、
      「ホストが落ちている」を意味する 502 は誤誘導。decisions に D11 の訂正として記録する

- [x] T3: `packages/server/src/zip-writer.ts` を新規作成する。
      局所ファイルヘッダ（`PK\x03\x04`）→ データ → セントラルディレクトリ（`PK\x01\x02`）→ 終端（`PK\x05\x06`）。
      圧縮は `node:zlib` の `deflateRaw`、**圧縮後が元より大きければ格納（method=0）に落とす**。
      CRC-32 は自前（`0xEDB88320` のテーブル方式）。
      **汎用フラグの bit 11 を立ててファイル名を UTF-8 で入れる**（非 ASCII 名対策）。
      日時は MS-DOS 形式（2 秒単位・1980 年起点）。**zip64 は非対応**と明記する。
      IFS の型に依存しないこと（名前とバイト列の配列だけを受ける）

- [x] T4: `zip-writer` のテストを書く（依存: T3）。
      生成した ZIP を一時ファイルに落として **`unzip -t` に通す**（形式の正しさを外部ツールで確かめる）。
      非 ASCII のファイル名、空の入力、圧縮が効かないデータ（乱数）で格納に落ちること、
      入れ子のパスを含むこと、展開した中身がバイト一致することを確認する

- [x] T5: `ifs-collect.ts` が受け取る narrow な口を定義する。
      `IfsConnection` そのものではなく `listFiles` と `readFile` だけを持つ interface にして、
      **プレーンなオブジェクトでテストできる**ようにする（01 の review M3 と同じ轍を踏まない）

- [x] T6: `packages/server/src/ifs-collect.ts` を実装する（依存: T4, T5）。
      サブフォルダを再帰して集める。**上限判定は一覧のメタデータで行い、
      上限を超えると分かった時点で中身を 1 バイトも読まずに拒否する**。
      ページングでは **`canContinue` を見る**（`hasMore` だけで `nextRestartId` を渡し続けると
      `/QSYS.LIB` で無限ループする）。**`entries` が空でも `hasMore` が true なら続きを取る**。
      シンボリックリンクは辿らない（循環を避ける）。テストは偽の口で書く

- [x] T7: `packages/server/src/host-ifs.ts` にルート 7 本を実装する（依存: T1, T2, T6, T9）。
      `list` / `read` / `write` / `mkdir` / `delete` / `download` / `zip`。
      `registerHostIfsRoutes(app, { resolver })` の形。zod スキーマは同ファイル内に `.strict()`、
      `source` は共通 `sourceSchema`。認可は `c.get("user")` を `resolveSource()` に渡すのみ。
      接続は単発完結（`try { openIfs } finally { close }`）。
      バイナリはスプール PDF に倣って一括返却。zip の上限超過は 413 で
      **実際の件数とバイト数を添える**

- [x] T8: `packages/server/src/app.ts` に `registerHostIfsRoutes` を登録する（依存: T7）。
      **`app.all("/api/*", … 404)` より前**に置くこと

- [x] T9: `packages/server/src/main.ts` の `parseArgs` に
      `--ifs-zip-max-bytes`（既定 20971520）/ `--ifs-zip-max-files`（既定 500）を追加する。
      **4GB 以上が指定されたら起動時に弾く**（zip64 非対応のため、実行時に壊れた ZIP を作らない）

- [x] T10: ルートのテストを書く（依存: T8）。
      `buildApp()` + `app.request()` で入力検証（`.strict()` 違反 → 400）、
      未知のシステム → 404、上限超過 → 413 と本文の件数・バイト数を固定する

- [x] T11: 実機で 7 ルートすべてを確認する（依存: T10）。
      `/home/USER/ifsdemo` に対して一覧・読み・書き・mkdir・削除・単一ダウンロード・zip。
      **zip は実際に展開して中身がバイト一致すること**を確かめる。
      上限を小さくして 413 が出ることも確認する

- [x] T12: `npm test` 全体と `npm run lint` が通ることを確認する（依存: T11）

- [x] T13: 【test からの差し戻し】一覧を最後まで辿れないディレクトリで、
      **部分的な zip を黙って返していた**のを塞ぐ。`listAll` が `canContinue` false で
      打ち切ったとき、呼び出し側に「全部取れた」と見えていた。
      `CollectResult` に `incomplete` を足して拒否し、辿れなくなったパスを添える。
      ルートは 409 `INCOMPLETE_LISTING`。実機で `/QSYS.LIB` が 409 になり、
      正常なフォルダは 200 のままであることを確認する

- [x] T14: 【review からの差し戻し】must 4 件 + should 8 件を修正する。
      M1 EBCDIC を黙って壊す復号を 415 で明示的に断る（CCSID 復号は D7 で後続へ送る）/
      M2 4GB の防波堤を buildZip 自身に置き、事実に反するコメントを直す /
      M3 path="/" が「path is empty」になるのを直す /
      M4 偽の接続を差し込める口を足し、ルート本体を通すテスト 19 件を追加。
      S1 更新日時のテスト（完全に無検証だった）と上端の丸め / S2 空ディレクトリは対象外と明示 /
      S3 ディレクトリ数の上限 / S4 buildApp でも上限を検査 / S5 read のサイズ上限 /
      S6 413 の文言を「以上」に / S7 write・delete・mkdir のログ / S8 読み取り中の上限保険

- [x] T15: 【review ラウンド 2 からの差し戻し】must 3 件 + should 8 件を修正する。
      RM1 4GB のテストが別の例外で通っていた（ガードに到達していなかった）/
      RM2 M3 の修正が `path: "//"` で先頭 1 文字を消す退行を生んでいた /
      RM3 読み取り上限が読んだ後に効いていた。
      RS1 readCollected の 400 を 413 に揃え、テストを追加 / RS2 コードと文言 /
      RS3 変異が OOM でしか捕まらないテスト / RS4 上端年の判定が緩い /
      RS5 zipMaxFiles・readMaxBytes の検査漏れ / RS6 maxDirectories を外から動かせる /
      RS7 encoding の一貫性 / RS8 415 をやめて 200 で返す
