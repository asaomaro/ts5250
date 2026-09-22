# 仕様: 関連付けプリンター（IBMASSOCPRT）

## 概要
表示セッション（5250）の設定に関連付けプリンターの装置名 `associatedPrinter` を足し、接続時に telnet の NEW-ENVIRON の応答の
**最後に** `USERVAR IBMASSOCPRT VALUE <装置名>` を足す（ACS の装置名を書く方式。research F1〜F3）。

## 設計方針
- **ACS と同じ条件・位置・値**: Java の `trim()` で空でなければ送る。値は加工しない（空白を落とさない・大文字にしない。F1・F2）。
  位置は応答の最後（ACS の変数表でも最後。当 PJ の他の変数の並びの差は台帳の別項目で扱う）。
- **設定は表示の 5250 だけ**: プリンター・監視・3270・VT に書いたら保存の時点で 400 にする（`assertTypeConsistent` と同じ考え方——
  書けるのに何も起きない設定を作らせない）。
- **信頼設定ではない**: サーバー上の書き込み・コマンド実行・秘密に触れない（印刷先を決めるのはホストで、権限もホストが見る）ので、
  サーバー設定・自分の設定の両方に置ける。
- 退けた案: 入力の検査（10 文字・使える文字）・大文字化——ACS はしない（F3）。ホストは存在しない名前でも接続を通す（F6）。

## 対象範囲
- `packages/tn5250/src/telnet/telnet.ts`（`TelnetOptions.associatedPrinter`・応答の最後に足す）
- `packages/tn5250/src/session/session.ts`（`ConnectOptions.associatedPrinter` → `TelnetLayer`）
- `packages/server/src/config-types.ts`（`sessionBase.associatedPrinter`・種別の検査）
- `packages/server/src/config-resolver.ts`（`buildConnect` で表示の 5250 だけ渡す）
- `packages/web-ui/src/stores/systems.ts` / `src/components/ConfigCard.vue`（入力欄・読み込み・保存）
- `scripts/acs-probe.mjs` / `scripts/acs-probe/AcsProbe.java`（`PROBE_ASSOC_PRINTER`）・`scripts/README.md`・README（設定の説明）

## 依拠する既存の事実
- NEW-ENVIRON の応答の組み立てと並び: `packages/tn5250/src/telnet/telnet.ts` `handleSubnegotiation`（research F8）。
- 表示の `TelnetLayer` の生成: `packages/tn5250/src/session/session.ts` `establish`（F8）。
- 設定の形と種別の検査: `packages/server/src/config-types.ts` `sessionBase`・`assertTypeConsistent`（F9）。
- 接続の選択肢は `SessionManager.open` が `Session5250.connect({...opts})` でそのまま渡す: `packages/server/src/session-manager.ts:845`（F9）。
- ACS の送出条件・位置・値: `NVT5250.getHostDeviceOptions` と変数 19 の書き出し（F1）、実測（F2）。

## インターフェース / データ構造
- tn5250 `ConnectOptions.associatedPrinter?: string` / `TelnetOptions.associatedPrinter?: string | undefined`
- server `sessionBase.associatedPrinter: z.string().optional()`（表示の 5250 以外に書いたら issue `path: ["associatedPrinter"]`）
- web-ui `SessionConfigForm.associatedPrinter?: string`

## 振る舞いの詳細
- telnet: `finish` の `sendSb` の直前で、`associatedPrinter` が `javaTrim` で空でなければ `USERVAR "IBMASSOCPRT" VALUE <各文字の下位 8 ビット>` を足す
  （ACS の `(byte)charAt`。`ascii()` は下位 8 ビットに丸めないので、この変数だけ `& 0xff` する）。
- 解決: `session.sessionType === "display"` かつ `terminal` が 5250（未指定を含む）で、値があれば `opts.associatedPrinter` に入れる。
- web-ui: 表示・5250 のときだけ「関連付けプリンター」の入力欄を出す。保存は Java の `trim()` 相当で空なら送らない（キーを消す）、そうでなければ入力のまま。
  3270・VT・プリンター・監視へ種別を変えたら送らない。

## ドメイン固有の考慮
- 存在しない装置名ではホストが I901 を返して接続は通る（F6）。ACS は状態行に文言を出す（F7）が、当 PJ の表示セッションは起動コードを画面へ渡していない
  ——台帳に「I901 の表示」として割る（本 work の対象外）。

## エラー処理 / 異常系
- 値の検査はしない（ACS と同じ）。スキーマは文字列であることだけを見る。

## 受け入れ基準との対応
- AC1: telnet 層の単体テストで、値あり → 応答の最後に IBMASSOCPRT、空・空白だけ → 無し。値は加工しない。
- AC2: スキーマのテスト（表示の 5250 は通る・プリンター／3270 は 400）と解決のテスト（`buildConnect` が表示の 5250 だけ渡す）。
- AC3: ConfigCard のコンポーネントテスト（入力 → 保存の body に入る・読み込みで欄に出る・空なら送らない・3270 では送らない）。
- AC4: 実機で当 PJ（`Session5250` に `associatedPrinter`）を同じ手順で測り、ACS のコアの F2・F5・F6 と比べる。
- AC5: 関連付けを渡さない応答のバイト列が変わらないことを telnet 層のテストで固定する（既存の応答の期待値のまま）。
- AC6: 条件（trim 判定・最後に足す・種別の検査・解決の条件・web-ui の送らない条件）を 1 つずつ外してテストが落ちることを確かめる。
