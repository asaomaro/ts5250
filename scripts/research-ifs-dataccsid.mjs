// IFS に新規作成するファイルのタグ（CCSID）が `dataCcsid` で決まるかを実機で確かめる。
//
// 現状はサーバー既定（0）で開くため、**UTF-8 を書いても 850 のタグが付く**
// （`20260720` research F3）。読む側は決定表①（中身推定）で救えているが、
// 他ツールから見ると嘘のタグのまま。
//
// **`dataCcsid` は受け口があるだけで、実機が採用するかを測っていない**——それを測る。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env --env-file=.env.verify \
//         scripts/research-ifs-dataccsid.mjs
//
// 副作用: /home/USER 配下にファイルを数個作り、**最後に消す**。
import { IfsConnection } from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

const DIR = process.env.AS400_IFS_DIR ?? `/home/${user}`;
const log = (s) => process.stdout.write(s + "\n");
const utf8 = (s) => new TextEncoder().encode(s);

const made = [];
const conn = await IfsConnection.connect({ host, user, password });
try {
  /** 書いて、タグを読み直す */
  async function writeAndTag(name, data, opts) {
    const path = `${DIR}/${name}`;
    await conn.writeFile(path, data, { create: true, ...opts });
    if (!made.includes(path)) made.push(path);
    const got = await conn.readTextFile(path);
    return { path, tag: got.ccsid, bytes: got.data.length };
  }

  log("### 1. dataCcsid を指定しない（現状の既定経路）");
  {
    const r = await writeAndTag("aidev-tag-none.txt", utf8("hello 日本語\n"), {});
    log(`  ${r.path} → タグ=${r.tag ?? "なし"} / ${r.bytes} バイト`);
    log(`  → ${r.tag === 1208 ? "1208（中身どおり）" : `**${r.tag}**（中身は UTF-8 なのに）`}`);
  }

  log("\n### 2. dataCcsid=1208（UTF-8）を指定する");
  {
    const r = await writeAndTag("aidev-tag-1208.txt", utf8("hello 日本語\n"), { dataCcsid: 1208 });
    log(`  ${r.path} → タグ=${r.tag ?? "なし"} / ${r.bytes} バイト`);
    log(`  → ${r.tag === 1208 ? "**採用された**" : "採用されない"}`);
  }

  log("\n### 3. dataCcsid=1399（EBCDIC 日本語）を指定する");
  {
    // 中身は問わない（タグが付くかだけを見る）
    const r = await writeAndTag("aidev-tag-1399.txt", Uint8Array.from([0xc8, 0xc5, 0xd3, 0xd3, 0xd6, 0x15]), {
      dataCcsid: 1399
    });
    log(`  ${r.path} → タグ=${r.tag ?? "なし"} / ${r.bytes} バイト`);
    log(`  → ${r.tag === 1399 ? "**採用された**" : "採用されない"}`);
  }

  log("\n### 4. 既存ファイルを別の dataCcsid で上書きする（タグは変わるか）");
  {
    const name = "aidev-tag-1208.txt";
    const before = (await conn.readTextFile(`${DIR}/${name}`)).ccsid;
    const r = await writeAndTag(name, utf8("overwritten\n"), { dataCcsid: 1399 });
    log(`  上書き前=${before} → 上書き後=${r.tag}`);
    log(`  → ${r.tag === before ? "**変わらない**（既存のタグは保たれる）" : "変わった（要注意）"}`);
  }
} finally {
  for (const p of made) {
    try { await conn.deleteFile(p); log(`  片付け: ${p} を削除`); } catch (e) { log(`  片付け失敗: ${p} ${e?.message ?? e}`); }
  }
  conn.close();
}
