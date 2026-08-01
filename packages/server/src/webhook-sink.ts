/**
 * **待ち行列サービスの Webhook 転送**（`20260801-dtaq-webhook`）。
 *
 * ## この設計を決めている一つの事実
 *
 * **監視は消費する。** データ待ち行列の読み取りは「取り出して消す」操作で、読んだ時点で
 * ホスト側からエントリは無くなり、取り消せない。
 *
 * つまり**転送の失敗はデータの喪失である**。プリンターの自動出力とは性格が違う——
 * あちらは失敗してもスプールがホストの OUTQ に残るので、後から取り直せる。
 *
 * 「失敗しても大丈夫」の作りにできないので、**どこで諦めるか・諦めたものをどう見せるか**を
 * 機能そのものと同じ重さで決めてある。
 *
 * ## 読み取りを塞がない
 *
 * 受け手が落ちていても**キューの読み取りは続ける**。止めるとホスト側のキューが溢れ
 * （`MAXENTRIES` を超えると送信側が失敗する）、**受け手の障害がホスト側の業務の障害に
 * 伝播する**。読んだら積むだけにして、送信は別の流れで進める。
 *
 * ## 二重送信は受け手に委ねる
 *
 * 「送ったが応答が届かなかった」を我々は区別できない。だから `X-As400-Delivery`
 * （**再送でも変わらない** id）を付けて、**受け手に冪等性を委ねる**のが唯一正しい形。
 */
import { randomUUID, createHmac } from "node:crypto";
import type { WebhookConfig } from "./config-types.js";
import type { WatchEntryView } from "./watch-registry.js";
import { childLog } from "./log.js";

const log = childLog({ component: "webhook" });

/** 転送キューの上限。**無限に溜めない**——受け手が一晩落ちてもメモリを食い潰さない */
const QUEUE_LIMIT = 500;
/** 未達の記録の上限（新しい順に残す）。プリンターの警告履歴と同じ形 */
const UNDELIVERED_LIMIT = 50;
/** 諦めるまでの待ち（ms）。最後の値を超えたぶんは同じ間隔で繰り返す */
const BACKOFF_MS = [1_000, 5_000, 15_000, 60_000] as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/** 諦めた 1 件。**本文の全文は持たない**（メモリに残す理由が無い） */
export interface UndeliveredEntry {
  seq: number;
  at: number;
  reason: string;
  /** 本文の先頭だけ */
  preview: string;
}

export interface WebhookStats {
  /** 送れた件数 */
  delivered: number;
  /** 諦めた件数（**上限で落ちた分も含む**） */
  failed: number;
  /** いま送信待ちの件数 */
  pending: number;
  /** 諦めた記録（**新しい順**） */
  undelivered: UndeliveredEntry[];
}

/** 転送 1 件ぶんの荷物 */
interface Job {
  entry: WatchEntryView;
  label: string;
  /** **再送でも変わらない**（受け手が二重処理を避けられるように） */
  deliveryId: string;
  attempts: number;
}

export interface WebhookSinkOptions {
  /** 差し替え可能にしてある（テストは偽の送信を渡す） */
  fetch?: typeof globalThis.fetch;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  queueLimit?: number;
}

/**
 * 1 つの監視につき 1 つ。**直列に送る**——並べて送ると順序が崩れるうえ、
 * 受け手を並列数で殴ることになる。
 */
export class WebhookSink {
  private readonly queue: Job[] = [];
  private readonly undelivered: UndeliveredEntry[] = [];
  private delivered = 0;
  private failed = 0;
  private running = false;
  private stopped = false;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly queueLimit: number;

  constructor(
    private readonly ref: string,
    private readonly config: WebhookConfig,
    private readonly secret: string | undefined,
    opts: WebhookSinkOptions = {}
  ) {
    this.doFetch = opts.fetch ?? globalThis.fetch;
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.queueLimit = opts.queueLimit ?? QUEUE_LIMIT;
  }

  get stats(): WebhookStats {
    return {
      delivered: this.delivered,
      failed: this.failed,
      pending: this.queue.length,
      // **新しい順**——溜まった古い失敗より、いま起きていることを先に
      undelivered: [...this.undelivered].reverse()
    };
  }

  /**
   * 1 件積む。**待たない・投げない**——呼ぶのはキューの読み取りループなので、
   * ここで待つと受け手の遅さがホストの読み取りを塞ぐ。
   */
  deliver(entry: WatchEntryView, label: string): void {
    if (this.stopped) return;
    if (this.queue.length >= this.queueLimit) {
      // **古いものから落とす。** 溜め続けてメモリを食い潰すより、
      // 落ちたことが分かるほうがよい（プリンターの帳票バッファと同じ判断）
      const dropped = this.queue.shift();
      if (dropped) this.record(dropped, `転送キューが上限（${this.queueLimit} 件）を超えました`);
    }
    this.queue.push({ entry, label, deliveryId: randomUUID(), attempts: 0 });
    void this.pump();
  }

