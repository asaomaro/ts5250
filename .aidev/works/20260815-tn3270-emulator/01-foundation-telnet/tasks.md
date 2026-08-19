# タスク: 01-foundation-telnet

- [x] T1: `packages/tn3270/` の器を作る（package.json / tsconfig.json / vitest.config.ts / src/index.ts / src/browser.ts）
- [x] T2: root `tsconfig.json` の project references に `packages/tn3270` を追加（依存: T1）
- [x] T3: `eslint.config.js` の `no-restricted-imports` / `no-restricted-globals` 対象に `tn3270` を追加（依存: T1）
- [x] T4: `dependency-direction.test.ts` の `LAYERS` に `tn3270`、`SIBLINGS` に `["tn5250","tn3270"]` `["hostserver","tn3270"]` を追加（依存: T1）
- [x] T5: `transport/types.ts`（`Transport`）と `transport/tcp.ts`（`node:net` / `node:tls`）（依存: T1）
- [x] T6: `protocol/bytes.ts`（`ByteReader` / `ByteWriter`。D7 で複製と決定）（依存: T1）
- [x] T7: `telnet/constants.ts`（IAC/DO/WILL/SB/SE/EOR、OPT_TT=0x18 / OPT_EOR=0x19 / OPT_BIN=0x00）（依存: T1）
- [x] T8: `telnet/terminal-type.ts`（モデル→端末タイプ名・`@装置`・代替サイズ表）＋単体テスト（依存: T7）
- [x] T9: `telnet/telnet.ts`（交渉・IAC 二重化・EOR でのレコード切り出し）＋単体テスト（依存: T5, T7）
- [x] T10: TK4- 起動/停止と s3270 イメージ構築の手順を用意（依存: なし）
  - **置き場を変更**: `scripts/` は README で「実機に当てるものだけ」と明示されているため、
    docker 環境の構築は `packages/tn3270/test/harness/testenv.sh` に置いた（`scripts/README.md` からは参照のみ）
- [x] T11: `TN3270_E2E=1` で TK4- に実接続し、交渉成立と生データ受信を確認（依存: T9, T10）
