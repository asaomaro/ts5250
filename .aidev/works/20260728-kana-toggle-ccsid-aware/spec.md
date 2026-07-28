# 仕様: 英カナ表示切り替えの CCSID 対称化

## 0. 現物照合

| 対象 | 位置 | 状況 |
|---|---|---|
| `katakanaChar()`（930 SBCS 固定） | `ebcdic/src/katakana.ts:23` | 片方向。`ibm930Sbcs` のみ import |
| `ibm939Sbcs`（CP1027 の表） | `ebcdic/src/tables/ibm939-sbcs.ts` | **存在するが表示で未使用** |
| 到達可能性ガード | `ebcdic/test/katakana-no-dbcs.test.ts` | 3 ファイル固定・16 KB 未満 |
| 256 バイト焼き付け | `ebcdic/test/katakana.test.ts` | `katakanaChar` のみ |
| 再エクスポート | `core/src/browser.ts:42` | `katakanaChar` のみ |
| 画面描画 | `ScreenGrid.vue` `displayChar():509` | `props.katakanaView` |
| コピー | `ScreenGrid.vue` `copyCharOf():2382` | 同上 |
| 入力欄 | `ScreenGrid.vue` `katakanaViewActive():1056` | 同上（`usesKatakanaCells` / `shiftCellsView` / `el.value`） |
| リンク化の抑止 | `ScreenGrid.vue` `linkEnabled:516` | 同上 |
| 設定 | `viewSettings.ts` `kana: boolean` / `FALLBACK.kana=false` | 2 値 |
| 移行 | `viewSettings.ts` `migrate()` | 既存。ここに足す |
| 順送り | `viewSettings.ts` `cycle()` | `opts` 汎用＝3 値でそのまま動く |
| CCSID 判定 | `hostCodePages.ts` `isKatakanaCcsid()` | 930/5026 が `katakana: true` |
| 親での算出 | `EmulatorPane.vue:68` `uppercaseInput` | 既に `isKatakanaCcsid(state.ccsid)` |

サイズ予算: `katakana.ts`+`table-types.ts`+`ibm930-sbcs.ts` = 8,095 B。
`ibm939-sbcs.ts`（4,562 B）を足して約 12.7 KB → **既存の 16 KB 上限に収まる**（緩めない）。

`App.vue:405` の `.tv.kana` は**テンプレートから参照されていない死んだ CSS**（トグルは
⚙ 画面メニューへ移設済み）。本作業では触らない。

## 1. `packages/ebcdic` — `latinChar()` の追加

`katakana.ts` に `ibm939Sbcs` を使う対の関数を足す（サブパスは分けない。この入口は
「表示コード切替のための SBCS 2 表」という 1 つの役割だと捉える）。

```ts
import { ibm930Sbcs } from "./tables/ibm930-sbcs.js";
import { ibm939Sbcs } from "./tables/ibm939-sbcs.js";

export function katakanaChar(byte: number): string { /* 既存 */ }

/** 生 EBCDIC バイトを英小文字 SBCS（CCSID 939 の SBCS 部＝CP1027）で再解釈する。 */
export function latinChar(byte: number): string {
  return String.fromCharCode(ibm939Sbcs.ebcdicToUnicode[byte & 0xff] ?? 0xfffd);
}
```

- `index.ts` の再エクスポートに `latinChar` を追加。
- `core/src/browser.ts` に `export { katakanaChar, latinChar } from "@as400web/ebcdic/katakana";`
- `core/src/index.ts` の `katakanaChar` 隣に `latinChar` を追加。

**モジュール冒頭の注記を更新する**: 「`codec.js` や `*-dbcs.js` を import しないこと」の規律は
そのまま。読む表が 1 つ増えたことと、その理由（切り替えは 2 表の往復）を書く。

## 2. `packages/web-ui/src/stores/viewSettings.ts` — `kana` の 3 値化

```ts
/** SBCS の表示コード。auto=ホストの表のまま / kana=カタカナで読む / latin=英小文字で読む */
export type KanaView = "auto" | "kana" | "latin";
```

- `ViewSettings.kana: KanaView`
- `FALLBACK.kana = "auto"`
- `VIEW_ITEMS` の `kana` 行:
  ```ts
  { key: "kana", label: "半角カナ表示", opts: [
      { value: "auto",  label: "自動" },
      { value: "kana",  label: "カナ" },
      { value: "latin", label: "英" }
  ] },
  ```
- `migrate()` に旧 boolean の読み替えを足す:
  ```ts
  if (typeof out.kana === "boolean") out.kana = out.kana ? "kana" : "auto";
  ```

### 移行の等価性（既定の見た目を変えない根拠）

| 旧値 | 旧挙動 | 新値 | 新挙動 | 一致 |
|---|---|---|---|---|
| `false`（英） | 再解釈しない＝ホストの表 | `"auto"` | ホストの表 | ✅ |
| `true`（カナ）× 939 | `katakanaChar` → カナ | `"kana"` | ホスト非カナ → `katakanaChar` | ✅ |
| `true`（カナ）× 930 | `katakanaChar` → 変化なし | `"kana"` | ホストがカナ → `host` | ✅ |
| 未保存 | `false` | `"auto"` | ホストの表 | ✅ |

