const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, row } = require("./content-harness.cjs");

test("all API pages are processed and material modification statuses are skipped", async () => {
  const h = harness([[row("O1", "R1", "08"), row("O2", "R2")], [row("O3", "R3")]]);
  await h.run("T1");
  assert.deepEqual(h.calls.map(call => call.page), [0, 1]);
  assert.deepEqual(h.messages.filter(message => message.type === "PIC_EXPERT_MANIFEST_ROW").map(message => message.row.result), ["跳过", "成功", "成功"]);
  assert.equal(h.messages.at(-1).status, "completed");
});

test("page probe exposes the queried trade date interval", () => {
  const h = harness([[row("O1", "R1")]]);
  let response;
  h.rowStatus({ type: "PIC_EXPERT_PROBE" }, {}, value => { response = value; });
  assert.equal(response.tradeDateRange[0], "20261001");
  assert.equal(response.tradeDateRange[1], "20261004");
  assert.equal(response.ready, true);
});

test("duplicate identities across API pages stop the task", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")], [row("O1", "R1")]]);
  await h.run("T1");
  assert.equal(h.messages.at(-1).status, "failed");
  assert.match(h.messages.at(-1).error, /重复订单身份/);
});

test("API results that do not match the displayed query stop before order processing", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")]], {
    visiblePage: { page: 1, total: 2, signature: "OTHER::QUERY" }
  });
  await h.run("T1");
  assert.equal(h.messages.some(message => message.type === "PIC_EXPERT_ROW_BEGIN"), false);
  assert.match(h.messages.at(-1).error, /与页面当前查询不一致/);
});

test("a changed query filter stops before processing the next order", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")]], {
    onMessage: (message, setFilters) => { if (message.type === "PIC_EXPERT_MANIFEST_ROW") setFilters({ status: ["01"] }); }
  });
  await h.run("T1");
  assert.equal(h.messages.filter(item => item.type === "PIC_EXPERT_ROW_BEGIN").length, 2);
  assert.match(h.messages.at(-1).error, /查询条件或页面发生变化/);
});

test("resume verifies the API query and checkpoint page signature", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")] ]);
  await h.run("T1", { url: h.context.url, page: 1, total: 2, signature: "wrong", filters: [], query: { status: ["01"] }, size: 2, visitedBefore: 0 });
  assert.equal(h.calls.length, 0);
  assert.equal(h.messages.at(-1).status, "failed");
  assert.match(h.messages.at(-1).error, /查询与断点不同/);
});

test("legacy checkpoints continue only when the saved page still matches", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")] ]);
  await h.run("T1", { url: h.context.url, page: 1, total: 2, signature: "O1::R1\nO2::R2", filters: [], visitedBefore: 0 });
  assert.equal(h.messages.at(-1).status, "completed");
});

test("authentication failure stops the task instead of marking every order failed", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")]], {
    assets: () => { const error = new Error("登录状态已失效"); error.auth = true; throw error; }
  });
  await h.run("T1");
  assert.equal(h.messages.filter(message => message.type === "PIC_EXPERT_ROW_BEGIN").length, 2);
  assert.equal(h.messages.some(message => message.type === "PIC_EXPERT_MANIFEST_ROW"), false);
  assert.equal(h.messages.at(-1).status, "failed");
});

test("pause is saved at the order boundary", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")]]);
  h.pauseAfterNextRow();
  await h.run("T1");
  assert.equal(h.messages.filter(message => message.type === "PIC_EXPERT_ROW_BEGIN").length, 2);
  assert.equal(h.messages.at(-1).type, "PIC_EXPERT_TASK_PAUSED");
});

