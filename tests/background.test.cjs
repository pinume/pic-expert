const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, assets } = require("./background-harness.cjs");

test("concurrent starts create one task", async () => {
  const h = harness();
  const results = await Promise.all([h.begin(), h.begin()]);
  assert.equal(results.filter(r => r.ok).length, 1);
});
test("duplicate pair messages download one correctly named pair", async () => {
  const h = harness(), { task } = await h.begin();
  const responses = await Promise.all([h.pair(task.id), h.pair(task.id)]);
  assert.ok(responses.every(r => r.ok));
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0].filename, /\/R1\/SN码\.jpg$/);
  assert.match(h.calls[1].filename, /\/R1\/发票\.png$/);
  assert.ok((await h.pair(task.id)).ok);
  assert.equal(h.calls.length, 2);
});
test("date range prefixes every new task download path", async () => {
  const h = harness(), { task } = await h.begin(["20260101", "20260131"]);
  assert.equal(task.folderName, "20260101-20260131_" + task.id);
  await h.pair(task.id);
  await h.send({ type: "PIC_EXPERT_TASK_END", taskId: task.id, status: "completed" });
  await h.send({ type: "PIC_EXPERT_LOG_EXPORT" }, {});
  assert.ok(h.calls.length >= 4);
  assert.ok(h.calls.every(call => call.filename.startsWith("pic-expert/20260101-20260131_" + task.id + "/")));
});
test("legacy task logs keep using the task ID folder", async () => {
  const initial = { id: "OLD", status: "completed", logs: [{ time: "2026-10-05", level: "info", stage: "test", message: "old" }] };
  const h = harness({}, initial);
  await h.send({ type: "PIC_EXPERT_LOG_EXPORT" }, {});
  assert.equal(h.calls[0].filename, "pic-expert/OLD/运行日志-001.txt");
});
test("new task creation rejects missing or malformed trade date ranges", async () => {
  const h = harness();
  assert.equal((await h.begin(null)).ok, false);
  assert.equal((await h.begin(["2026/01/01", "20260131"])).ok, false);
  assert.equal((await h.begin([20260101, "20260131"])).ok, false);
});
test("messages from another frame cannot download", async () => {
  const h = harness(), { task } = await h.begin();
  const response = await h.send({ type: "PIC_EXPERT_DOWNLOAD_PAIR", taskId: task.id, orderNo: "O1", referenceNo: "R1", assets }, { tab: { id: 7 }, frameId: 0 });
  assert.equal(response.ok, false);
  assert.equal(h.calls.length, 0);
});
test("failed invoice rolls back the pair and never marks success", async () => {
  const h = harness({ failInvoice: true }), { task } = await h.begin();
  assert.equal((await h.pair(task.id)).ok, false);
  assert.equal(h.task().downloads.R1.status, "failed");
  assert.deepEqual(h.removed, [1]);
  assert.deepEqual(h.task().downloads.R1.files, {});
});
test("failed rollback retains the actual leftover path", async () => {
  const h = harness({ failInvoice: true, failRemove: true }), { task } = await h.begin();
  const response = await h.pair(task.id);
  assert.equal(response.ok, false);
  assert.match(response.files["SN码"].filename, /SN码\.jpg$/);
});
test("reference cannot be reused for a different order", async () => {
  const h = harness(), { task } = await h.begin();
  await h.pair(task.id);
  const result = await h.send({ type: "PIC_EXPERT_DOWNLOAD_PAIR", taskId: task.id, orderNo: "O2", referenceNo: "R1", assets });
  assert.equal(result.ok, false);
  assert.equal(h.calls.length, 2);
});
test("duplicate end messages produce one manifest", async () => {
  const h = harness(), { task } = await h.begin();
  await h.pair(task.id);
  const end = { type: "PIC_EXPERT_TASK_END", taskId: task.id, status: "completed" };
  await Promise.all([h.send(end), h.send(end)]);
  await h.send(end);
  assert.equal(h.calls.filter(c => c.filename.endsWith(".csv")).length, 1);
  assert.equal(h.task().status, "completed");
  assert.equal(h.task().manifestRows[0].result, "成功");
});
test("manifest failure preserves terminal state and permits next task", async () => {
  const h = harness({ failManifest: true }), { task } = await h.begin();
  await h.send({ type: "PIC_EXPERT_TASK_END", taskId: task.id, status: "failed", error: "navigation_failed" });
  assert.equal(h.task().status, "failed");
  assert.match(h.task().manifestError, /清单下载失败/);
  assert.ok((await h.begin()).ok);
});
test("stop interrupts an ongoing pair and cleans it before finalizing", async () => {
  const h = harness({ holdPair: true }), { task } = await h.begin();
  const download = h.pair(task.id);
  while (!h.task().downloads.R1?.files["SN码"]) await new Promise(setImmediate);
  const stopped = await h.send({ type: "PIC_EXPERT_TASK_STOP" }, {});
  assert.ok(stopped.ok);
  assert.equal((await download).ok, false);
  assert.equal(h.task().status, "failed");
  assert.equal(h.task().manifestRows[0].result, "失败");
  assert.deepEqual(h.task().downloads.R1.files, {});
});

