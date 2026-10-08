const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");

const loadPopup = async task => {
  const elements = new Map(["#start", "#stop", "#retry", "#pause", "#resume", "#export-logs", "#status",
    "#progress", "#completion", "#error", "#logs", "#copy-logs", "#copy-status"].map(selector => [selector, {
    hidden: false, disabled: false, textContent: "", value: "", dataset: {}, scrollHeight: 0,
    addEventListener() {}, focus() {}, select() {}
  }]));
  const sandbox = {
    document: { querySelector: selector => elements.get(selector), execCommand: () => true },
    chrome: { runtime: { sendMessage: async () => ({ ok: true, task }) } },
    navigator: { clipboard: { writeText: async () => {} } },
    window: { addEventListener() {} },
    setInterval: () => 1, clearInterval() {}, Date, console
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../popup.js"), "utf8"), sandbox);
  await new Promise(setImmediate);
  return elements;
};

test("popup shows a persisted completion summary after reopening", async () => {
  const elements = await loadPopup({ status: "completed", page: 2, scanned: 10, completed: 8, skipped: 1, failed: 1,
    checkpoint: { total: 10 }, manifestDownloadId: 12, logs: [] });
  const notice = elements.get("#completion");
  assert.equal(notice.hidden, false);
  assert.equal(notice.dataset.status, "completed");
  assert.match(notice.textContent, /任务已完成。成功 8，跳过 1，失败 1。清单已下载/);
});

test("popup reports failed tasks and manifest errors", async () => {
  const elements = await loadPopup({ status: "failed", scanned: 3, completed: 1, skipped: 1, failed: 1,
    error: "API timeout", manifestError: "清单下载失败：network", logs: [] });
  const notice = elements.get("#completion");
  assert.equal(notice.hidden, false);
  assert.equal(notice.dataset.status, "failed");
  assert.match(notice.textContent, /任务已停止。成功 1，跳过 1，失败 1。清单下载失败/);
  assert.match(elements.get("#error").textContent, /API timeout/);
  assert.match(elements.get("#error").textContent, /清单下载失败：network/);
});

test("popup hides the end notice while the task is running", async () => {
  const elements = await loadPopup({ status: "running", scanned: 1, completed: 0, skipped: 0, failed: 0, logs: [] });
  assert.equal(elements.get("#completion").hidden, true);
});

test("completed tasks expose continuation only when orders failed and a checkpoint exists", async () => {
  for (const [failed, checkpoint, hidden] of [[1, { total: 2 }, false], [0, { total: 2 }, true], [1, null, true]]) {
    const elements = await loadPopup({ status: "completed", failed, checkpoint, logs: [] });
    assert.equal(elements.get("#resume").hidden, hidden);
  }
});

test("popup displays confirmed totals and all in-flight orders, including a zero total", async () => {
  const active = await loadPopup({ status: "running", total: 10, page: 1, scanned: 2, completed: 1, skipped: 1, failed: 0,
    currentRows: [{}, {}, {}], logs: [] });
  assert.equal(active.get("#progress").textContent, "订单总数 10 · 页 1 · 已处理 2 · 正在处理 3 · 成功 1 · 跳过 1 · 失败 0");
  const empty = await loadPopup({ status: "running", total: 0, currentRows: [], logs: [] });
  assert.match(empty.get("#progress").textContent, /^订单总数 0 /);
});
