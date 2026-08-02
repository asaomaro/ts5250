# 仕様: 起動応答の失敗コードを表示セッションでも受け止める

## 概要

実機では backlog の症状（`0xc0`）が**再現しなかった**が、**出る条件はコードで特定できた**
（research F2）。表示セッションが**失敗の起動応答を起動応答と認識できず**、
5250 のデータストリームとして解析しに行くため。

| | いま | これから |
|---|---|---|
| 起動応答と見なす条件 | `device !== ""` | **既知のコード**、または `device !== ""` |
| 失敗コード（8902 等） | 5250 として解析 → `expected ESC, got 0x…` | **理由を添えて接続失敗** |

プリンターは既に正しい（`PrinterSession.handleStartup`）。**表示をそちらへ揃える。**

## 設計方針

### 1. 判断の材料を「装置名の有無」から「コードの既知性」へ

`startup-record.ts` に `isKnownStartupCode(code)` を置き、`CODE_MEANING` を唯一の出所にする。

```ts
if (this.firstRecord) {
  this.firstRecord = false;
  const startup = parseStartupResponse(record, this.codec);
  if (startup && (isKnownStartupCode(startup.code) || startup.device !== "")) { … }
}
```

- **既知コードの照合は `device !== ""` より厳しい**ので、
  「通常のデータストリームを誤って食べる」懸念は後退しない
  （形の正規表現 `^[A-Z0-9]\d{3}$` だけでは緩いという元の判断は正しい）。
- **`device !== ""` の枝は残す**——未知コードでも装置名まで入っていれば従来どおり食べる。
  今まで通っていたものを落とさない。

### 2. 失敗コードは接続を失敗させる（プリンターと同じ文言の作り）

```ts
if (!STARTUP_SUCCESS_CODES.has(startup.code)) {
  throw new As400Error("SESSION_REJECTED", `session rejected (${code}: ${startupCodeMeaning(code)})`);
}
```

**投げる先は接続の途中**なので、`connect()` の失敗として利用者に届く。
`Session5250` は `handleRecord` が非同期の受信経路にいるので、
**接続待ちの promise を失敗させる経路**（`onStartup` 相当）が要る——
プリンターは `onStartup?.(err)` を持っている。表示側は `state` と待ち合わせの作りを見て決める。

### 3. 文言は「なぜ切れたか」を先に出す

`8902: Device not available.` のように**コードと意味**を出す。
装置名が分かっていれば添える（利用者が直せる情報にする）。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `telnet/startup-record.ts` | `isKnownStartupCode` を追加（`CODE_MEANING` が唯一の出所） |
| `session/session.ts` | 起動応答の判定と、失敗時の接続失敗 |
| `test/startup-record.test.ts` ほか | 既知コードの照合・失敗応答の扱い |
| `scripts/research-device-busy.mjs`（作成済み） | 実機の事実 |

**`PrinterSession` は触らない**（既に正しい）。ただし `isKnownStartupCode` は共有できる形にする。

## 振る舞いの詳細

- 成功コード（`I901/I902/I906`）: 従来どおり。情報を控えて先へ。
- 失敗コード（`8902` 等・`CODE_MEANING` にある）: **接続を失敗させ、コードと意味を出す**。
- 未知コード ＋ 装置名あり: 従来どおり起動応答として扱う（成功扱い）。
- 未知コード ＋ 装置名なし: 従来どおり**起動応答にしない**（データストリームとして扱う）。
  ここを変えると通常の画面を食べる恐れがある。
- 2 レコード目以降は従来どおり（`firstRecord` の判定は変えない）。

## エラー処理 / 異常系

- `parseStartupResponse` が `undefined`（形が合わない）→ 従来どおりデータストリーム。
- 失敗コードで投げた例外は `SESSION_CLOSED` ではなく **`SESSION_REJECTED`**
  （プリンターと同じ）——「切れた」ではなく「断られた」と分かる。

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| 何が届くか実測で記録 | `research.md` F1（実機では届かない＝ソケットが閉じる） |
| `expected ESC, got 0x…` が出ない | 方針 1（失敗応答を起動応答として食べる） |
| 本当の理由が届く | 方針 2・3 |
| 正常時が変わらない | 方針 1 の「残す枝」＋ 既存テスト |
| 実機で通す | 装置名の重複が**従来どおり**良い文言で断られることを確認 |
