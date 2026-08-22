# 仕様: VT セッションを Web の画面から使う

## D1. 端末の種類に `vt` を足す

`WsOpen.terminal` は `"5250" | "3270"` だった。**`"vt"` を足す**（`kind` とは直交のまま）。
設定（systems / sessions）側も同じ列挙を広げる。

## D2. server は専用マネージャを持つ

`VtManager`（`packages/server/src/vt-manager.ts`）。`SessionManager`（5250）・`Tn3270Manager` と
**別に持つ**——3270 のときと同じ判断（`SessionEntry.session` は `Session5250` 型で、
そこへ差し込むと影響が全域に及ぶ）。

`ws-handler` が `onOpen` の入口で振り分ける。**保存済み設定（`system` / `session`）も
ホスト直指定も受ける**（解決は 5250 と同じ `ConfigResolver` に通す。信頼境界を二重に書かない）。

## D3. 画面の配信 — **前回との差分行だけ送る**

VT は 1 打鍵ごとにエコーが返る。全画面（24x80＝1,920 セル）を毎回流すと、
入力しているだけで秒間何十回も全画面が飛ぶ。

- **変わった行だけ送る**。`lines` は `{ row, runs }` の配列
- **見た目は palette に括る**。1 メッセージ内で使う `VtStyle` を配列にし、runs は添字で指す
- **連続する同じ見た目の文字はまとめる**（run-length）。空白だけの行末は落とす
- **全角の継続セルは送らない**——等幅フォントなら全角そのものが 2 桁を占める
- **スクロールバックは増えたぶんだけ**送る（`scrollback: runs[][]`）
- 最初の 1 通（`vt-opened`）だけは全行を送る

**まとめて送る（coalesce）。** `screen` イベントは受信のたびに飛ぶので、
**16ms（1 フレーム）ぶん溜めてから 1 通**にする。`ls -R /` のような濁流でも配信は毎秒 60 通で頭打ち。

## D4. 打鍵は **意味のまま送り、server が符号化する**

`DECCKM` / `DECKPAM` / `?2004` / マウスの様式は **server の `VtTerminal` が持っている**。
ブラウザ側で符号化すると**モードの写しを 2 つ持つ**ことになり、必ずずれる。

```ts
{ type: "vt-input", key?: VtKeyName, text?: string, ctrl?, alt?, shift? }
{ type: "vt-input", paste: string }
{ type: "vt-input", mouse: { button, row, col, kind, ... } }
```

往復は 1 回増えるが、**ホストのエコーを待つ以上どのみち往復する**ので体感は変わらない。

## D5. 大きさは**ペインを測って**決める

隠した測定用の要素（同じフォントで `0` を 100 個）の幅から 1 桁の幅を、
`line-height` から 1 行の高さを得て、ペインの寸法を割る。

- 変更は **150ms 落ち着いてから**送る（ドラッグ中に何十回も NAWS を送らない）
- 下限は **20 桁 × 5 行**（それ以下は測らない）
- **`ResizeObserver`** で監視する

## D6. 描画（`VtPane.vue`）

- 1 行 = `<div class="vt-line">`、run = `<span>`。**位置は文字の並びで決まる**
  （`ScreenGrid` のような絶対配置はしない。VT は行が流れるので相対配置の方が自然）
- 色は CSS 変数で 16 色を定義し、`indexed 0-15` はそれを引く。**16-255 は xterm の標準表を
  計算で出す**（表を持たない）。`rgb` はそのまま
- **カーソルは 1 桁ぶんの箱を重ねる**（`ch` 単位。`ScreenGrid` と同じ流儀）
- **スクロールバックは同じ流れの上に置く**（画面の上に continuous に並べる）。
  代替画面では**スクロールバックを出さない**（`vi` の背後に履歴が見えるのはおかしい）
- 選択とコピーは**ブラウザ既定の選択に任せる**（`user-select: text`）。
  自前の矩形選択は作らない——要求が出てから

## D7. 打鍵の拾い方

`<div tabindex="0">` に `keydown` を張る。

- **既定動作を止める**（`Tab` / `Ctrl+A` 等がブラウザに食われる）。ただし
  **`Ctrl+Shift+C` / `Ctrl+Shift+V` は通す**（コピー・貼り付けの逃げ道）
- **IME は `compositionend` で拾う**（`keydown` では日本語が取れない）
- 貼り付けは `paste` イベント

## D8. 符号化を選べる

セッション設定に `encoding`（`utf-8` / `shift_jis` / `euc-jp`）。既定 `utf-8`。
**CCSID とは別物**——CCSID は IBM i にコードページを申告するためのもので、
VT の画面の符号化とは軸が違う。

## D9. 見せないもの

VT のペインでは**ファンクションキーの帯・SysReq 行・マクロ・予約の表示を出さない**。
どれも 5250 の概念で、VT には無い。**出すと「押しても何も起きない」で混乱させる。**

## 受け入れ基準

requirement のとおり。実ブラウザ検証は `scripts/verify-browser-vt.mjs` を新設する。
