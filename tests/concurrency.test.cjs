const test = require("node:test");
const assert = require("node:assert/strict");
require("fake-indexeddb/auto");
const { TaskStore } = require("../store.js");
const { harness: background, assets } = require("./background-harness.cjs");
const { harness: content, row } = require("./content-harness.cjs");
let sequence = 0;
const tick = () => new Promise(setImmediate);
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() >= end) throw new Error("Expected flow did not complete within 5 seconds");
    await tick();
  }
}
const image = () => ({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])]) });
function imageGate() {
  const pending = new Map(), starts = [];
  let live = 0, peak = 0, held = true;
  const fetch = async (url, { signal }) => {
    signal.throwIfAborted();
    starts.push(url);
    if (!held) return image();
    live++; peak = Math.max(peak, live);
    return new Promise((resolve, reject) => {
      const done = () => { live--; pending.delete(url); signal.removeEventListener("abort", aborted); };
      const aborted = () => { done(); reject(signal.reason); };
      pending.set(url, () => { done(); resolve(image()); });
      signal.addEventListener("abort", aborted, { once: true });
    });
  };
  return { fetch, starts, pending, live: () => live, peak: () => peak,
    release: reference => { for (const [url, finish] of [...pending]) if (url.includes("/" + reference + "/")) finish(); },
    releaseAll: () => { held = false; for (const finish of [...pending.values()]) finish(); }
  };
}
async function flow(t, pages, options = {}) {
  let pointer;
  const store = new TaskStore({ get: async () => ({ picExpertTask: pointer }), set: async value => { pointer = value.picExpertTask; } },
    "concurrent-flow-" + process.pid + "-" + sequence++);
  const downloadOptions = { ...options.downloads, store };
  const backend = background(downloadOptions);
  const { task } = await backend.begin();
  const page = content(pages, { size: options.size || pages[0].length || 3, ...options.content, sendMessage: backend.send });
  downloadOptions.pageMessage = page.pageMessage;
  const runs = [], run = page.run;
  page.run = (...args) => { const promise = run(...args); runs.push(promise); return promise; };
  t.after(async () => {
    await backend.send({ type: "PIC_EXPERT_TASK_STOP" }, {});
    await Promise.allSettled(runs);
    (await store.open()).close();
  });
  return { backend, page, store, task, downloadOptions };
}
async function finishOrder(backend, reference) {
  for (const kind of ["SN码", "发票"]) {
    let item;
    await until(() => {
      item = [...backend.items.values()].find(item => item.filename.includes("/" + reference + "/" + kind));
      return item;
    });
    if (item.state === "in_progress") backend.notify(item.id, "complete");
  }
}

