// 実機で `QSH`（Qshell）を起動し、**どのコマンドで詰まるか**を実測する。
//
// 症状: エミュレーターで qsh を実行すると「待機中」のまま「ホストから応答がない」になる。
// 見立て: 未知のコマンドでレコードの残り（＝READ）ごと捨てて待ちに入っている
// （`wtd-applier.ts` の default 節。同じ轍を WRITE ERROR CODE TO WINDOW で踏んでいる）。
//
// ここで確かめること:
//   1. QSH の画面でホストが送ってくる**コマンド（ESC の次の 1 バイト）の並び**
//   2. 未知のコマンドが来ているか。来ているならその形式（パラメータのバイト数）
//   3. 捨てた後ろに READ があるか（＝キーボードが開かないまま待つ理由）
//
// 実行: AS400_PASSWORD=... node scripts/diag-qsh.mjs
import { readFileSync } from "node:fs";
import { Session5250, TcpTransport } from "@as400web/tn5250";

const log = (s) => process.stderr.write(s + "\n");
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === "実機");
const password = process.env.AS400_PASSWORD;
if (!password) {
  log("AS400_PASSWORD が未設定です");
  process.exit(1);
}
/**
 * 装置名は**短い名前のプールから順に試す**（他のスクリプトと同じ作法）。
 * 使い回すと前ジョブの回復画面が出るため、失敗したら次の名前へ。
 */
// **既に実機へ登録されている名前を使う**（新しい名前は自動構成が無効で拒否される。
// 他のスクリプトが使っている名前と同じプール）
const DEV_POOL = ["WEBSF0", "WEBSF1", "WEBSF2", "WEBSF3", "WEBSF4"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMMAND_NAME = {
  0x11: "WRITE_TO_DISPLAY",
  0x40: "CLEAR_UNIT",
  0x20: "CLEAR_UNIT_ALTERNATE",
  0x50: "CLEAR_FORMAT_TABLE",
  0x42: "READ_INPUT_FIELDS",
  0x52: "READ_MDT_FIELDS",
  0x82: "READ_MDT_FIELDS_ALT",
  0x62: "READ_SCREEN",
  0x64: "READ_SCREEN_EXTENDED",
  0x21: "WRITE_ERROR_CODE",
  0x22: "WRITE_ERROR_CODE_WINDOW",
  0x02: "SAVE_SCREEN",
  0x12: "RESTORE_SCREEN",
  0x23: "ROLL",
  0x03: "SAVE_PARTIAL_SCREEN",
  0x13: "RESTORE_PARTIAL_SCREEN",
  0xf3: "WRITE_STRUCTURED_FIELD"
};

/**
 * レコードの中の ESC＋コマンドを**素朴に**並べる（実装を通さない独立の目）。
 * 実装が捨てている後ろに何があるかを見るのが目的なので、
 * WTD の中身は追わず「ESC の次の 1 バイト」だけを拾う。
 */
function commandsOf(data) {
  const out = [];
  for (let i = 0; i + 1 < data.length; i++) {
    if (data[i] === 0x04) out.push(data[i + 1]);
  }
  return out;
}

/**
 * **ヘッダを飛ばして先頭から ESC を辿る**（データの中の 0x04 を拾わない）。
 * コマンドごとのパラメータ長までは追わないので、WTD の中身に 0x04 があると
 * 拾ってしまう点は同じだが、先頭のコマンドは正しく出る。
 */
function commandsOfRecord(rec) {
  const data = rec.subarray(10, rec.length - 2); // ヘッダ 10 バイト・末尾 IAC EOR
  return commandsOf(data);
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

/** 生レコードを溜める（実装と独立に見るため） */
const records = [];
const warns = [];

/** 1 装置名で接続して**手サインオン**する（他のスクリプトと同じ道） */
async function connectOnce(dev) {
  const real = await TcpTransport.connect({ host: sys.host, port: sys.port ?? 23 });
  const wrapped = {
    start: () => real.start?.(),
    send: (data) => real.send(data),
    onData: (fn) =>
      real.onData((data) => {
        records.push(Uint8Array.from(data));
        fn(data);
      }),
    onClose: (fn) => real.onClose(fn),
    onError: (fn) => real.onError?.(fn),
    close: () => real.close()
  };
  const s = await Session5250.connect({
    transport: wrapped,
    deviceName: dev,
    ccsid: sys.ccsid ?? 37,
    warn: (m) => {
      warns.push(m);
      log("WARN " + m);
    }
  });
  await sleep(1500);
  const inputs = s.snapshot().fields.filter((f) => !f.protected);
  if (inputs.length >= 2) {
    s.setField({ index: inputs[0].index }, sys.signon.user);
    s.setField({ index: inputs[1].index }, password);
    await s.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 15000 });
  }
  await sleep(800);
  // **前ジョブの回復画面を越える**（装置名を使い回すと出る。90＝終了して新しいジョブ）
  for (let i = 0; i < 8; i++) {
    const snap = s.snapshot();
    const txt = snap.cells.map((r) => r.map((c) => c.char).join(""));
    if (txt.some((r) => r.includes("選択項目またはコマンド") || r.includes("メインメニュー"))) return s;
    if (txt.some((r) => r.includes("対話式ジョブの回復"))) {
      const f = snap.fields.filter((x) => !x.protected).slice(-1)[0];
      s.setField({ index: f.index }, "90");
      await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
    } else {
      await s.sendAid("Enter", { timeoutMs: 10000 });
    }
    await sleep(1000);
  }
  s.disconnect();
  throw new Error("コマンド画面へ到達できない");
}