test("a stopped task is recoverable after worker restart during finalization", async () => {
  const initial = { id:"T1",status:"finalizing",finalStatus:"completed",finishedAt:"2026-10-04",
    tabId:7,frameId:4,manifestRows:[],downloads:{},scanned:0,completed:0,skipped:0,failed:0 };
  const h = harness({}, initial);
  assert.equal((await h.send({type:"PIC_EXPERT_TASK_STOP"},{})).task.status, "failed");
  assert.ok((await h.begin()).ok);
});

function interruptedTask(result = "失败") {
  return {id:"T1", status:"running", tabId:7, frameId:4, scanned:1, completed:0, skipped:0, failed:1,
    manifestRows:[{orderNo:"O1",referenceNo:"R1",result,reason:"页面中断",snFile:"",invoiceFile:""}],
    downloads:{R1:{orderNo:"O1",status:"pending",files:{"SN码":{downloadId:1,filename:"pic-expert/T1/R1/SN码.jpg"}}}}};
}
test("worker recovery reconciles leftover files and logs paths omitted from CSV", async () => {
  const h = harness({failRemove:true}, interruptedTask());
  await h.send({type:"PIC_EXPERT_TASK_STOP"},{});
  const rows = h.task().manifestRows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].snFile, "pic-expert/T1/R1/SN码.jpg");
  assert.equal(rows[0].invoiceFile, "");
  assert.equal(rows[0].result, "失败");
  assert.match(rows[0].reason, /页面中断.*部分文件无法清理/);
  assert.ok(h.task().logs.some(entry => entry.stage === "残留文件" && entry.message.includes(rows[0].snFile)));
  assert.doesNotMatch(decodeURIComponent(h.calls[0].url), /SN码.jpg/);
  assert.equal(h.task().failed, 1);
});
test("rolled-back pair clears stale paths and success from an existing row", async () => {
  const initial = interruptedTask("成功");
  initial.manifestRows[0].snFile = "stale-path.jpg";
  const h = harness({}, initial);
  await h.send({type:"PIC_EXPERT_TASK_STOP"},{});
  assert.equal(h.task().manifestRows[0].result, "失败");
  assert.equal(h.task().manifestRows[0].snFile, "");
  assert.equal(h.task().completed, 0);
});
test("complete files retain a separately recorded failure reason", async () => {
  const initial = interruptedTask();
  initial.downloads.R1.status = "complete";
  const h = harness({}, initial);
  await h.send({type:"PIC_EXPERT_TASK_STOP"},{});
  assert.equal(h.task().manifestRows[0].result, "失败");
  assert.equal(h.task().manifestRows[0].reason, "页面中断");
  assert.match(h.task().manifestRows[0].snFile, /SN码.jpg$/);
});
test("retry clears obsolete CSV error when native download already completed", async () => {
  const h = harness({failManifest:true}), {task} = await h.begin();
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"completed"});
  h.items.get(h.task().manifestDownloadId).state = "complete";
  const response = await h.send({type:"PIC_EXPERT_MANIFEST_RETRY"},{});
  assert.equal(response.task.manifestError, "");
  assert.equal(h.task().manifestError, "");
  assert.equal(h.calls.length, 1);
});
test("retry waits for in-progress CSV and clears persisted error on completion", async () => {
  const h = harness({failManifest:true}), {task} = await h.begin();
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"completed"});
  const item = h.items.get(h.task().manifestDownloadId);
  item.state = "in_progress";
  setImmediate(() => { item.state = "complete"; });
  const response = await h.send({type:"PIC_EXPERT_MANIFEST_RETRY"},{});
  assert.equal(response.task.manifestError, "");
  assert.equal(h.calls.length, 1);
});
test("task logs survive worker restart and are bounded to the latest 500 entries", async () => {
  const h = harness(), {task} = await h.begin();
  for (let i = 0; i < 505; i++) {
    assert.ok((await h.send({type:"PIC_EXPERT_LOG",taskId:task.id,stage:"日期控件",message:String(i)})).ok);
  }
  const saved = h.task(), restarted = harness({}, saved);
  const current = (await restarted.send({type:"PIC_EXPERT_TASK_STATE"},{})).task;
  assert.equal(current.logs.length, 500);
  assert.equal(current.logs[0].message, "5");
  assert.equal(current.logs.at(-1).message, "504");
  assert.ok(current.logs.every(entry => !Number.isNaN(Date.parse(entry.time))));
});
test("diagnostic log messages reject wrong task and frame", async () => {
  const h = harness(), {task} = await h.begin(), before = h.task().logs.length;
  assert.equal((await h.send({type:"PIC_EXPERT_LOG",taskId:"old",message:"invalid"})).ok, false);
  assert.equal((await h.send({type:"PIC_EXPERT_LOG",taskId:task.id,message:"invalid"},{tab:{id:7},frameId:0})).ok, false);
  assert.equal(h.task().logs.length, before);
});
test("paired downloads and CSV completion are persisted in task logs", async () => {
  const h = harness(), {task} = await h.begin();
  await h.pair(task.id);
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"completed"});
  const logs = h.task().logs;
  assert.equal(logs.filter(entry => entry.stage === "下载图片").length, 2);
  assert.ok(logs.some(entry => entry.stage === "配对完成"));
  assert.ok(logs.some(entry => entry.stage === "下载清单" && entry.message.includes("清单已下载")));
});
const proofAssets = {...assets,"证明材料图一":assets["SN码"],"证明材料图二":assets["发票"],"证明材料图三":assets["SN码"]};
test("duplicate messages download five files once and export a four-column CSV", async () => {
  const h = harness(), {task} = await h.begin();
  const message = {type:"PIC_EXPERT_DOWNLOAD_PAIR",taskId:task.id,orderNo:"O1",referenceNo:"R1",assets:proofAssets};
  const results = await Promise.all([h.send(message),h.send(message)]);
  assert.ok(results.every(r => r.ok));
  assert.equal(h.calls.length, 5);
  assert.match(h.calls[2].filename, /\/R1\/证明材料图一.jpg$/);
  assert.match(h.calls[3].filename, /\/R1\/证明材料图二.png$/);
  assert.match(h.calls[4].filename, /\/R1\/证明材料图三.jpg$/);
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"completed"});
  assert.equal(h.task().manifestRows[0].proof2File, h.calls[3].filename);
  assert.equal(decodeURIComponent(h.calls[5].url).split(",").slice(1).join(","), "\uFEFF订单号,参考号,处理结果,原因\r\nO1,R1,成功,");
});
test("failed proof image rolls back required and optional files and never succeeds", async () => {
  const h = harness({failProof:"证明材料图二"}), {task} = await h.begin();
  const response = await h.send({type:"PIC_EXPERT_DOWNLOAD_PAIR",taskId:task.id,orderNo:"O1",referenceNo:"R1",assets:proofAssets});
  assert.equal(response.ok, false);
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.removed, [1,2,3]);
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"completed"});
  assert.equal(h.task().manifestRows[0].result, "失败");
  assert.equal(h.task().manifestRows[0].proof1File, "");
});
test("failed proof cleanup retains its path in the manifest", async () => {
  const h = harness({failProof:"证明材料图二",failRemoveId:3}), {task} = await h.begin();
  await h.send({type:"PIC_EXPERT_DOWNLOAD_PAIR",taskId:task.id,orderNo:"O1",referenceNo:"R1",assets:proofAssets});
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"failed"});
  assert.match(h.task().manifestRows[0].proof1File, /证明材料图一.jpg$/);
  assert.equal(h.task().manifestRows[0].snFile, "");
});
test("missing required pair or invalid optional format creates no downloads", async () => {
  const h = harness(), {task} = await h.begin();
  for (const value of [{"证明材料图一":assets["SN码"]},{...assets,"证明材料图一":{extension:".html",url:"data:text/html;base64,AA=="}}]) {
    assert.equal((await h.send({type:"PIC_EXPERT_DOWNLOAD_PAIR",taskId:task.id,orderNo:"O1",referenceNo:"R1",assets:value})).ok, false);
  }
  assert.equal(h.calls.length, 0);
});
const checkpoint = {url:"https://portal.test/app#/auditOfTrade2026",page:1,total:2,signature:"O1::R1\nO2::R2",filters:[],visitedBefore:0};
const saveCheckpoint = (h,id) => h.send({type:"PIC_EXPERT_CHECKPOINT",taskId:id,checkpoint});
test("graceful pause preserves the task directory and completed files without exporting partial CSV", async () => {
  const h=harness({livePage:true}),{task}=await h.begin();
  await saveCheckpoint(h,task.id); await h.pair(task.id);
  await h.send({type:"PIC_EXPERT_MANIFEST_ROW",taskId:task.id,row:{orderNo:"O1",referenceNo:"R1",result:"成功",reason:""}});
  await h.send({type:"PIC_EXPERT_TASK_PAUSE"},{});
  assert.equal(h.task().status,"pausing");
  await h.send({type:"PIC_EXPERT_TASK_PAUSED",taskId:task.id});
  assert.equal(h.task().status,"paused");
  assert.equal(h.calls.length,2);
  const resumed=await h.send({type:"PIC_EXPERT_TASK_RESUME",tabId:7,frameId:4},{});
  assert.equal(resumed.task.id,task.id);
  assert.equal(resumed.task.folderName,task.folderName);
  assert.equal(resumed.task.completed,1);
  assert.equal((await h.send({type:"PIC_EXPERT_ROW_STATUS",taskId:task.id,identity:{orderNo:"O1",referenceNo:"R1"}})).done,true);
});
test("worker restart preserves completed rows and can rebind continuation to a new frame", async () => {
  const h=harness(),{task}=await h.begin(); await saveCheckpoint(h,task.id); await h.pair(task.id);
  await h.send({type:"PIC_EXPERT_MANIFEST_ROW",taskId:task.id,row:{orderNo:"O1",referenceNo:"R1",result:"成功",reason:""}});
  await h.send({type:"PIC_EXPERT_TASK_PAUSE"},{});
  const restarted=harness({store:h.store,items:h.items});
  assert.ok((await restarted.send({type:"PIC_EXPERT_TASK_RESUME",tabId:7,frameId:9},{})).ok);
  assert.equal((await restarted.pair(task.id)).ok,false);
  const response=await restarted.send({type:"PIC_EXPERT_ROW_STATUS",taskId:task.id,identity:{orderNo:"O1",referenceNo:"R1"}},{tab:{id:7},frameId:9});
  assert.equal(response.done,true);
  assert.equal(restarted.calls.length,0);
});
test("missing completed files are redownloaded rather than blindly skipped", async () => {
  const h=harness(),{task}=await h.begin(); await saveCheckpoint(h,task.id); await h.pair(task.id);
  await h.send({type:"PIC_EXPERT_MANIFEST_ROW",taskId:task.id,row:{orderNo:"O1",referenceNo:"R1",result:"成功",reason:""}});
  h.items.get(1).exists=false;
  assert.equal((await h.send({type:"PIC_EXPERT_ROW_STATUS",taskId:task.id,identity:{orderNo:"O1",referenceNo:"R1"}})).done,false);
  assert.ok((await h.pair(task.id)).ok);
  assert.equal(h.calls.length,4);
});
test("failed pair is only retried after explicit continuation, never by duplicate messages", async () => {
  const options={failInvoice:true}, h=harness(options),{task}=await h.begin(); await saveCheckpoint(h,task.id);
  assert.equal((await h.pair(task.id)).ok,false);
  assert.equal((await h.pair(task.id)).ok,false);
  assert.equal(h.calls.length,2);
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"failed"});
  await h.send({type:"PIC_EXPERT_TASK_RESUME",tabId:7,frameId:4},{});
  options.failInvoice=false;
  assert.ok((await h.pair(task.id)).ok);
  await h.send({type:"PIC_EXPERT_MANIFEST_ROW",taskId:task.id,row:{orderNo:"O1",referenceNo:"R1",result:"成功",reason:""}});
  assert.equal(h.task().scanned,1);
  assert.equal(h.task().completed,1);
  assert.equal(h.task().failed,0);
});
test("force pause cleans an in-flight pair and retains a resumable checkpoint", async () => {
  const options={livePage:true,holdPair:true},h=harness(options),{task}=await h.begin();
  await saveCheckpoint(h,task.id); const download=h.pair(task.id);
  while(!h.task().downloads.R1?.files["SN码"]) await new Promise(setImmediate);
  await h.send({type:"PIC_EXPERT_TASK_PAUSE"},{});
  assert.equal(h.task().status,"pausing");
  await h.send({type:"PIC_EXPERT_TASK_PAUSE"},{});
  assert.equal((await download).ok,false);
  await h.send({type:"PIC_EXPERT_TASK_PAUSED",taskId:task.id});
  assert.equal(h.task().status,"paused");
  assert.deepEqual(h.task().downloads.R1.files,{});
  assert.equal(h.calls.some(c=>c.filename.endsWith(".csv")),false);
  assert.ok(h.task().checkpoint);
});
test("large-task log updates write bounded metadata and popup responses contain no order arrays", async () => {
  const rows=Array.from({length:20000},(_,i)=>({orderNo:"O"+i,referenceNo:"R"+i,result:"成功"}));
  const h=harness({}, {id:"T1",status:"running",tabId:7,frameId:4,manifestRows:rows,downloads:{}});
  await h.send({type:"PIC_EXPERT_LOG",taskId:"T1",stage:"测试",message:"small update"});
  const write=h.store.writes.at(-1);
  assert.equal(write.rows,0); assert.equal(write.pairs,0); assert.ok(write.metadataBytes<1000);
  const current=(await h.send({type:"PIC_EXPERT_TASK_STATE"},{})).task;
  assert.equal(current.manifestRows,undefined); assert.equal(current.downloads,undefined);
  assert.equal(current.completed,20000);
});
test("full-log export includes early entries beyond the popup's 500-row window", async () => {
  const h=harness(),{task}=await h.begin();
  await h.store.save(await h.store.getTask(),{logs:Array.from({length:520},(_,i)=>({time:"2026-10-05",level:"info",stage:"test",message:"entry-"+i}))});
  await h.send({type:"PIC_EXPERT_LOG_EXPORT"},{});
  const text=decodeURIComponent(h.calls[0].url);
  assert.match(text,/entry-0\n/); assert.match(text,/entry-519/);
  assert.ok((await h.store.logs(task.id,Infinity)).length>500);
});
test("checkpoint page offsets are preserved on resume and advance only after confirmed paging", async () => {
  const h=harness(),{task}=await h.begin();
  await saveCheckpoint(h,task.id);
  await h.send({type:"PIC_EXPERT_CHECKPOINT",taskId:task.id,checkpoint:{...checkpoint,visitedBefore:1}});
  assert.equal(h.task().checkpoint.visitedBefore,0);
  await h.send({type:"PIC_EXPERT_CHECKPOINT",taskId:task.id,checkpoint:{...checkpoint,page:2,visitedBefore:20}});
  assert.equal(h.task().checkpoint.visitedBefore,20);
});
test("full-log export splits large logs into bounded segments with no omissions", async () => {
  const h=harness(),{task}=await h.begin();
  await h.store.save(await h.store.getTask(),{logs:Array.from({length:5100},(_,i)=>({time:"2026-10-05",level:"info",stage:"test",message:"row-"+i}))});
  await h.send({type:"PIC_EXPERT_LOG_EXPORT"},{});
  assert.equal(h.calls.length,2);
  const text=h.calls.map(call=>decodeURIComponent(call.url)).join("\n");
  assert.equal((text.match(/row-\d+/g)||[]).length,5100);
  assert.match(h.calls[0].filename,/运行日志-001.txt$/);
  assert.match(h.calls[1].filename,/运行日志-002.txt$/);
});
test("native completion events release waiters and listeners are removed afterward", async () => {
  const h=harness({holdPair:true}),{task}=await h.begin(),download=h.pair(task.id);
  while(!h.task().downloads.R1?.files["SN码"]) await new Promise(setImmediate);
  h.notify(1,"complete");
  while(!h.task().downloads.R1?.files["发票"]) await new Promise(setImmediate);
  h.notify(2,"complete");
  assert.ok((await download).ok);
  assert.equal(h.handlers.size,0);
});
test("concurrent manifest retries start only one replacement CSV download", async () => {
  const options={failManifest:true},h=harness(options),{task}=await h.begin();
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"completed"});
  options.failManifest=false;
  await Promise.all([h.send({type:"PIC_EXPERT_MANIFEST_RETRY"},{}),h.send({type:"PIC_EXPERT_MANIFEST_RETRY"},{})]);
  assert.equal(h.calls.length,2);
  assert.equal(h.task().manifestError,"");
});
test("force-pause cleanup blocks new tasks until pending downloads settle", async () => {
  const h=harness({livePage:true,holdPair:true}),{task}=await h.begin();
  await saveCheckpoint(h,task.id); const download=h.pair(task.id);
  while(!h.task().downloads.R1?.files["SN码"]) await new Promise(setImmediate);
  await h.send({type:"PIC_EXPERT_TASK_PAUSE"},{});
  const pause=h.send({type:"PIC_EXPERT_TASK_PAUSE"},{});
  while(!h.task().forcePause) await new Promise(setImmediate);
  assert.equal((await h.begin()).ok,false);
  await pause; await download;
  await h.send({type:"PIC_EXPERT_TASK_PAUSED",taskId:task.id});
  assert.equal(h.task().status,"paused");
});

