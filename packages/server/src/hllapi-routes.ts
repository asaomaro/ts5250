/**
 * HLLAPI ブリッジの入口（`POST /api/hllapi`）。
 *
 * **Rust の接続層はここだけを叩く。** HLLAPI の 1 呼び出しが HTTP 1 往復に対応する
 * （`spec.md` 設計方針 1）。同期 API を非同期のサーバーへ写すのに、
 * 相関も接続の使い回しも要らない形にしてある。
 *
 * 認可は他の `/api/host/*` と同じ——接続を持つ利用者なら誰でも。
 * 見える範囲は `SessionManager` が利用者で絞る。
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AuthVars } from "./auth.js";
import type { SessionManager } from "./session-manager.js";
import { callHllapi, HllapiState, type HllapiDeps } from "./hllapi.js";
import { HRC } from "./hllapi-types.js";
import { childLog } from "./log.js";

const log = childLog({ component: "hllapi" });

/**
 * `data` の上限。PS 全体（27x132 = 3,564）より大きい要求は受けない。
 * 青天井にするとメモリを掴ませられる。
 */
const MAX_DATA = 8192;

const requestSchema = z
  .object({
    function: z.number().int().min(0).max(9999),
    /** 呼び出し側のバッファ（**CP932 バイト列の base64**）。文字列で運ばない理由は `hllapi-types.ts` */
    dataB64: z.string().max(MAX_DATA * 2).optional(),
    length: z.number().int().min(0).max(MAX_DATA).optional(),
    pos: z.number().int().min(0).max(1_000_000).optional()
  })
  .strict();

export interface HllapiRouteDeps {
  sessions: SessionManager;
  /** 呼び出しをまたぐ状態（短縮名の対応表・論理カーソル） */
  state?: HllapiState;
}

export function registerHllapiRoutes(app: Hono<{ Variables: AuthVars }>, deps: HllapiRouteDeps): void {
  const state = deps.state ?? new HllapiState();
  const hdeps: HllapiDeps = { sessions: deps.sessions, state };

  app.post("/api/hllapi", async (c) => {
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      // **HLLAPI の語彙で返す。** HTTP の 400 だけだと呼び出し側が rc を作れない
      return c.json({ rc: HRC.PARAMETER_ERROR }, 200);
    }
    const user = c.get("user");
    const req = {
      function: parsed.data.function,
      dataB64: parsed.data.dataB64 ?? "",
      length: parsed.data.length ?? 0,
      pos: parsed.data.pos ?? 0
    };
    try {
      const res = await callHllapi(hdeps, req, user);
      // **バッファの中身をログに出さない**——サインオン画面への入力が通る（spec「秘密の扱い」）
      log.debug(`hllapi function=${req.function} rc=${res.rc}`);
      return c.json(res);
    } catch (e) {
      log.debug(`hllapi function=${req.function} failed: ${String(e)}`);
      return c.json({ rc: HRC.SYSTEM_ERROR });
    }
  });
}