for (const action of ["PAUSE", "STOP"]) for (const reportedFailure of [false, true]) {
  test(`worker restart after image completion preserves ${reportedFailure ? "reported failure" : "unreported success"} on ${action}`, async t => {
    const f = await flow(t, [[row("O1", "R1")]]);
    const identity = { orderNo: "O1", referenceNo: "R1" };
    assert.ok((await f.backend.send({ type: "PIC_EXPERT_ROW_BEGIN", taskId: f.task.id, identity })).ok);
    assert.ok((await f.backend.send({ type: "PIC_EXPERT_DOWNLOAD_PAIR", taskId: f.task.id, ...identity,
      assets: { ...assets, "证明材料图三": assets["发票"] } })).ok);
    // Files complete before the page confirms its final result.
    assert.equal((await f.store.getPair(f.task.id, "R1")).status, "complete");
    assert.equal(await f.store.getRow(f.task.id, identity), null);
    const before = await f.store.getTask();
    assert.deepEqual([before.scanned, before.completed, before.failed, before.currentRows.length], [0, 0, 0, 1]);
    if (reportedFailure) assert.ok((await f.backend.send({ type: "PIC_EXPERT_MANIFEST_ROW", taskId: f.task.id,
      row: { ...identity, result: "失败", reason: "页面中断" } })).ok);

    const store = new TaskStore(f.store.storage, f.store.databaseName);
    t.after(async () => (await store.open()).close());
    const restarted = background({ store, items: f.backend.items });
    const response = await restarted.send({ type: "PIC_EXPERT_TASK_" + action }, {});
    assert.ok(response.ok);
    const task = await store.getTask(), result = await store.getRow(task.id, identity);
    assert.equal(task.id, f.task.id);
    assert.equal(task.folderName, f.task.folderName);
    assert.equal(task.status, action === "PAUSE" ? "paused" : "failed");
    assert.deepEqual([task.scanned, task.completed, task.failed, task.currentRows.length],
      [1, reportedFailure ? 0 : 1, reportedFailure ? 1 : 0, 0]);
    assert.equal(result.result, reportedFailure ? "失败" : "成功");
    assert.equal(result.reason, reportedFailure ? "页面中断" : "");
    const directory = "pic-expert/" + task.folderName + "/R1/";
    assert.deepEqual(f.backend.calls.map(call => call.filename),
      [directory + "SN码.jpg", directory + "发票.png", directory + "证明材料图三.png"]);
    assert.deepEqual([result.snFile, result.invoiceFile, result.proof1File, result.proof2File, result.proof3File],
      [directory + "SN码.jpg", directory + "发票.png", "", "", directory + "证明材料图三.png"]);
    assert.ok(f.backend.calls.every((_call, index) => f.backend.items.get(index + 1).exists));
    assert.equal(restarted.removed.length, 0);

    // Repeated recovery must neither duplicate counts nor download images again.
    assert.ok((await restarted.send({ type: "PIC_EXPERT_TASK_STOP" }, {})).ok);
    assert.ok((await restarted.send({ type: "PIC_EXPERT_TASK_STOP" }, {})).ok);
    const final = await store.getTask();
    assert.deepEqual([final.scanned, final.completed, final.failed], [task.scanned, task.completed, task.failed]);
    assert.equal(restarted.calls.length, 1);
    assert.equal(restarted.calls[0].filename, "pic-expert/" + task.folderName + "/下载清单.csv");
    assert.equal(decodeURIComponent(restarted.calls[0].url).split(",").slice(1).join(","),
      "\uFEFF订单号,参考号,处理结果,原因\r\nO1,R1," + result.result + "," + result.reason);
  });
}

test("force pause aborts three detail requests through the real site API", async t => {
  let active = 0, aborted = 0;
  const requests = [];
  const rows = [row("O1", "R1"), row("O2", "R2"), row("O3", "R3")];
  const fetch = async (url, options) => {
    requests.push(url);
    assert.equal(options.headers.userPortalToken, "session");
    if (url.endsWith("queryList")) return { ok: true, json: async () => ({ success: true, data: { list: rows, total: 3 } }) };
    assert.ok(url.endsWith("queryDtl"));
    active++;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        active--; aborted++; reject(options.signal.reason);
      }, { once: true });
    });
  };
  const f = await flow(t, [rows], { content: { realApi: true, fetch } });
  const running = f.page.run(f.task.id);
  await until(() => active === 3);
  await f.backend.send({ type: "PIC_EXPERT_TASK_PAUSE" }, {});
  await f.backend.send({ type: "PIC_EXPERT_TASK_PAUSE" }, {});
  await running;
  const task = await f.store.getTask();
  assert.deepEqual([task.status, task.failed, task.currentRows.length, active, aborted], ["paused", 3, 0, 0, 3]);
  assert.equal(requests.length, 4);
  assert.equal(f.backend.calls.length, 0);
});

