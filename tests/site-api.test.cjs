const test = require("node:test");
const assert = require("node:assert/strict");
const pageCore = require("../page-core.js");
const fileCore = require("../core.js");
globalThis.PIC_EXPERT_PAGE_CORE = pageCore;
globalThis.PIC_EXPERT_CORE = fileCore;
const site = require("../site-api.js");

const field = (label, value = "") => ({
  querySelector: selector => selector === "label" ? { textContent: label } : selector === "input" ? { value } : null,
  querySelectorAll: selector => selector === ".el-tag__content" ? [] : []
});
const fixtureDocument = (values = {}) => {
  const fields = [field("提交日期"), field("订单号", values.merOrderId || ""),
    field("交易日期*", values.dealDate || "2026/01/01 ~ 2026/01/31"), field("参考号", values.transRef || ""),
    { ...field("订单状态"), querySelector: selector => selector === "label" ? { textContent: "订单状态" } : selector === ".el-input__inner" ? { value: "" } : null,
      querySelectorAll: selector => selector === ".el-tag__content" ? (values.tags || []).map(textContent => ({ textContent })) : [] }];
  const rows = values.rows || [{ orderNo: "O1", referenceNo: "R1" }];
  const headers = ["订单号", "参考号"].map(textContent => ({ textContent }));
  const table = { querySelectorAll: selector => selector === ".el-table__header-wrapper thead th" ? headers :
    selector === ".el-table__body-wrapper tbody tr" ? rows.map(row => ({ querySelectorAll: query => query === "td" ?
      [{ textContent: row.orderNo }, { textContent: row.referenceNo }] : [] })) : [] };
  const pager = { querySelector: selector => selector === ".el-pager .active" ? { textContent: String(values.page || 1) } :
    selector === ".el-pagination__total" ? { textContent: "共 " + (values.total ?? rows.length) + " 条" } : null };
  return {
    defaultView: { performance: { getEntriesByType: () => [{ name: "https://portal.test/uisportal/api/uis-tradein-server/portal/yjhx/v3/queryList" }] } },
    querySelectorAll: selector => selector === ".search-item" ? fields : selector === ".el-table" ? [table] : selector === ".el-pagination" ? [pager] : [],
    querySelector: selector => selector.startsWith(".el-pagination__sizes") ? { value: values.pageSize || "10" } : selector === ".el-pagination" ? pager : null
  };
};
const response = data => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });

test("query context maps the current UI filters to the website query fields", () => {
  const context = site.context(fixtureDocument({ merOrderId: "ORDER-1", transRef: "REF-1" }), {
    hash: "#/auditOfTrade2026", href: "https://portal.test/app#/auditOfTrade2026"
  });
  assert.deepEqual(context.filters, {
    merOrderId: "ORDER-1", transRef: "REF-1", beginTransDate: "20260101", endTransDate: "20260131", status: []
  });
  assert.equal(context.size, 10);
  assert.deepEqual(context.visiblePage, { page: 1, total: 1, signature: "O1::R1" });
});

test("pagination size reads Element UI's displayed page-size value", () => {
  const context = site.context(fixtureDocument({ pageSize: "20条/页" }), {
    hash: "#/auditOfTrade2026", href: "https://portal.test/app#/auditOfTrade2026"
  });
  assert.equal(context.size, 20);
});

test("only a queried order-list route is a launch target", () => {
  const location = { hash: "#/auditOfTrade2026", href: "https://portal.test/app#/auditOfTrade2026" };
  assert.equal(site.isReady(fixtureDocument(), location), true);
  assert.equal(site.isReady(fixtureDocument(), { ...location, hash: "#/tradeInDetail2026" }), false);
  const doc = fixtureDocument();
  doc.defaultView.performance.getEntriesByType = () => [];
  assert.equal(site.isReady(doc, location), false);
});

test("selected status paths expand to the website status codes", () => {
  const context = site.context(fixtureDocument({ tags: ["待审核 / 待核销", "已通过 / 审核通过"] }), {
    hash: "#/auditOfTrade2026", href: "https://portal.test/app#/auditOfTrade2026"
  });
  assert.deepEqual(context.filters.status, ["20", "03", "S02"]);
});

test("query list uses the authenticated JSON POST contract and maps its page", async () => {
  const calls = [];
  const client = site.makeClient("secret", async (url, options) => {
    calls.push({ url, options });
    return response({ list: [{ id: "id-1", merOrderId: "O1", transRef: "R1" }], total: 1 });
  });
  const page = await client.list({ status: [], beginTransDate: "20260101", endTransDate: "20260131" }, 0, 10);
  assert.equal(page.total, 1);
  assert.equal(page.rows[0].id, "id-1");
  assert.equal(calls[0].url, "/uisportal/api/uis-tradein-server/portal/yjhx/v3/queryList");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.userPortalToken, "secret");
  assert.equal(calls[0].options.headers["X-Requested-With"], "XMLHttpRequest");
  assert.deepEqual(JSON.parse(calls[0].options.body), { status: [], beginTransDate: "20260101", endTransDate: "20260131", current: 0, size: 10 });
});

test("detail and template responses map labeled image fields to download URLs", async () => {
  const calls = [];
  const client = site.makeClient("secret", async (url, options) => {
    calls.push(url);
    if (url.endsWith("queryDtl")) return response({ templateId: "template-1", productJson: JSON.stringify({ snImage: "sn-id", invoiceImgId: "invoice-id", proofImage: "proof-id" }) });
    return response({ productJson: JSON.stringify([{ its: [
      { type: "img", key: "snImage", desc: "（必填）SN码照片" },
      { type: "img", key: "invoiceImgId", desc: "（必填）发票图片" },
      { type: "img", key: "proofImage", desc: "证明材料图三" }
    ] }]) });
  });
  const assets = await client.assets({ id: "row-id", mchntId: "merchant-id" }, "https://portal.test");
  assert.deepEqual(calls, [
    "/uisportal/api/uis-tradein-server/portal/yjhx/v3/queryDtl",
    "/uisportal/api/uis-tradein-server/portal/yjhx/v3/queryTemplateInfo/template-1"
  ]);
  assert.match(assets["SN码"].url, /img\/tradein\/download\/sn-id\?userPortalToken=secret/);
  assert.match(assets["发票"].url, /img\/tradein\/download\/invoice-id\?userPortalToken=secret/);
  assert.match(assets["证明材料图三"].url, /img\/tradein\/download\/proof-id\?userPortalToken=secret/);
  assert.equal(assets["证明材料图一"].url, null);
});

test("unknown status tags and rejected API requests fail closed", async () => {
  assert.throws(() => site.context(fixtureDocument({ tags: ["未知状态"] }), {
    hash: "#/auditOfTrade2026", href: "https://portal.test/app#/auditOfTrade2026"
  }), /无法安全识别/);
  const client = site.makeClient("secret", async () => ({ ok: true, status: 200, json: async () => ({ success: false, code: "999999" }) }));
  await assert.rejects(client.list({}, 0, 10), /拒绝了请求/);
});
