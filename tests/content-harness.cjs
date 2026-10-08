const vm = require("node:vm");
const fs = require("node:fs");
const pageCore = require("../page-core.js");
const fileCore = require("../core.js");

function harness(pages, options = {}) {
  let listener, currentFilters = options.filters || { status: [], beginTransDate: "20261001", endTransDate: "20261004" }, pauseAfterRow = false;
  const messages = [], calls = [];
  const context = {
    url: "https://portal.test/app#/auditOfTrade2026", filters: currentFilters, size: options.size || 2
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
        if (options.list) return options.list(filters, page, size);
        return { rows: pages[page] || [], total: pages.reduce((count, rows) => count + rows.length, 0) };
      },
      async assets(row) {
        return options.assets?.(row) || Object.fromEntries(fileCore.ASSET_KINDS.map(kind =>
          [kind, { url: fileCore.REQUIRED_KINDS.includes(kind) ? "https://portal.test/" + row.transRef + "/" + kind : null, ambiguous: false }]));
      }
    })
  };
  const chrome = { runtime: {
    onMessage: { addListener: fn => { listener = fn; } },
    sendMessage: async message => {
      messages.push(message);
      options.onMessage?.(message, value => { currentFilters = value; });
      if (message.type === "PIC_EXPERT_MANIFEST_ROW" && pauseAfterRow) listener({ type: "PIC_EXPERT_PAUSE" }, {}, () => {});
      if (options.sendMessage) return options.sendMessage(message);
      if (message.type === "PIC_EXPERT_DOWNLOAD_PAIR") return { ok: true, files: {} };
      return { ok: true };
    }
  } };
  const sandbox = {
    document: { querySelectorAll: () => [] }, Element: class {},
    PIC_EXPERT_PAGE_CORE: pageCore, PIC_EXPERT_CORE: fileCore, PIC_EXPERT_SITE_API: siteApi,
    chrome, location: { href: context.url, origin: "https://portal.test", hash: "#/auditOfTrade2026" },
    localStorage: { getItem: () => "session" }, console, URL, AbortController, AbortSignal, Blob,
    fetch: options.fetch || (async () => ({ ok: true, blob: async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])]) })),
    FileReader: class { readAsDataURL(blob) { this.result = "data:" + blob.type + ";base64,/9j/"; this.onload(); } },
    Date, setTimeout, clearTimeout, Promise, Map, Set, Object, Array, String, Error
  };
  sandbox.module = { exports: {} };
  sandbox.globalThis = sandbox;
  if (options.realApi) {
    vm.runInNewContext(fs.readFileSync(require.resolve("../site-api.js"), "utf8"), sandbox);
    sandbox.PIC_EXPERT_SITE_API = { ...sandbox.PIC_EXPERT_SITE_API, context: siteApi.context, isReady: siteApi.isReady };
  }
  vm.runInNewContext(fs.readFileSync(require.resolve("../content.js"), "utf8"), sandbox);
  const exposed = sandbox.module.exports;
  return {
    messages, calls, context, exposed,
    run: (taskId, checkpoint) => exposed.run(taskId, checkpoint),
    changeFilters: value => { currentFilters = value; },
    pauseAfterNextRow: () => { pauseAfterRow = true; },
    rowStatus: listener,
    pageMessage: message => new Promise(resolve => listener(message, {}, resolve))
  };
}
const row = (order, reference, status = "S02") => ({ merOrderId: order, transRef: reference, status, id: "id-" + order, mchntId: "merchant" });

module.exports = { harness, row };
