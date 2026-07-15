// 自動サインオン→メニュー→DSPJOB→F3 復帰 の trace を採取（回帰資産・tx 伏字化）。
import { writeFileSync, appendFileSync } from "node:fs";
import { Session5250, TcpTransport, TraceRecorder } from "@as400web/core";
const user=process.env.PUB400_USER, password=process.env.PUB400_PASSWORD;
const out="packages/core/test/fixtures/pub400-jobinfo.jsonl";
const log=(s)=>process.stderr.write(s+"\n");
writeFileSync(out,"");
const rec=new TraceRecorder((l)=>appendFileSync(out,l+"\n"));
const inner=await TcpTransport.connect({host:"pub400.com",port:23});
const tr={ send(d){rec.tx(d);inner.send(d);}, close(){inner.close();},
  onData(f){inner.onData((d)=>{rec.rx(d);f(d);});}, onClose(f){inner.onClose(f);}, onError(f){inner.onError(f);} };
const s=await Session5250.connect({transport:tr,deviceName:"WEBEMU01",user,password,warn:(w)=>log("WARN:"+w)});
const info=await s.fetchJobInfo();
log("jobInfo captured: name="+info.name+" user="+info.user+" (number masked in log)");
s.disconnect();
await new Promise(r=>setTimeout(r,300));
log("saved: "+out);
process.exit(0);
