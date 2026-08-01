/**
 * **サーバー側サービスの一覧**（`20260801-services-pane`）。
 *
 * ## なぜ他の store と作りが違うか
 *
 * ここが扱うのは**ブラウザが居なくても動いているもの**なので、真実は完全にサーバー側にある。
 * だから画面側に状態を持たず、**REST の一覧を丸ごと差し替える**（`sessionsStore` のように
 * push を積み上げない）。操作したら少し待って引き直す——押した結果が本当に効いたかは、
 * 画面が覚えている値ではなくサーバーに聞く。
 *
 * ## WS を 1 本だけ張る理由
 *
 * 一覧は REST だが、**開始/停止は WS にしか口が無い**（監査・認可が WS 側に揃っている）。
 * `open` を要さないメッセージだけを使うので、**セッションは増えない**——
 * 「見に行くために繋ぐ」ことをしない、というのがこのペインの要点。
 */
import { reactive } from "vue";
import type { PrinterRow, WatchRow, WsServerMessage } from "@as400web/server";
import { WsClient, wsUrl } from "../ws-client.js";

const state = reactive({
  printers: [] as PrinterRow[],
  watches: [] as WatchRow[],
  /** 操作できるか（サーバー設定を編集できる＝認証オフ or admin）。**ボタンの出し分け** */
  editable: false,
  loaded: false,
  error: "",
  /** 操作を送ってから一覧を引き直すまでの間。二重押しを止める */
  busy: ""
});

let client: WsClient | undefined;
let connecting: Promise<void> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

/** 一覧の再取得間隔。**開始は数秒かかる**ので、押した直後だけ短く引き直す */
const POLL_MS = 4000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** WS を張る（冪等）。操作を送るためだけに要る */
async function connect(): Promise<void> {
  if (client) return;
  if (connecting) return connecting;
  const c = new WsClient(
    wsUrl(),
    {
      onServerMessage(msg: WsServerMessage) {
        // **状態は一覧の引き直しで揃える**ので、ここで拾うのはエラーだけ。
        // 操作が断られた理由（権限・設定不備）は画面に出さないと押した側が困る
        if (msg.type === "error") state.error = msg.message;
      }
    },
    "サービス"
  );
  connecting = c
    .connect()
    .then(() => {
      client = c;
    })
    .catch((e: unknown) => {
      state.error = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      connecting = undefined;
    });
  return connecting;
}

export const servicesStore = reactive({
  get printers(): PrinterRow[] {
    return state.printers;
  },
  get watches(): WatchRow[] {
    return state.watches;
  },
  get editable(): boolean {
    return state.editable;
  },
  get loaded(): boolean {
    return state.loaded;
  },
  get error(): string {
    return state.error;
  },
  get busy(): string {
    return state.busy;
  },

  /** 一覧を引き直す。**押した結果はここでしか確かめない** */
  async refresh(): Promise<void> {
    try {
      const [p, w] = await Promise.all([
        getJson<{ printers: PrinterRow[]; editable: boolean }>("/api/printers"),
        getJson<{ watches: WatchRow[]; editable: boolean }>("/api/watches")
      ]);
      state.printers = p.printers;
      state.watches = w.watches;
      state.editable = p.editable;
      state.loaded = true;
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    }
  },

  /** ペインを開いたとき。定期的に引き直す（サーバー側の変化は push で来ないため） */
  async open(): Promise<void> {
    state.error = "";
    await Promise.all([this.refresh(), connect()]);
    timer ??= setInterval(() => void this.refresh(), POLL_MS);
  },

  /** ペインを閉じたとき。**WS は残す**——開き直しが速いのと、監視の購読と違って軽い */
  close(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  },

  /**
   * プリンターの待ち受けを始める。**動いていない定義にも効く**——
   * `printer-service-start` が「定義から作って始める」ので、
   * 一度も開いていないサービスをここから立ち上げられる。
   */
  async startPrinter(row: PrinterRow): Promise<void> {
    await this.operate(row.ref, () => ({ type: "printer-service-start", session: row.ref }));
  },

  async stopPrinter(row: PrinterRow): Promise<void> {
    if (row.id === undefined) return; // 動いていない＝止めるものが無い
    await this.operate(row.ref, () => ({ type: "printer-stop", sessionId: row.id! }));
  },

  /**
   * 監視の待ち受けを始める。**動いているものがあれば再開、無ければ定義から作る**——
   * `watch-start` を動いているものに使うと二重に掛かり、消費するエントリを取り合う。
   */
  async startWatch(row: WatchRow): Promise<void> {
    await this.operate(row.ref, () =>
      row.id !== undefined
        ? { type: "watch-resume", watchId: row.id }
        : { type: "watch-start", session: row.ref }
    );
  },

  async stopWatch(row: WatchRow): Promise<void> {
    if (row.id === undefined) return;
    await this.operate(row.ref, () => ({ type: "watch-stop", watchId: row.id! }));
  },

  /**
   * 操作を 1 つ送って、一覧を引き直す。
   *
   * **少し待ってから引く**——開始はホストへ繋ぎに行くので即座には終わらない。
   * 待ちきれなかったぶんは定期取得が拾う（`POLL_MS`）。
   */
  async operate(ref: string, build: () => Parameters<WsClient["send"]>[0]): Promise<void> {
    state.error = "";
    state.busy = ref;
    try {
      await connect();
      client?.send(build());
      await new Promise((r) => setTimeout(r, 1200));
      await this.refresh();
    } finally {
      state.busy = "";
    }
  },

  /** テスト用の初期化 */
  reset(): void {
    state.printers = [];
    state.watches = [];
    state.editable = false;
    state.loaded = false;
    state.error = "";
    state.busy = "";
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    client = undefined;
    connecting = undefined;
  }
});
