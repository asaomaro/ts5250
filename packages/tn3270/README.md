# @ts5250/tn3270

TN3270 プロトコルの純 TypeScript 実装。telnet ネゴシエーション（RFC 1576）、
3270 データストリーム解釈、画面モデル、EBCDIC⇔Unicode 変換、トレース/リプレイを提供する。

対応範囲: **基本 TN3270**（RFC 1576）、SBCS（CCSID 37）＋ **DBCS（930/939・日本語）**、
モデル 2〜5（標準 24x80 ＋ 代替 32x80 / 43x80 / 27x132）、平文 TCP ＋ TLS。

**対象外**: TN3270E（RFC 2355）、プリンター（3287 / LU type 3）、IND$FILE、構造化フィールドの本格対応。

> **`@ts5250/tn5250` とは同位で、互いに依存しない。** telnet の枠組みは似ているが中身は別物——
> 3270 は **SGA も NEW-ENVIRON も使わず**、5250 の GDS レコードヘッダ（LL / 12A0 / opcode）も無い。
> 画面モデルも根本的に違い、**3270 はフィールド属性がバッファの 1 桁を占める**。

## 使い方

```ts
import { Tn3270Session } from "@ts5250/tn3270";

const session = new Tn3270Session({
  host: "127.0.0.1",
  port: 3270,
  model: 2,            // 代替サイズを決める（標準は常に 24x80）
  deviceName: "03C0",  // 任意。端末タイプ文字列に `@03C0` が付く
  ccsid: 930           // 日本語 DBCS。既定 37
});

session.on("screen", (snap) => {
  console.error(snap.cells.map((row) => row.map((c) => c.char).join("")).join("\n"));
});

await session.connect();
session.setCursor(1, 2);
session.type("logon USERID");   // 実際のユーザー名は環境に応じて
session.send("enter");
```

ブラウザからは **`@ts5250/tn3270/browser`** を使う（root は `node:net` / `node:tls` を含む）。

## 画面モデル

3270 のバッファは**桁ごとに性格を持つ**。`CellKind` がそれを表す:

```
桁:      1     2    3    4    5     6     7     8     9
       [attr][ A ][ B ][ C ][ SO ][ 日        ][ SI ][ D ]
kind:   attr  sbcs sbcs sbcs   so   lead  tail   si   sbcs
```

- **フィールド属性は 1 桁を占める**（その桁は文字を持たない）
- **DBCS 1 文字は 2 桁**（`dbcs-lead` + `dbcs-tail`）
- **SO / SI もそれぞれ 1 桁**

フィールドは保持せず `snapshot()` のたびに属性桁を走査して導出する（`decisions.md` D8）。

## 検証環境

ローカルに **TK4-（MVS 3.8j）を docker で立て**、参照クライアント **`s3270`**（x3270 suite・
BSD-3-Clause）と突き合わせて検証している。

```sh
sh test/harness/testenv.sh up      # TK4- 起動（IPL 完了まで待つ）＋ s3270 イメージ構築
TN3270_E2E=1 npx vitest run        # 照合を含めて実行
sh test/harness/testenv.sh down
```

テストは 2 段構成（`decisions.md` D10）:

| 段 | 内容 | 実行条件 |
|---|---|---|
| 単体・replay | アドレス符号化・パーサ・バッファ・snapshot・fixture 再生 | **常に実行** |
| 照合（E2E） | TK4- 実接続、`mini3270` × `s3270` のセル単位比較 | `TN3270_E2E=1` |

**照合で得たバイト列は fixture に落として単体段へ還元する**ので、一度照合すれば
以後は docker 無しでも回帰が効く。

> **日本語 DBCS は実ホスト無しで検証している。** ローカルに立てられる MVS 3.8j（1981 年）は
> 英語 SBCS 専用だが、DBCS は「ホストが SO/SI と DBCS バイトを送る」というデータストリーム上の
> 取り決めなので、**自前の `@ts5250/ebcdic` で符号化した日本語**を `mini3270` から流して
> `s3270 -codepage cp930/cp939` と突き合わせれば足りる。

## 出典

- **RFC 1576**（TN3270 Current Practices）— telnet 交渉・端末タイプ・画面サイズ
- **実測** — コマンド・オーダー・WCC・属性ビット・色・AID の各コードは、
  `s3270` の `-trace`（受信も送信も意味へ復号する）に既知のバイトを流して確定させた。
  採取したトレースは `.aidev/works/20260815-tn3270-emulator/artifacts/` に残してある。

参照実装の `s3270` は BSD-3-Clause だが、**コードは移植せず事実として書き起こしている**（AGENTS.md）。