test("verified total precedes downloads; three orders and six reads overlap without crossing a page", async t => {
  const gate = imageGate();
  const f = await flow(t, [[row("O1", "R1"), row("O2", "R2"), row("O3", "R3"), row("O4", "R4")], [row("O5", "R5")]],
    { downloads: { holdPair: true }, content: { fetch: gate.fetch } });
  const running = f.page.run(f.task.id);
  await until(() => gate.live() === 6);
  const active = await f.store.getTask();
  assert.equal(active.total, 5);
  assert.equal(active.currentRows.length, 3);
  assert.equal(f.backend.calls.length, 0);
  assert.equal(f.page.calls.length, 1);
  assert.equal((await f.backend.send({ type: "PIC_EXPERT_CHECKPOINT", taskId: f.task.id, checkpoint: { page: 2, total: 5 } })).ok, false);
  gate.release("R2");
  await finishOrder(f.backend, "R2");
  await until(() => [...gate.pending.keys()].filter(url => url.includes("/R4/")).length === 2);
  assert.equal((await f.store.getTask()).currentRows.length, 3);
  assert.equal(f.page.calls.length, 1);
  gate.release("R4");
  await finishOrder(f.backend, "R4");
  await until(async () => (await f.store.getTask()).completed === 2);
  assert.equal(f.page.calls.length, 1);
  f.downloadOptions.holdPair = false;
  gate.releaseAll();
  await running;
  const finished = await f.store.getTask();
  assert.equal(finished.status, "completed");
  assert.deepEqual([finished.total, finished.scanned, finished.completed, finished.failed, finished.currentRows.length], [5, 5, 5, 0, 0]);
  assert.equal(gate.peak(), 6);
  assert.deepEqual(f.page.calls.map(call => call.page), [0, 1]);
  assert.equal((await f.store.rows(f.task.id)).length, 5);
  const csvCalls = f.backend.calls.filter(call => call.filename.endsWith(".csv"));
  assert.equal(csvCalls.length, 1);
  assert.equal(decodeURIComponent(csvCalls[0].url).split("\r\n").length, 6);
  assert.ok(f.backend.calls.every(call => call.filename.startsWith("pic-expert/" + f.task.folderName + "/")));
  assert.equal(f.backend.handlers.size, 0);
});

test("a failed order rolls back its own images while other orders succeed", async t => {
  const f = await flow(t, [[row("O1", "R1"), row("O2", "R2"), row("O3", "R3"), row("O4", "R4", "08")]],
    { downloads: { failInvoice: "R2" } });
  await f.page.run(f.task.id);
  const task = await f.store.getTask();
  assert.deepEqual([task.scanned, task.completed, task.skipped, task.failed, task.currentRows.length], [4, 2, 1, 1, 0]);
  for (const reference of ["R1", "R3"]) {
    const pair = await f.store.getPair(task.id, reference);
    assert.equal(pair.status, "complete");
    assert.ok(Object.values(pair.files).every(file => f.backend.items.get(file.downloadId).exists));
  }
  assert.deepEqual((await f.store.getPair(task.id, "R2")).files, {});
  assert.ok(f.backend.removed.every(id => f.backend.items.get(id).filename.includes("/R2/")));
});

test("graceful pause drains three orders, keeps its checkpoint, and resumes without duplicate files", async t => {
  const gate = imageGate();
  const f = await flow(t, [[row("O1", "R1"), row("O2", "R2"), row("O3", "R3"), row("O4", "R4")]],
    { content: { fetch: gate.fetch } });
  const running = f.page.run(f.task.id);
  await until(() => gate.live() === 6);
  await f.backend.send({ type: "PIC_EXPERT_TASK_PAUSE" }, {});
  assert.equal((await f.store.getTask()).status, "pausing");
  assert.equal((await f.backend.begin()).ok, false);
  gate.releaseAll();
  await running;
  const paused = await f.store.getTask();
  assert.deepEqual([paused.status, paused.completed, paused.currentRows.length, paused.checkpoint.page], ["paused", 3, 0, 1]);
  assert.equal(f.backend.calls.length, 6);
  assert.ok(!gate.starts.some(url => url.includes("/R4/")));
  const resumed = await f.backend.send({ type: "PIC_EXPERT_TASK_RESUME", tabId: 7, frameId: 4 }, {});
  await f.page.run(f.task.id, resumed.task.checkpoint);
  const finalTask = await f.store.getTask();
  assert.deepEqual([finalTask.scanned, finalTask.completed, finalTask.failed], [4, 4, 0]);
  assert.equal(f.backend.calls.length, 9);
});

