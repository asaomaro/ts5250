# レビュー記録（03-web）

## ラウンド 1（2026-07-15）

subtask 03 の単独レビュー（server WS＋web-ui）。要件・仕様・規約・保守性の観点。

- [should] `EmulatorPane.vue` AID 送信時のカーソル位置が常に (1,1) になる / 対応: 修正
  - **内容**: `EmulatorPane` は `cursor` ローカル ref を (1,1) 初期化し `@cursor` で更新する設計だが、
    `ScreenGrid` は `cursor` を一度も emit しない（クリックハンドラ未実装）。かつホストの `snapshot.cursor`
    を既定に使っていないため、キーボード経由の F キー等が**常にカーソル (1,1) で送信**される。
    spec の「F キー押下時に現在カーソル位置をホストへ送る（F4 プロンプト等）」を満たさない。
    （StatusBar の F キーは `state.cursor`＝ホストカーソルを使うため整合していない点も保守性の懸念）
  - **修正**: EmulatorPane のカーソルを **ホスト snapshot.cursor を既定**にし、グリッドのセル/入力クリックで
    上書きする。ScreenGrid はクリック位置から桁を算出して `cursor` を emit する。

- [should] `ScreenGrid.vue` 幅広フィールドの inline input がグリッド幅をはみ出す / 対応: 修正
  - **内容**: input 幅を `field.length + 'ch'` にしているため、コマンド行（例 len=153）等では 153ch の入力欄が
    行からはみ出す（grid の overflow-x でスクロールはするが桁対応が崩れる）。
  - **修正**: 表示幅を**その行の残り桁数にクランプ**する（`min(field.length, cols - (col-1))`）。フィールドの
    論理長は maxlength で保持。複数行にまたがるフィールドの精緻な折返し描画は 04（DBCS 精緻化）に委ねる。

- [nit] `ScreenGrid` の fieldAt マッピングは単一行フィールド前提（複数行フィールドは先頭行のみ）/ 対応: 許容（04 で精緻化）。
- [nit] useKeymap の Home/End/Tab/矢印のローカル操作は preventDefault のみで実挙動は将来精緻化 / 対応: 許容（文書化済み）。

判定: should 2 件 → coding へ差し戻し。

## ラウンド 2（2026-07-15・差し戻し後の再レビュー）

- [should] カーソル (1,1) 固定送信 → **修正済み**。EmulatorPane のカーソルを **ホスト snapshot.cursor を既定**とし、
  ScreenGrid のセルクリック/入力欄フォーカスで `cursor` を emit して上書き、新画面到達で上書きをリセット。
  ユニット追加（フォーカスで (row,col) emit）。
- [should] 入力幅オーバーフロー → **修正済み**。input 表示幅を行残り桁にクランプ（`min(field.length, cols-col)`）。
  ユニット追加（col=75 len=20 → 6ch にクランプ）。
- must/should なし。nit（複数行フィールド・ローカルキー精緻化）は 04/将来に委譲（文書化済み）。

判定: 指摘解消。全 147 テスト合格、ブラウザ E2E 維持。review 通過。