test("continuation retains locked leftovers and retries after the user removes them", async () => {
  const options = { failInvoice: true, failRemove: true };
  const h = harness(options), { task } = await h.begin();
  await saveCheckpoint(h, task.id);
  assert.equal((await h.pair(task.id)).ok, false);
  await h.send({ type: "PIC_EXPERT_TASK_END", taskId: task.id, status: "failed" });
  await h.send({ type: "PIC_EXPERT_TASK_RESUME", tabId: 7, frameId: 4 }, {});
  options.failInvoice = false;
  const before = h.calls.length;
  assert.equal((await h.pair(task.id)).ok, false);
  assert.equal(h.calls.length, before);
  assert.ok(h.task().downloads.R1.files["SN码"]);
  await h.send({ type: "PIC_EXPERT_TASK_END", taskId: task.id, status: "failed" });
  h.items.get(1).exists = false;
  await h.send({ type: "PIC_EXPERT_TASK_RESUME", tabId: 7, frameId: 4 }, {});
  assert.equal((await h.pair(task.id)).ok, true);
  assert.equal(h.task().downloads.R1.status, "complete");
  assert.ok(h.task().downloads.R1.files["SN码"].downloadId !== 1);
});

test("failed cancellation retains the in-progress download and logs its path", async () => {
  const h = harness({ holdPair: true, failCancel: true }), { task } = await h.begin();
  const download = h.pair(task.id);
  while (!h.task().downloads.R1?.files["SN码"]) await new Promise(setImmediate);
  await h.send({ type: "PIC_EXPERT_TASK_STOP" }, {});
  assert.equal((await download).ok, false);
  assert.ok(h.task().downloads.R1.files["SN码"]);
  assert.equal(h.items.get(1).state, "in_progress");
  assert.ok(h.task().logs.some(entry => entry.stage === "残留文件" && entry.message.includes("SN码.jpg")));
});

