# 決定記録

## D1: 矢印キーの役割を「フィールド間ジャンプ」から「1 セル自由移動」へ変更

- 背景: 従来 EmulatorPane は ↑↓←→ を非保護フィールド「間」の移動に割り当てていた（focusByOffset/focusByRow）。
  ACS/実 5250 は矢印で画面全体をセル単位に自由移動でき、非入力エリアにもカーソルを置ける。要件はこの操作性。
- 決定: 矢印は `useCursor.moveCursor` で有効カーソルを 1 セル移動し、着地セルで field/free を調停する
  （reconcileFocus）。欄内で動かせる Left/Right は ScreenGrid が処理して伝播させない（端・上下・非入力だけ
  がセル移動としてペインに届く）。Tab / Shift+Tab は従来どおりフィールド間ジャンプ（focusByOffset）を維持。
- 理由 / 代替案: per-char span で全セルを埋める案は却下（2000–3500 要素で v-memo 性能を損なう。design 参照）。
  座標変換＋単一論理カーソルで実現。旧 focusByRow（桁保持で真下フィールドへ）は不要になり削除。
- 影響: 既存の pane-nav 矢印テスト（フィールド間ジャンプ前提）はセル移動仕様へ更新が必要（T6）。
  Tab の非回帰は維持。design.md の状態遷移・シーケンス図に一致。

## D2: 論理カーソルを field モード中も native キャレットへ追従させる（sync で cursor emit）

- 背景: field モード（入力欄フォーカス中）はオーバーレイを隠し native キャレットが表示を担う。しかし AID 送信位置・
  ホスト送信桁は有効カーソル（override）に依存するため、欄内でキャレットだけ動くと論理カーソルが取り残される。
- 決定: ScreenGrid の `sync` で `emit("cursor", f.row, f.col + edit.cursor)` を行い、入力・欄内桁移動・
  Backspace/Delete/Home/End の都度、論理カーソルを native キャレット桁に同期させる。
- 理由 / 代替案: 送信時に毎回 native caret を読み直す案もあるが、単一の真実（有効カーソル）を常に最新に保つ方が
  オーバーレイ/AID/クリック調停すべてで整合が取りやすい。
- 影響: onCursor 経由で cursorOverride が高頻度に更新される。ホスト新画面 watch でリセットする既存挙動は不変。

## D3: DBCS 後半桁（dbcs-tail）へのカーソルは前半（lead）へ丸める

- 背景: 全角 1 文字は 2 桁を占め、桁間にカーソルは置けない（ACS/実 5250）。自由移動・クリックで tail 桁に載り得る。
- 決定: `useCursor.roundToDbcsLead(pos, cells)` を追加し、矢印移動（moveCell）とクリック（onGridClick）の
  着地位置を丸める。`cells[row-1][col-1].kind === "dbcs-tail"` を判定に使う。
- 理由 / 代替案: 移動方向を見て tail をスキップする案もあるが、位置確定時に一律丸める方が単純で経路非依存。
- 影響: SBCS・範囲外はそのまま返すため既存挙動に影響なし。

## D4: 矢印で欄の非先頭桁へ入った直後に論理カーソルを目的桁へ再確定（review R1-1）

- 背景: `reconcileFocus` の field 分岐で `el.focus()` が `onInputFocus`→`emit("cursor", 欄先頭)` を誘発し、
  親 `onCursor` が `cursorOverride` を欄先頭へ巻き戻す。native キャレットは目的桁に置くため両者が不一致になった。
- 決定: field 分岐で `setSelectionRange` 後に `cursorOverride.value = pos` を再代入し、論理カーソルを目的桁に確定。
- 理由 / 代替案: `onInputFocus` 側の emit を抑制する案は Tab/クリックの既存経路に影響が波及するため不採用。
  調停点（reconcileFocus）で最後に確定する方が局所的で安全。
- 影響: 欄先頭桁着地時は元々一致のため無害（再代入のみ）。非先頭桁着地・AID 位置の整合が取れる。

## D5: DBCS 右移動は tail を飛び越える（review R1-2）

- 背景: `moveCell` が `moveCursor` 後に一律 `roundToDbcsLead` していたため、lead 桁での ArrowRight が
  tail→lead に丸め戻され、全角文字を跨いで右へ進めなかった（カーソルが貼り付く）。
- 決定: `moveCell` を方向対応にし、tail 着地かつ `dir==="right"` なら 1 桁先へ送る。左/上/下は従来どおり lead へ丸め。
  クリック（onGridClick）は位置確定のため一律 lead 丸めのまま。
- 理由 / 代替案: `moveCursor` 自体を DBCS 認識にする案は純関数に cells 依存を持ち込み肥大化するため不採用。
  調停側（moveCell）で cells を見て補正する方が useCursor の DOM 非依存性を保てる。
- 影響: SBCS・左/上/下・クリックは不変。右移動のみ全角を 2 桁単位で跨ぐ。