for (const action of ["force-pause", "stop"]) test(`${action} cancels three mixed in-flight orders before terminal state`, async t => {
  const gate = imageGate();
  const f = await flow(t, [[row("O1", "R1"), row("O2", "R2"), row("O3", "R3"), row("O4", "R4")]],
    { downloads: { holdPair: true }, content: { fetch: gate.fetch } });
  const running = f.page.run(f.task.id);
  await until(() => gate.live() === 6);
  gate.release("R1");
  await until(() => f.backend.items.size === 1);
  if (action === "force-pause") await f.backend.send({ type: "PIC_EXPERT_TASK_PAUSE" }, {});
  await f.backend.send({ type: action === "stop" ? "PIC_EXPERT_TASK_STOP" : "PIC_EXPERT_TASK_PAUSE" }, {});
  await running;
  const task = await f.store.getTask();
  assert.equal(task.status, action === "stop" ? "failed" : "paused");
  assert.deepEqual([task.scanned, task.completed, task.failed, task.currentRows.length], [3, 0, 3, 0]);
  assert.equal(gate.live(), 0);
  assert.equal(gate.starts.length, 6);
  assert.deepEqual((await f.store.getPair(task.id, "R1")).files, {});
  assert.equal(f.backend.items.get(1).exists, false);
  assert.equal(f.backend.calls.filter(call => call.filename.endsWith(".csv")).length, action === "stop" ? 1 : 0);
  assert.equal(f.backend.handlers.size, 0);
  if (action === "force-pause") {
    gate.releaseAll(); f.downloadOptions.holdPair = false;
    const resumed = await f.backend.send({ type: "PIC_EXPERT_TASK_RESUME", tabId: 7, frameId: 4 }, {});
    await f.page.run(task.id, resumed.task.checkpoint);
    const finished = await f.store.getTask();
    assert.deepEqual([finished.scanned, finished.completed, finished.failed], [4, 4, 0]);
  }
});

for (const fault of ["authentication", "authentication-during-pause", "query-change"]) test(`${fault} halts dispatch and drains pending reads`, async t => {
  const gate = imageGate();
  let releaseAuth;
  const authReady = new Promise(resolve => { releaseAuth = resolve; });
  const f = await flow(t, [[row("O1", "R1"), row("O2", "R2"), row("O3", "R3"), row("O4", "R4")]], {
    content: { fetch: async (url, options) => {
      if (fault.startsWith("authentication") && url.includes("/R2/")) {
        if (fault === "authentication-during-pause") await authReady;
        return { ok: false, status: 401 };
      }
      return gate.fetch(url, options);
    } }
  });
  const running = f.page.run(f.task.id);
  if (fault === "authentication-during-pause") {
    await until(() => gate.live() === 4);
    await f.backend.send({ type: "PIC_EXPERT_TASK_PAUSE" }, {});
    releaseAuth();
  }
  if (fault === "query-change") {
    await until(() => gate.live() === 6);
    f.page.changeFilters({ status: ["01"] }); gate.release("R1");
  }
  await running;
  const task = await f.store.getTask();
  assert.equal(task.status, "failed");
  assert.match(task.error, fault.startsWith("authentication") ? /登录/ : /查询条件/);
  assert.equal(task.currentRows.length, 0);
  assert.equal(gate.live(), 0);
  assert.ok(!gate.starts.some(url => url.includes("/R4/")));
  assert.equal(f.backend.calls.filter(call => !call.filename.endsWith(".csv")).length, 0);
});

test("zero and one order complete with correct totals and one manifest", async t => {
  for (const rows of [[], [row("O1", "R1")]]) {
    const f = await flow(t, [rows]);
    await f.page.run(f.task.id);
    const task = await f.store.getTask();
    assert.deepEqual([task.status, task.total, task.scanned, task.completed], ["completed", rows.length, rows.length, rows.length]);
    assert.equal(f.backend.calls.length, rows.length * 2 + 1);
  }
});

test("changed totals and duplicate identities fail before dispatching an invalid page", async t => {
  for (const duplicate of [false, true]) {
    const pages = duplicate ? [[row("O1", "R1"), row("O1", "R1")]] : [[row("O1", "R1")], [row("O2", "R2")]];
    const f = await flow(t, pages, { content: { list: async (_filters, page) => ({ rows: pages[page], total: duplicate ? 2 : page ? 3 : 2 }) } });
    await f.page.run(f.task.id);
    const task = await f.store.getTask();
    assert.equal(task.status, "failed");
    assert.match(task.error, duplicate ? /重复订单/ : /总数发生变化/);
    assert.equal(task.scanned, duplicate ? 0 : 1);
  }
});
