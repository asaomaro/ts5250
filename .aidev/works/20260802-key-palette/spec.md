# 仕様: その他のキーを畳んで出す

## 押したキーは既存のキー処理に流す

ボタン専用の対応表を別に持たない。**`rawKeydown`（キーボードの入口）に流す**——
そうすればキー設定（`ctrl+F1` → 表示コード切替 など）が**ボタンからも同じように効く**。

```ts
function onPaletteKey(k: { key: string; ctrlKey?: boolean; altKey?: boolean }): void {
  rawKeydown({ key: k.key, ctrlKey: ..., altKey: ..., shiftKey: false, metaKey: false,
               preventDefault: () => {} } as KeyboardEvent);
}
```

別の対応表を作ると、**設定を変えたときに片方だけ古くなる**。

## 例外は AID キー

`Attn` / `SysReq` / `PageUp` / `PageDown` / `F1〜F24`（修飾なし）は AID なので、
既存の `press()`（`sendKey`）で送る。**`SysReq` だけは送らずに行を開く**
（実機・ACS の動き。親へ `sysreq` を emit する既存の作りをそのまま使う）。

`Home` / `End` / `Esc` はローカル操作なので keydown 経路へ流す。

## 修飾トグル

`Ctrl` / `Alt` は**押した状態を保持**する（単独では送らない）。トグル中は
**ファンクションキー以外を無効**にする——`Ctrl+PageUp` のような組み合わせは 5250 に無く、
押せてしまうと何が起きるか読めない。

**トグルは押し直すまで外れない**（利用者の言う「トグル」の素直な意味）。
押されていることは**色だけでなく形**（塗りつぶし）でも分かるようにし、
「Ctrl ＋ ファンクションキー」という案内も出す。
