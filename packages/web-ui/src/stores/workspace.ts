import { reactive } from "vue";

/** 分割ツリー: split（縦/横・比率）または group（タブ群）。「タブだけ」は深さ 1 の group */
export interface SplitNode {
  type: "split";
  dir: "row" | "col";
  ratio: number; // a の比率（0〜1）
  a: WsNode;
  b: WsNode;
}
export interface GroupNode {
  type: "group";
  id: string;
  tabs: string[]; // sessionId の並び
  activeTab: string | undefined;
}
export type WsNode = SplitNode | GroupNode;

export type DropZone = "center" | "top" | "bottom" | "left" | "right";

let gid = 0;
const newGroup = (tabs: string[] = []): GroupNode => ({
  type: "group",
  id: `g${++gid}`,
  tabs,
  activeTab: tabs[0]
});

function groups(node: WsNode, acc: GroupNode[] = []): GroupNode[] {
  if (node.type === "group") acc.push(node);
  else {
    groups(node.a, acc);
    groups(node.b, acc);
  }
  return acc;
}

/** node 内で group を探し、親と自身の位置を返す（置換用） */
function findGroup(root: WsNode, id: string): GroupNode | undefined {
  return groups(root).find((g) => g.id === id);
}

/** node ツリー中の target group を replacement で置き換える（新ツリーを返す） */
function replace(node: WsNode, targetId: string, replacement: WsNode): WsNode {
  if (node.type === "group") return node.id === targetId ? replacement : node;
  return { ...node, a: replace(node.a, targetId, replacement), b: replace(node.b, targetId, replacement) };
}

/** target group を削除し、兄弟を昇格させる（空グループの片付け）。ルートが空なら空 group を残す */
function removeGroup(node: WsNode, targetId: string): WsNode | undefined {
  if (node.type === "group") return node.id === targetId ? undefined : node;
  const a = removeGroup(node.a, targetId);
  const b = removeGroup(node.b, targetId);
  if (a && b) return { ...node, a, b };
  return a ?? b; // 片方が消えたら残りを昇格
}

export const workspaceStore = reactive({
  root: newGroup() as WsNode,
  focusedGroupId: "" as string,
  /** 狭幅時は分割を無効化し単一グループにフォールバック（Workspace が set） */
  narrow: false,
  /** SO/SI を {}表示するか（ACS の Ctrl+F 相当。全ペイン共通の表示設定） */
  showShiftMarks: false,
  /** 半角カナ表示（英小文字位置をカナ解釈。ACS の表示コード切替） */
  katakanaView: false,
  /** 画面テキストの URL/メールをリンク化（既定 ON） */
  linkify: true,

  init(): void {
    this.root = newGroup();
    this.focusedGroupId = (this.root as GroupNode).id;
  },

  groups(): GroupNode[] {
    return groups(this.root);
  },

  focusedGroup(): GroupNode {
    return findGroup(this.root, this.focusedGroupId) ?? this.groups()[0]!;
  },

  focus(groupId: string): void {
    this.focusedGroupId = groupId;
  },

  /** セッションをフォーカス中グループのタブとして追加（狭幅時も同様） */
  addSession(sessionId: string): void {
    const g = this.focusedGroup();
    if (!g.tabs.includes(sessionId)) g.tabs.push(sessionId);
    g.activeTab = sessionId;
    this.focusedGroupId = g.id;
  },

  setActiveTab(groupId: string, sessionId: string): void {
    const g = findGroup(this.root, groupId);
    if (g && g.tabs.includes(sessionId)) g.activeTab = sessionId;
  },

  /** タブを別グループへ移動（中央ドロップ＝合流） */
  moveTab(sessionId: string, toGroupId: string): void {
    const from = this.groups().find((g) => g.tabs.includes(sessionId));
    const to = findGroup(this.root, toGroupId);
    if (!from || !to || from === to) return;
    from.tabs = from.tabs.filter((t) => t !== sessionId);
    if (from.activeTab === sessionId) from.activeTab = from.tabs[0];
    to.tabs.push(sessionId);
    to.activeTab = sessionId;
    if (from.tabs.length === 0) this.pruneEmpty();
  },

  /** グループを方向に分割し、sessionId を新グループに置く（端ドロップ＝分割。狭幅時は合流にフォールバック） */
  split(groupId: string, zone: Exclude<DropZone, "center">, sessionId: string): void {
    if (this.narrow) {
      this.moveTab(sessionId, groupId);
      return;
    }
    const target = findGroup(this.root, groupId);
    if (!target) return;
    // 元グループから sessionId を除く
    for (const g of this.groups()) {
      if (g.tabs.includes(sessionId)) {
        g.tabs = g.tabs.filter((t) => t !== sessionId);
        if (g.activeTab === sessionId) g.activeTab = g.tabs[0];
      }
    }
    const fresh = newGroup([sessionId]);
    const dir: "row" | "col" = zone === "left" || zone === "right" ? "row" : "col";
    const newFirst = zone === "left" || zone === "top";
    const split: SplitNode = {
      type: "split",
      dir,
      ratio: 0.5,
      a: newFirst ? fresh : target,
      b: newFirst ? target : fresh
    };
    this.root = replace(this.root, groupId, split);
    this.focusedGroupId = fresh.id;
    this.pruneEmpty();
  },

  closeSession(sessionId: string): void {
    for (const g of this.groups()) {
      if (g.tabs.includes(sessionId)) {
        g.tabs = g.tabs.filter((t) => t !== sessionId);
        if (g.activeTab === sessionId) g.activeTab = g.tabs[0];
      }
    }
    this.pruneEmpty();
  },

  setRatio(splitFinder: (n: SplitNode) => boolean, ratio: number): void {
    const walk = (n: WsNode): void => {
      if (n.type === "split") {
        if (splitFinder(n)) n.ratio = Math.max(0.1, Math.min(0.9, ratio));
        walk(n.a);
        walk(n.b);
      }
    };
    walk(this.root);
  },

  /** 空グループを片付ける。全部空ならルートを単一空グループに */
  pruneEmpty(): void {
    const nonEmpty = this.groups().filter((g) => g.tabs.length > 0);
    if (nonEmpty.length === 0) {
      this.init();
      return;
    }
    let root = this.root;
    for (const g of this.groups()) {
      if (g.tabs.length === 0) root = removeGroup(root, g.id) ?? root;
    }
    this.root = root;
    if (!findGroup(this.root, this.focusedGroupId)) this.focusedGroupId = this.groups()[0]!.id;
  }
});
