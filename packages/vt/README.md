# @ts5250/vt

VT / xterm の**文字モード端末**を純 TypeScript で実装したもの。telnet ネゴシエーション、
DEC ANSI パーサ、スクロールバック付き画面バッファ、キー符号化、文字符号化、トレース/リプレイを提供する。

**5250 / 3270 とは根本的に違う。** フィールドも AID キーも無く、画面は「バイト列が流れてくる」
だけである。したがって「入力欄に値を入れて送る」というモデルは無く、打鍵はそのままホストへ流れる。

対応範囲: DEC ANSI（`VT220` 相当の申告）、SGR / 文字集合 / 各種モード、スクロールバック、
マウス報告、**UTF-8 / Shift_JIS / EUC-JP**、平文 TCP ＋ TLS。

接続先は IBM i の PASE に限らない——AIX・Linux・その他 telnet サーバー一般。

## 使い方

```ts
import { VtSession } from "@ts5250/vt";

const session = new VtSession({
  host: "example.local",
  rows: 24,
  cols: 80,
  encoding: "utf-8",        // "shift_jis" / "euc-jp" も
  terminalTypes: ["VT220"], // IBM i には VT220 を渡す
  ccsid: 1399,              // IBM i にコードページを申告する場合
  deviceName: "VTDEV01"     // RFC 4777 の装置名（IBM i 向け）
});

session.on("screen", (snap) => { /* VtSnapshot（cells / cursor …） */ });
session.on("title", (t) => { /* OSC 0/2 のタイトル */ });
await session.open();
session.text("ls -l");
session.key({ key: "Enter" });
```

ブラウザからは **`@ts5250/vt/browser`** を使う（root は `node:net` / `node:tls` を含む）。

## 設計メモ

- **`encoding` と `ccsid` は軸が違う。** 前者は画面に流れるバイト列の読み方、後者は IBM i に
  コードページを申告するためのもの。IBM i の PASE や AIX の日本語ロケールでは Shift_JIS / EUC-JP が現役。
- **IBM i と判定したら打鍵を 20ms 間隔で送る**（`writeDelayMs` の既定）。一括で流すと欄の移動が
  間に合わず取りこぼす（実測）。明示すればその値、`0` なら間を空けない。
- スクロールバックは既定 1,000 行（`scrollback`）。

## ⚠ 既知の問題

**長時間のアイドルでセッションが死ぬことがある。原因は未特定。** pub400 では 30 分のアイドルで
7 回中 6 回落ちた。同時刻に 5250 と並走させると **VT だけが落ちる**ので VT 固有である。
**TCP キープアライブも telnet `IAC NOP` も効かなかった**（NOP は実装して実機で外れたので撤去した）。
ホスト側の対話ジョブは生きたままで `close` も届かない。