test("missing download history does not claim that an unknown file was removed", async () => {
  const initial = interruptedTask();
  const h = harness({ items: new Map() }, initial);
  await h.send({ type: "PIC_EXPERT_TASK_STOP" }, {});
  assert.ok(h.task().downloads.R1.files["SN码"]);
  assert.match(h.task().manifestRows[0].reason, /无法清理/);
});

test("worker restart reconciles every in-flight identity and retains completed rows", async () => {
  const identities = [1, 2, 3].map(n => ({ orderNo: "O" + n, referenceNo: "R" + n, page: 2 }));
  const h = harness({}, { id: "T1", status: "running", tabId: 7, frameId: 4, page: 2, currentRows: identities,
    manifestRows: [{ orderNo: "O0", referenceNo: "R0", result: "成功", page: 1 }],
    downloads: { R1: { orderNo: "O1", status: "pending", files: { "SN码": { downloadId: 1, filename: "SN码.jpg" } } } } });
  await h.send({ type: "PIC_EXPERT_TASK_PAUSE" }, {});
  assert.equal(h.task().status, "paused");
  assert.deepEqual([h.task().scanned, h.task().completed, h.task().failed, h.task().currentRows.length], [4, 1, 3, 0]);
  assert.ok(h.task().manifestRows.filter(row => row.result === "失败").every(row => row.page === 2));
  assert.deepEqual(h.task().downloads.R1.files, {});
});

