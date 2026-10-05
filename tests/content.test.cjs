const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const pageCore = require("../page-core.js");
const fileCore = require("../core.js");

function harness(pages, options = {}) {
  let listener, currentFilters = options.filters || { status: [], beginTransDate: "20261001", endTransDate: "20261004" }, pauseAfterRow = false;
  const messages = [], calls = [];
  const context = {
    url: "https://portal.test/app#/auditOfTrade2026", filters: currentFilters, size: 2
  };
  const siteApi = {
    MATERIAL_MODIFICATION: new Set(["04", "08", "H03", "S03"]),
    context: () => ({ ...context, filters: currentFilters, visiblePage: options.visiblePage || {
      page: 1, total: pages.reduce((count, rows) => count + rows.length, 0), signature: pages[0].map(row => row.merOrderId + "::" + row.transRef).join("\n")
    } }),
    isReady: () => true,
    signature: rows => rows.map(row => row.merOrderId + "::" + row.transRef).join("\n"),
    makeClient: () => ({
      async list(filters, page, size) {
        calls.push({ filters, page, size });
        return { rows: pages[page] || [], total: pages.reduce((count, rows) => count + rows.length, 0) };
      },
      async assets(row) {
        return options.assets?.(row) || Object.fromEntries(fileCore.ASSET_KINDS.map(kind =>
          [kind, { url: fileCore.REQUIRED_KINDS.includes(kind) ? "https://portal.test/" + kind : null, ambiguous: false }]));
      }
    })
  };
  const chrome = { runtime: {
    onMessage: { addListener: fn => { listener = fn; } },
    sendMessage: async message => {
      messages.push(message);
      options.onMessage?.(message, value => { currentFilters = value; });
      if (message.type === "PIC_EXPERT_MANIFEST_ROW" && pauseAfterRow) listener({ type: "PIC_EXPERT_PAUSE" }, {}, () => {});
      if (message.type === "PIC_EXPERT_DOWNLOAD_PAIR") return { ok: true, files: {} };
      return { ok: true };
    }
  } };
  const sandbox = {
    document: { querySelectorAll: () => [] }, Element: class {},
    PIC_EXPERT_PAGE_CORE: pageCore, PIC_EXPERT_CORE: fileCore, PIC_EXPERT_SITE_API: siteApi,
    chrome, location: { href: context.url, origin: "https://portal.test", hash: "#/auditOfTrade2026" },
    localStorage: { getItem: () => "session" }, console, URL, AbortSignal, Blob,
    fetch: async () => ({ ok: true, blob: async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])]) }),
    FileReader: class { readAsDataURL(blob) { this.result = "data:" + blob.type + ";base64,/9j/"; this.onload(); } },
    Date, setTimeout, clearTimeout, Promise, Map, Set, Object, Array, String, Error
  };
  sandbox.module = { exports: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(require.resolve("../content.js"), "utf8"), sandbox);
  const exposed = sandbox.module.exports;
  return {
    messages, calls, context, exposed,
    run: (taskId, checkpoint) => exposed.run(taskId, checkpoint),
    changeFilters: value => { currentFilters = value; },
    pauseAfterNextRow: () => { pauseAfterRow = true; },
    rowStatus: listener
  };
}
const row = (order, reference, status = "S02") => ({ merOrderId: order, transRef: reference, status, id: "id-" + order, mchntId: "merchant" });

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
  assert.equal(h.messages.filter(item => item.type === "PIC_EXPERT_ROW_BEGIN").length, 1);
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
  assert.equal(h.messages.filter(message => message.type === "PIC_EXPERT_ROW_BEGIN").length, 1);
  assert.equal(h.messages.some(message => message.type === "PIC_EXPERT_MANIFEST_ROW"), false);
  assert.equal(h.messages.at(-1).status, "failed");
});

test("pause is saved at the order boundary", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")]]);
  h.pauseAfterNextRow();
  await h.run("T1");
  assert.equal(h.messages.filter(message => message.type === "PIC_EXPERT_ROW_BEGIN").length, 1);
  assert.equal(h.messages.at(-1).type, "PIC_EXPERT_TASK_PAUSED");
});
