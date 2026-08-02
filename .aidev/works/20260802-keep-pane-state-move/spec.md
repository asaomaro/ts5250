# 仕様: ペインの実体を 1 か所に置き、置き場所だけを動かす

## 概要

2 つの原因に、2 つの直しを当てる。

### (1) 最大化 — 木を入れ替えるのをやめる

`App` は常に `workspaceStore.root` を描く。最大化は**描く木を差し替える**のではなく、
`WorkspaceNode` の分割段が「最大化したグループを含まない側」を `v-show` で隠し、
含む側を `flex-basis: 100%` にする。分割の比率は書き換えないので、解除すれば元に戻る。

`workspaceStore.displayRoot()` は用が無くなるので**削除する**（残すと「これを描けばよい」と
読めてしまい、同じ事故を招く）。

### (2) タブ移動 — 実体をグループから切り離す

アプリ系ペインの**実体は 1 か所（`PanePool`）にまとめて置き**、`<Teleport>` で
グループ側の受け皿（`.pane-slot`）へ差し込む。グループが描くのは**空の受け皿だけ**。

- タブを移す＝**受け皿の場所が変わるだけ**。Teleport は DOM を移すが
  コンポーネントは作り直さない → 状態がそのまま乗って移る。
- タブを閉じる＝どのグループにも居なくなる → プールから外れて**アンマウント**
  （`onUnmounted` の後片付けは従来どおり走る）。

## 設計方針

### なぜ Teleport か

「同じコンポーネントを別の親の下へ移す」は Vue では Teleport しか手段が無い
（`v-for` の親が変わればコンポーネントは作り直される）。DOM は本当に動くので、
`.group[data-group-id] .admin` のような**子孫セレクタも従来どおり効く**
（`App.vue` のペイン移動のフォーカス先探索がこれに依存している）。

### 受け皿の目印に**グループ id を含める**

Teleport は `to` が**変わったときだけ**行き先を引き直す。受け皿の目印をタブ id だけにすると、
移動で受け皿が作り直されても `to` は同じ文字列のままで、**外れた古い要素にぶら下がったまま**
になる。目印を `<グループ id>/<タブ id>` にして、移動＝`to` の変化にする。

セレクタは属性で書く（`[data-pane-slot="g1/sql:query"]`）——タブ id に `:` を含むため、
id セレクタにすると毎回エスケープが要る。

### 「一度開いた」の記録をグループから出す

遅延マウントの記録（`opened`）は `WorkspaceNode` のローカルだったが、
実体がプール側へ移るので**共有**にする（`composables/openedPanes.ts`）。
グループをまたいで動くものなので、どのグループが持っているかとは独立させる。

### `active`（見えているか）の決め方

`アクティブタブである` かつ `メニュー（ランチャー）を出していない`。
プールは `App` にあるので後者を知っている。メニューに寄っている間はどのペインも見えないので、
サービス一覧の定期取得は止まり、待ち行列監視は既読にしない（#281 以前の挙動と一致）。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `stores/workspace.ts` | `displayRoot()` を削除。`groupOf(tab)`（タブを持つグループ）を追加 |
| `composables/openedPanes.ts`（新規） | 「一度でも開いたアプリ系タブ」の共有記録 |
| `components/PanePool.vue`（新規） | 実体を持ち、受け皿へ Teleport する |
| `components/WorkspaceNode.vue` | 受け皿（空の `.pane-slot`）だけを描く。分割段で最大化を表現 |
| `App.vue` | `root` を描く。`<PanePool>` を `<main>` の後ろに置く |
| `test/pane-maximize.test.ts` | `displayRoot` の検査を「木は書き換えない」＋描画側の検査へ |

## インターフェース / データ構造

```ts
// composables/openedPanes.ts
export const openedPanes: Set<string>;          // reactive
export function markPaneOpened(tab: string): void;
export function forgetPane(tab: string): void;  // 主にテストの後片付け

// stores/workspace.ts
groupOf(tab: string): GroupNode | undefined;

// WorkspaceNode（分割段）
const maximizedInA / maximizedInB / soloed: ComputedRef<boolean>;
```

受け皿の目印: `data-pane-slot="<groupId>/<tab>"`、および従来どおり `data-tab` /
`data-hidden`（フォーカス探索が使う）。

## 振る舞いの詳細

- **最大化**: 含まない側を隠し、含む側を `flex-basis: 100%`。仕切り（divider）も隠す。
  どちらにも無い（あり得ないが）場合は両方出す＝最大化していない扱い。
- **タブ移動**: 受け皿が別グループにできる → `to` が変わる → DOM が移る。
  コンポーネントは同一インスタンスのまま。
- **分割**: 新しいグループができるだけなので上と同じ。
- **閉じる**: どのグループの `tabs` にも無い → プールから外れてアンマウント。
- **未訪問**: `openedPanes` に入らないのでプールに載らない＝作られない。

## エラー処理 / 異常系

- 受け皿が無い状態でプールが描かれると Teleport が行き先を見つけられない。
  **プールは「どこかのグループが持っているタブ」しか載せない**ので、原理的に起きない。
  順序（`<main>` の中の受け皿 → その後にプール）も揃えておく。

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| 最大化 → 解除で両方の入力が残る | (1)。テスト: 2 分割で両方に入力 → 最大化 → 解除 |
| タブ帯へ落としても残る | (2)。テスト: `dropTabInto` で別グループへ |
| 端へ落として分割しても残る | (2)。テスト: `split` |
| 閉じたら消える | プールの母集合が `groups()` 由来 |
| 未訪問は作らない | `openedPanes` |
| 最大化の見た目が従来どおり | `flex-basis` と `v-show`。実ブラウザで寸法を測る |