  /**
   * **プロセスを畳むときだけ呼ぶ**（`WatchRegistry.closeAll`）。未送分は失われる。
   *
   * **利用者の「停止」では呼ばない。** 読み取り済みのエントリはホスト側から既に消えているので、
   * そこで捨てれば**ただのデータの喪失**になる——「待ち受けを止める」は「これ以上読まない」
   * であって「読んだものを配らない」ではない（`stopPrinter` が受信済みの帳票を残すのと同じ）。
   */
  stop(): void {
    this.stopped = true;
  }

  /** 直列に流す。既に走っていれば何もしない（冪等） */
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const job = this.queue[0]!;
        const outcome = await this.attempt(job);
        if (outcome === "ok") {
          this.queue.shift();
          this.delivered += 1;
          continue;
        }
        if (outcome === "give-up") {
          this.queue.shift();
          continue;
        }
        // 再試行する。**待つ間もキューは受け付ける**（`deliver` は別の流れ）
        const wait = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)] ?? 60_000;
        await this.delay(wait);
      }
    } finally {
      this.running = false;
    }
  }

  private async attempt(job: Job): Promise<"ok" | "retry" | "give-up"> {
    job.attempts += 1;
    const maxAttempts = this.config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const body = JSON.stringify({
      queue: job.label,
      ref: this.ref,
      seq: job.entry.seq,
      at: new Date(job.entry.at).toISOString(),
      bytes: job.entry.bytes,
      text: job.entry.text,
      ...(job.entry.sender !== undefined ? { sender: job.entry.sender } : {})
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // **再送でも変わらない。** 受け手が二重処理を避けるための鍵
      "x-as400-delivery": job.deliveryId
    };
    if (this.secret !== undefined) {
      headers[(this.config.secretHeader ?? "Authorization").toLowerCase()] = this.secret;
      // 本文の署名。**ヘッダーを信じられない経路でも中身の改竄が分かる**
      headers["x-as400-signature"] = `sha256=${createHmac("sha256", this.secret).update(body).digest("hex")}`;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await this.doFetch(this.config.url, {
        method: "POST",
        headers,
        body,
        signal: ctl.signal,
        // **リダイレクトを追わない。** 追うと送り先が設定と違うホストになりうる
        redirect: "manual"
      });
      if (res.status >= 200 && res.status < 300) return "ok";
      // **4xx と 3xx は再試行しない。** 前者は受け手が「要らない」と言っており、
      // 後者は送り先がすり替わる。何度送っても同じ結果になる
      if (res.status < 500) {
        this.record(job, `受け手が ${res.status} を返しました（再試行しません）`);
        return "give-up";
      }
      if (job.attempts >= maxAttempts) {
        this.record(job, `受け手が ${res.status} を返し続けました（${job.attempts} 回）`);
        return "give-up";
      }
      return "retry";
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (job.attempts >= maxAttempts) {
        this.record(job, `届きませんでした（${job.attempts} 回）: ${message}`);
        return "give-up";
      }
      return "retry";
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 諦めた 1 件を残す。**データは既に失われている**ので、ここでできるのは
   * 「失われたと分かるようにする」ことだけ——黙って消えないことが唯一の目的。
   */
  private record(job: Job, reason: string): void {
    this.failed += 1;
    this.undelivered.push({
      seq: job.entry.seq,
      at: this.now(),
      reason,
      preview: job.entry.text.slice(0, 80)
    });
    if (this.undelivered.length > UNDELIVERED_LIMIT) this.undelivered.shift();
    log.warn({ ref: this.ref, seq: job.entry.seq }, `転送を諦めた: ${reason}`);
  }
}

/**
 * 保存形から実行時の秘密を解く。**復号の失敗で監視ごと止めない**——
 * 秘密なしで送って受け手に断られるほうが、キューが溢れるより軽い
 * （`ConfigResolver.resolvePassword` と同じ考え方）。
 */
export function webhookSecret(
  cfg: WebhookConfig,
  decrypt: (enc: string) => string,
  warn: (msg: string) => void
): string | undefined {
  if (cfg.secretEnc !== undefined) {
    try {
      return decrypt(cfg.secretEnc);
    } catch {
      warn("webhook の秘密を復号できませんでした（秘密なしで送ります）");
      return undefined;
    }
  }
  if (cfg.secretEnv !== undefined) {
    const v = process.env[cfg.secretEnv];
    if (v === undefined || v === "") {
      warn(`環境変数 ${cfg.secretEnv} が設定されていません（秘密なしで送ります）`);
      return undefined;
    }
    return v;
  }
  return undefined;
}

/**
 * 解決済みの設定から転送先を組む。**設定が無ければ `undefined`**——
 * 転送を設定していない監視は従来どおり（画面に出すだけ）。
 *
 * 3 か所（起動時の自動開始・WS からの開始・定義の反映）から呼ぶので、
 * **組み立てを 1 か所にする**——散らすと片方だけ転送が効かない、が生える。
 */
export function makeWatchSink(
  ref: string,
  webhook: { config: WebhookConfig; secret?: string } | undefined,
  opts?: WebhookSinkOptions
): WebhookSink | undefined {
  if (!webhook) return undefined;
  return new WebhookSink(ref, webhook.config, webhook.secret, opts);
}

/** `http:` / `https:` の URL か。**保存時に弾く**（実行時に初めて失敗させない） */
export function invalidWebhookUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URL として解釈できません";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `${parsed.protocol} は使えません（http または https）`;
  }
  return undefined;
}