**旧挙動を 1 つも変えずに、`latin` という新しい選択肢が増えるだけ**になる。

### 実効値の解決（純関数）

```ts
/** 画面グリッドに渡す実効の表示コード。host=再解釈しない */
export type SbcsView = "host" | "kana" | "latin";

export function resolveSbcsView(kana: KanaView, hostIsKatakana: boolean): SbcsView {
  if (kana === "auto") return "host";
  if (kana === "kana") return hostIsKatakana ? "host" : "kana";
  return hostIsKatakana ? "latin" : "host";
}
```

**ホストの表と同じ向きを選んだら `host` を返す**のが要点——再解釈を通さないので、
`rawByte` を持たないセル（DBCS・属性桁・`0x1C` が書いた `"*"` 等）でも表示が崩れない。

## 3. `packages/web-ui/src/components/EmulatorPane.vue`

```ts
const sbcsView = computed(() => resolveSbcsView(view.kana, isKatakanaCcsid(state.value?.ccsid)));
```

`<ScreenGrid>` の `:katakana-view="view.kana"` を `:sbcs-view="sbcsView"` に差し替える。
`uppercaseInput` は**そのまま**（対象外。`decisions.md` D2）。

## 4. `packages/web-ui/src/components/ScreenGrid.vue`

prop を差し替える。

```ts
/** SBCS の表示コード。host=ホストの表のまま／kana・latin=生バイトを対の表で再解釈 */
sbcsView?: SbcsView;
```
`withDefaults` に `sbcsView: "host"` を追加。

### 4-1. 再解釈の単一の出どころ

```ts
/** 生バイトを実効表示コードで読み直す。host のときは呼ばれない */
function recodeChar(rawByte: number): string {
  return props.sbcsView === "kana" ? katakanaChar(rawByte) : latinChar(rawByte);
}
/** このセルを再解釈するか（host なら常に false） */
function recodes(c: Cell): boolean {
  return props.sbcsView !== "host" && c.kind === "sbcs" && c.rawByte !== undefined;
}
```

### 4-2. 差し替え箇所

| 位置 | 変更前 | 変更後 |
|---|---|---|
| `displayChar()` | `props.katakanaView && c.kind==="sbcs" && c.rawByte!==undefined` → `katakanaChar` | `recodes(c)` → `recodeChar(c.rawByte)` |
| `copyCharOf()` | 同上 | 同上 |
| `linkEnabled` | `linkify && !props.katakanaView` | `linkify && props.sbcsView === "host"` |
| `katakanaViewActive()` | `if (!props.katakanaView) return false;` | `if (props.sbcsView === "host") return false;` |

`katakanaViewActive` / `usesKatakanaCells` は**名前だけ `recodeViewActive` / `usesRecodedCells`
へ改める**（「カナ表示」ではなく「再解釈表示」になったため）。呼び出し側 4 箇所も追随する。
`shiftCellsView` / `el.value` 経路は `displayChar` を通るので追加変更は不要。

## 5. テスト

| # | ファイル | 内容 |
|---|---|---|
| T1 | `ebcdic/test/latin.test.ts`（新規） | `latinChar` の全 256 バイトを焼き付ける（`katakana.test.ts` と同じ流儀） |
| T2 | `ebcdic/test/latin.test.ts` | 2 表が鏡像であることの実証（`0x81`→`a`/`ｱ`、`0x62`→`ｲ`/`a`、`0x91`→`j`/`ﾀ`） |
| T3 | `ebcdic/test/katakana-no-dbcs.test.ts` | 到達ファイルに `tables/ibm939-sbcs.ts` を追加。**16 KB 上限・DBCS 非到達・`codec.ts` 非到達は据え置き** |
| T4 | `web-ui/test/view-settings-kana.test.ts`（新規） | `resolveSbcsView` の 6 通り（auto/kana/latin × ホストがカナ/英） |
| T5 | 同上 | `migrate()`: 旧 `true`→`"kana"` / `false`→`"auto"` / 新値はそのまま |
| T6 | `web-ui/test/screen-grid-sbcs-view.test.ts`（新規） | `sbcsView="latin"` で `0x81` のセルが `a` に、`"kana"` で `ｱ` に、`"host"` で `c.char` のまま |
| T7 | 同上 | `rawByte` を持たないセル（DBCS・`rawByte` 無し）は再解釈されない |

T1 の期待値は**実表から採取して焼く**（手書きしない）。

## 6. 検証

```
npm run build
cd packages/ebcdic && npx vitest run
cd packages/core   && npx vitest run
cd packages/web-ui && npx vitest run
cd packages/web-ui && npx vue-tsc -b tsconfig.json tsconfig.test.json
npx eslint <変更した core/ebcdic のファイル>            # web-ui は eslint 対象外
```

## 7. 非機能

- バンドル規律を緩めない（T3 の上限・非到達は据え置き）。
- 送信バイトは変えない。再解釈は表示のみ。
- 旧設定を持つ利用者の見た目を変えない（§2「移行の等価性」）。
