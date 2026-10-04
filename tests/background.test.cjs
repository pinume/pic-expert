const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../core.js");
const sender = { tab: { id: 7 }, frameId: 4 };
const assets = { "SN码": { extension: ".jpg", url: "data:image/jpeg;base64,/9j/" },
  "发票": { extension: ".png", url: "data:image/png;base64,iVBORw==" } };
function harness(options = {}, initial = null) {
  let listener, stored = initial;
  const calls = [], removed = [], items = new Map();
  const chrome = {
    storage: { local: {
      get: async () => ({ picExpertTask: structuredClone(stored) }),
      set: async value => { stored = structuredClone(value.picExpertTask); }
    } },
    runtime: { onMessage: { addListener: f => { listener = f; } } },
    tabs: { sendMessage: async () => ({ ok: true }) },
    downloads: {
      download: async args => {
        const id = calls.length + 1;
        calls.push(args);
        const failed = (options.failInvoice && args.filename.includes("发票")) ||
          (options.failManifest && args.filename.endsWith(".csv"));
        items.set(id, { id, state: failed ? "interrupted" : options.holdPair && !args.filename.endsWith(".csv") ? "in_progress" : "complete", error: failed ? "NETWORK_FAILED" : undefined });
        return id;
      },
      search: async ({ id }) => items.has(id) ? [items.get(id)] : [],
      cancel: async id => { if (items.has(id)) items.get(id).state = "interrupted"; },
      removeFile: async id => {
        if (options.failRemove && id === 1) throw new Error("file_locked");
        removed.push(id);
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), {
    chrome, importScripts() {}, PIC_EXPERT_CORE: core, setTimeout, Date, Map
  });
  const send = (message, source = sender) => new Promise(resolve => listener(message, source, resolve));
  const begin = () => send({ type: "PIC_EXPERT_TASK_BEGIN", tabId: 7, frameId: 4, sourceUrl: "https://example.test" }, {});
  const pair = taskId => send({ type: "PIC_EXPERT_DOWNLOAD_PAIR", taskId, orderNo: "O1", referenceNo: "R1", assets });
  return { send, begin, pair, calls, removed, items, task: () => structuredClone(stored) };
}
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
  assert.deepEqual(h.removed, [1, 2]);
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
test("worker recovery reconciles leftover files into an already recorded row and CSV", async () => {
  const h = harness({failRemove:true}, interruptedTask());
  await h.send({type:"PIC_EXPERT_TASK_STOP"},{});
  const rows = h.task().manifestRows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].snFile, "pic-expert/T1/R1/SN码.jpg");
  assert.equal(rows[0].invoiceFile, "");
  assert.equal(rows[0].result, "失败");
  assert.match(rows[0].reason, /页面中断.*部分文件无法清理/);
  assert.match(decodeURIComponent(h.calls[0].url), /pic-expert\/T1\/R1\/SN码.jpg/);
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