async function connectHost() {
  let last;
  for (let i = 0; i < 8; i++) {
    const dev = DEV_POOL[i % DEV_POOL.length];
    try {
      return await connectOnce(dev);
    } catch (e) {
      last = e;
      log(`connect retry ${i + 1} (${dev}): ${e instanceof Error ? e.message : String(e)}`);
      await sleep(6000);
    }
  }
  throw last;
}

const session = await connectHost();

const text = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/, "")).join("\n");
const cmdField = (snap) =>
  snap.fields.find((f) => !f.protected && f.row >= 19) ?? snap.fields.find((f) => !f.protected);

try {
  let snap = session.snapshot();
  for (let i = 0; i < 3 && !cmdField(snap); i++) {
    snap = (await session.sendAid("Enter", { timeoutMs: 10000 })).screen;
  }
  log("メニュー到達: " + text(snap).split("\n")[0]);

  // --- QSH を起動 ---
  const f = cmdField(snap);
  session.setField({ index: f.index }, "QSH");
  const before = records.length;
  let res;
  try {
    res = await session.sendAid("Enter", { timeoutMs: 15000 });
    log("QSH の応答が返った");
  } catch (e) {
    log(`**QSH の応答が返らない**: ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- 受け取ったレコードを並べる ---
  log("\n==== QSH 実行で届いたレコード ====");
  for (let i = before; i < records.length; i++) {
    const rec = records[i];
    const cmds = commandsOf(rec);
    log(
      `--- record #${i - before + 1}（${rec.length} バイト）: ` +
        cmds.map((c) => `0x${c.toString(16)}=${COMMAND_NAME[c] ?? "**未知**"}`).join(" → ")
    );
    log("    先頭 96 バイト: " + hex(rec.subarray(0, 96)));
    // **未知のコマンドの直後**を見る（パラメータの形式を推定するため）
    for (let p = 0; p + 1 < rec.length; p++) {
      if (rec[p] === 0x04 && COMMAND_NAME[rec[p + 1]] === undefined) {
        log(`    未知 0x${rec[p + 1].toString(16)} の直後 16 バイト: ` + hex(rec.subarray(p + 2, p + 18)));
      }
      // ROLL（0x23）の直後（3 バイトのパラメータを見たい）
      if (rec[p] === 0x04 && rec[p + 1] === 0x23) {
        log(`    ROLL の直後 8 バイト: ` + hex(rec.subarray(p + 2, p + 10)));
      }
    }
  }

  // --- QSH が起動していればコマンドを打ってみる（行送りが起きる場面を通す） ---
  if (res) {
    await sleep(1500);
    let s2 = session.snapshot();
    const qshInput = s2.fields.filter((f) => !f.protected).slice(-1)[0];
    if (qshInput && text(s2).includes("QSH")) {
      log("\n==== QSH の画面（コマンド投入前） ====");
      log(text(s2));
      // **複数行の出力が出るコマンド**を打って、行送り（ROLL）が来るかを見る
      for (const cmd of ["ls -l /", "echo A; echo B; echo C"]) {
        const mark = records.length;
        try {
          const inp = session.snapshot().fields.filter((f) => !f.protected).slice(-1)[0];
          session.setField({ index: inp.index }, cmd);
          await session.sendAid("Enter", { timeoutMs: 20000 });
        } catch (e) {
          log(`\n**${cmd} の応答が返らない**: ` + (e instanceof Error ? e.message : String(e)));
        }
        await sleep(2500);
        log(`\n==== ${cmd} の後（受信 ${records.length - mark} レコード） ====`);
        for (let i = mark; i < records.length; i++) {
          const cmds = commandsOfRecord(records[i]);
          log(`  record: ${cmds.map((c) => `0x${c.toString(16)}=${COMMAND_NAME[c] ?? "**未知**"}`).join(" → ")}`);
        }
        log(text(session.snapshot()));
      }
    }
  }

  // --- F3 で抜けるときに RESTORE PARTIAL SCREEN（0x13）が来る。その生バイトを見る ---
  {
    const mark = records.length;
    try {
      await session.sendAid("F3", { timeoutMs: 15000 });
    } catch (e) {
      log("F3 の応答が返らない: " + (e instanceof Error ? e.message : String(e)));
    }
    await sleep(2000);
    log(`\n==== F3（QSH 終了）で届いたレコード ${records.length - mark} 本 ====`);
    for (let i = mark; i < records.length; i++) {
      const rec = records[i];
      const cmds = commandsOfRecord(rec);
      log(`  record（${rec.length} バイト）: ${cmds.map((c) => `0x${c.toString(16)}`).join(" → ")}`);
      // **0x13 の直後**を見る（パラメータが何バイト続くか）
      for (let p = 10; p + 1 < rec.length; p++) {
        if (rec[p] === 0x04 && rec[p + 1] === 0x13) {
          log(`    ★ ESC 13 の位置 ${p}（ヘッダ後 ${p - 10}）`);
          log(`    直後 32 バイト: ` + hex(rec.subarray(p + 2, p + 34)));
        }
      }
    }
    log("\n==== F3 後の画面 ====");
    log(text(session.snapshot()));
  }

  if (res) {
    log("\n==== 画面 ====");
    log(text(res.screen));
    log(`\nキーボード: ${res.screen.keyboardLocked ? "**ロック**" : "解放"} / fields=${res.screen.fields.length}`);
  } else {
    const s = session.snapshot();
    log("\n==== 応答が無いときの画面 ====");
    log(text(s));
    log(`\nキーボード: ${s.keyboardLocked ? "**ロック**" : "解放"} / fields=${s.fields.length}`);
  }

  log("\n==== 警告 ====");
  for (const w of warns) log("  " + w);
} catch (e) {
  log("ERROR " + (e instanceof Error ? e.message : String(e)));
  log(e?.stack ?? "");
} finally {
  session.disconnect();
}
