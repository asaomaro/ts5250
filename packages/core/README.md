# @as400web/core

TN5250 プロトコルの純 TypeScript 実装。telnet ネゴシエーション（RFC 1205 / RFC 4777）、
5250 データストリーム解釈（SC30-3533-04）、画面モデル、EBCDIC⇔Unicode 変換、
トレース/リプレイを提供する。

対応範囲: SBCS（CCSID 37）＋ **DBCS（930/939/1399・日本語）**、24x80 ＋ **27x132**、平文 TCP ＋ **TLS**。
CCSID で DBCS を有効化（`ccsid: 1399` 等）、`screenSize: "27x132"`、`tls: true`（既定ポート 992・証明書検証既定 ON）。
DBCS は SO/SI をまたぐ EBCDIC_STATEFUL 変換で、SO/SI 桁・DBCS 2 桁を保持し桁位置がズレない。

## 使い方

```ts
import { Session5250 } from "@as400web/core";

const session = await Session5250.connect({
  host: "pub400.com",
  deviceName: "WEBEMU01" // 任意（ジョブ名になる）
});

let screen = session.snapshot();          // ScreenSnapshot（cells / fields / cursor）
session.setField({ index: 1 }, "MYUSER"); // ローカル編集（ホスト送信なし）
session.setField({ index: 2 }, "MYPASS");
const r = await session.sendAid("Enter"); // MDT フィールド送信 → 応答画面
screen = r.screen;                        // r.timedOut === true ならタイムアウト（画面は現状）

session.on("screen", (s) => {/* ホスト発の非同期更新を含む全描画 */});
session.disconnect();
```

## 設計メモ

- **ピュアロジックと I/O の分離**: Node API 依存は `transport/`（socket）と `log.ts`（pino）のみ。
  パーサ・画面モデル・変換はブラウザでも動く（lint で強制）。
- **画面モデルが唯一の真実**: セルは Unicode で保持し、送信時に MDT フィールドだけ再エンコードする。
- **属性桁・SO/SI 桁も 1 セル**として保持し、どの行でも桁位置が 1:1 対応する。
  hidden フィールド / nonDisplay セルは snapshot 生成時点でマスク済み（平文が外に出ない）。

## trace の採り方（リプレイテスト資産）

```sh
node scripts/capture-signon.mjs           # リポジトリルートで実行
# → packages/core/test/fixtures/pub400-signon.jsonl
```

`ReplayTransport` に trace（JSONL）を渡すと、実ホストなしで
ネゴシエーション〜画面適用〜AID 送信の回帰テストができる（`test/session.test.ts` 参照）。
資格情報を送るキャプチャでは `TraceRecorder` の既定（`maskTx: true`）を必ず維持すること。