test("duplicate row messages do not occupy extra slots or double count results", async () => {
  const h = harness(), { task } = await h.begin();
  const identity = { orderNo: "O1", referenceNo: "R1" };
  await Promise.all(Array.from({ length: 3 }, () => h.send({ type: "PIC_EXPERT_ROW_BEGIN", taskId: task.id, identity })));
  assert.equal(h.task().currentRows.length, 1);
  const row = { ...identity, result: "跳过", reason: "材料修改" };
  await Promise.all(Array.from({ length: 3 }, () => h.send({ type: "PIC_EXPERT_MANIFEST_ROW", taskId: task.id, row })));
  assert.deepEqual([h.task().currentRows.length, h.task().scanned, h.task().skipped], [0, 1, 1]);
});

test("recovery retains material modification notes for completed numbered files and orders interrupted before saving", async () => {
  for (const saved of [false, true]) {
    const h = harness(), { task } = await h.begin();
    const identity = { orderNo: "O1", referenceNo: "R1" };
    await h.send({ type: "PIC_EXPERT_ROW_BEGIN", taskId: task.id, identity, note: "材料修改" });
    if (saved) {
      const result = await h.send({ type: "PIC_EXPERT_DOWNLOAD_PAIR", taskId: task.id, ...identity, note: "材料修改",
        assets: { "SN码-2": assets["SN码"], "发票": assets["发票"], "SN码-1": assets["SN码"] } });
      assert.equal(result.ok, true);
      assert.deepEqual(h.calls.map(call => call.filename.split("/").at(-1)), ["SN码-1.jpg", "SN码-2.jpg", "发票.png"]);
    }
    const restarted = harness({ store: h.store, items: h.items });
    await restarted.send({ type: "PIC_EXPERT_TASK_STOP" }, {});
    const result = h.task().manifestRows[0];
    assert.equal(result.result, saved ? "成功" : "失败");
    assert.match(result.reason, /材料修改/);
    if (saved) assert.equal(result.reason, "材料修改");
    else assert.match(result.reason, /用户停止/);
    assert.match(decodeURIComponent(restarted.calls[0].url), /材料修改/);
  }
});

test("continuation rechecks orders skipped by removed rules and keeps genuine missing-image skips", async () => {
  for (const [reason, done] of [["材料修改", false], ["SN码或发票图片缺失或不唯一", false], ["SN码或发票图片缺失", true]]) {
    const h = harness({}, { id: "T1", status: "running", tabId: 7, frameId: 4,
      manifestRows: [{ orderNo: "O1", referenceNo: "R1", result: "跳过", reason }] });
    const result = await h.send({ type: "PIC_EXPERT_ROW_STATUS", taskId: "T1", identity: { orderNo: "O1", referenceNo: "R1" } });
    assert.equal(result.ok, true);
    assert.equal(result.done, done);
  }
});