test("image authentication errors stop before the next order even when another image fails first", async () => {
  for (const status of [401, 403]) {
    const requests = [];
    const h = harness([[row("O1", "R1"), row("O2", "R2")]], {
      fetch: async url => {
        requests.push(url);
        return { ok: false, status: url.endsWith("SN码") ? 404 : status };
      }
    });
    await h.run("T1");
    assert.equal(h.messages.filter(m => m.type === "PIC_EXPERT_ROW_BEGIN").length, 2);
    assert.equal(h.messages.some(m => m.type === "PIC_EXPERT_MANIFEST_ROW"), false);
    assert.equal(h.messages.some(m => m.type === "PIC_EXPERT_DOWNLOAD_PAIR"), false);
    assert.equal(h.messages.at(-1).status, "failed");
    assert.match(h.messages.at(-1).error, /登录/);
    assert.ok(requests.length >= 2 && requests.length <= 4);
  }
});

test("resume rescans every page, retries failures and missing files, and preserves good downloads and CSV totals", async () => {
  require("fake-indexeddb/auto");
  const { TaskStore } = require("../store.js");
  const { harness: background } = require("./background-harness.cjs");
  let pointer;
  const store = new TaskStore({
    get: async () => ({ picExpertTask: pointer }),
    set: async value => { pointer = value.picExpertTask; }
  }, "resume-test-" + process.pid);
  const options = { store, failInvoice: "R1" };
  const backend = background(options);
  const { task } = await backend.begin();
  const pages = [[row("O1", "R1"), row("O2", "R2")], [row("O3", "R3"), row("O4", "R4", "08")]];
  const h = harness(pages, {
    sendMessage: backend.send,
    onMessage: message => { if (message.type === "PIC_EXPERT_MANIFEST_ROW") options.failInvoice = false; }
  });
  try {
    await h.run(task.id);
    const finished = await store.getTask();
    assert.equal(finished.status, "completed");
    assert.equal(finished.checkpoint.page, 2);
    assert.equal(finished.failed, 1);
    const goodPair = await store.getPair(task.id, "R3");
    const lostPair = await store.getPair(task.id, "R2");
    backend.items.get(lostPair.files["SN码"].downloadId).exists = false;
    const before = backend.calls.length;
    const resumed = await backend.send({ type: "PIC_EXPERT_TASK_RESUME", tabId: 7, frameId: 4 }, {});
    assert.equal(resumed.ok, true);
    assert.equal(resumed.task.id, task.id);
    assert.equal(resumed.task.folderName, task.folderName);
    await h.run(task.id, resumed.task.checkpoint);
    const finalTask = await store.getTask();
    assert.equal(finalTask.status, "completed");
    assert.deepEqual([finalTask.scanned, finalTask.completed, finalTask.skipped, finalTask.failed], [4, 3, 1, 0]);
    assert.equal((await store.rows(task.id)).length, 4);
    assert.deepEqual(await store.getPair(task.id, "R3"), goodPair);
    const newCalls = backend.calls.slice(before);
    assert.equal(newCalls.length, 5);
    assert.ok(newCalls.slice(0, 4).every(call => /\/(R1|R2)\//.test(call.filename)));
    const manifests = backend.calls.filter(call => call.filename.endsWith(".csv"));
    assert.equal(manifests.length, 2);
    assert.equal(manifests[0].filename, manifests[1].filename);
    assert.equal(manifests[1].conflictAction, "overwrite");
    const csv = decodeURIComponent(manifests[1].url.split(",").slice(1).join(","));
    assert.equal(csv, "\uFEFF订单号,参考号,处理结果,原因\r\nO1,R1,成功,\r\nO2,R2,成功,\r\nO3,R3,成功,\r\nO4,R4,跳过,材料修改");
    assert.equal((await backend.send({ type: "PIC_EXPERT_TASK_RESUME", tabId: 7, frameId: 4 }, {})).ok, false);
  } finally { (await store.open()).close(); }
});

test("changed checkpoint page stops before retrying earlier pages", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")], [row("O3", "R3")]]);
  await h.run("T1", { url: h.context.url, page: 2, total: 3, signature: "wrong", filters: [], size: 2, visitedBefore: 2 });
  assert.equal(h.messages.some(m => m.type === "PIC_EXPERT_ROW_BEGIN"), false);
  assert.match(h.messages.at(-1).error, /断点页订单集合/);
});
