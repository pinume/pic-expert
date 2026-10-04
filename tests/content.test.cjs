const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const pageCore = require("../page-core.js");
const fileCore = require("../core.js");

// A small DOM fixture matching the observed Element UI split header/body structure.
// Fixed-column clones are present inside the root, but only the main body is eligible.
class Element {
  constructor(text = "", selectors = {}) {
    this.textContent = text;
    this.selectors = selectors;
    this.style = {};
    this.classList = { contains: () => false };
    this.disabled = false;
  }
  querySelectorAll(selector) {
    const result = this.selectors[selector];
    return typeof result === "function" ? result() : result || [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() { return [{}]; }
  getAttribute() { return null; }
  closest() { return null; }
  contains(other) { return other === this; }
  click() { this.onClick?.(); }
}
function harness(pages, detail = null) {
  let page = 1, opened = false, time = 0, listener;
  const messages = [];
  const fixed = new Element("fixed clone", { "tbody tr": [new Element("wrong row")] });
  const header = new Element("", { "thead th": ["订单号", "参考号", "操作"].map(v => new Element(v)) });
  const body = new Element("", { "tbody tr": () => pages[page - 1] });
  const root = new Element("", { ".el-table__header-wrapper": [header], ".el-table__body-wrapper": [body],
    ".el-table__fixed-body-wrapper": [fixed] });
  const prev = new Element(), next = new Element();
  Object.defineProperty(prev, "disabled", { get: () => page === 1 });
  Object.defineProperty(next, "disabled", { get: () => page === pages.length });
  prev.onClick = () => { page--; };
  next.onClick = () => { page++; };
  const pager = new Element("", { ".btn-prev": [prev], ".btn-next": [next],
    ".el-pager .active": () => [new Element(String(page))],
    ".el-pagination__total": [new Element("共 " + pages.flat().length + " 条")] });
  const doc = new Element("", { ".el-table": [root], "table": [],
    ".el-pagination": [pager], ".group-manager-container-float2.trade-in": () => opened && detail ? [detail] : [] });
  const context = {
    document: doc, Element, PIC_EXPERT_PAGE_CORE: pageCore, PIC_EXPERT_CORE: fileCore,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    chrome: { runtime: { onMessage: { addListener: f => { listener = f; } },
      sendMessage: async message => { messages.push(message); return { ok: true }; } } },
    module: { exports: {} }, location: { href: "https://portal.test/app#/unsupported", origin: "https://portal.test", pathname: "/app" },
    URL, Date: { now: () => time }, setTimeout: (fn, ms) => { time += ms; fn(); }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../content.js"), "utf8"), context);
  return { context, doc, api: context.module.exports, messages, open: () => { opened = true; }, probe: () => {
    let result; listener({type:"PIC_EXPERT_PROBE"}, {}, r => { result = r; }); return result;
  } };
}
function row(order, ref, material = true) {
  const control = new Element("查看详情");
  const operation = new Element(material ? "材料修改 查看详情" : "查看详情", { "button,a,[role=button]": [control] });
  const e = new Element(order + " " + ref + " " + operation.textContent, {
    "td": [new Element(order), new Element(ref), operation]
  });
  return { e, control };
}
test("split header/body and fixed clones yield one main order list", () => {
  const rows = [row("O1", "R1").e, row("O2", "R2").e];
  const h = harness([rows]);
  assert.equal(h.probe().ready, true);
  assert.equal(h.api.currentTable().rows.length, 2);
  assert.equal(h.api.currentTable().rows[0], rows[0]);
});
test("all query pages are scanned and material modification rows skipped", async () => {
  const h = harness([[row("O1", "R1").e, row("O2", "R2").e], [row("O3", "R3").e]]);
  await h.api.run("T1");
  const rows = h.messages.filter(m => m.type === "PIC_EXPERT_MANIFEST_ROW");
  assert.equal(rows.length, 3);
  assert.ok(rows.every(m => m.row.result === "跳过" && m.row.reason === "材料修改"));
  assert.equal(h.messages.at(-1).status, "completed");
});
test("portal labels select real previews and exclude placeholder/proof images", () => {
  const real = new Element();
  Object.assign(real, {complete:true, naturalWidth:100, currentSrc:"https://portal.test/image1"});
  const invoice = new Element();
  Object.assign(invoice, {complete:true, naturalWidth:100, currentSrc:"https://portal.test/image2"});
  const container = (label, image) => new Element("", {"p":[new Element(label)], "img.el-image__inner":[image]});
  const scope = new Element("", {".image-container1":[container("（必填）SN码照片",real),
    container("（必填）发票图片",invoice), container("证明材料图一",real)]});
  const h = harness([[row("O1","R1").e]]);
  assert.equal(h.api.findAssets(scope)["SN码"], real.currentSrc);
  assert.equal(h.api.findAssets(scope)["发票"], invoice.currentSrc);
});
test("failure to return to a confirmed list stops before the next order", async () => {
  const one = row("O1", "R1", false), two = row("O2", "R2", false);
  const detail = new Element("订单号 O1 商品信息");
  const h = harness([[one.e, two.e]], detail);
  let first = 0, second = 0;
  one.control.onClick = () => { first++; h.open(); };
  two.control.onClick = () => { second++; };
  await h.api.run("T1");
  assert.equal(first, 1);
  assert.equal(second, 0);
  assert.equal(h.messages.at(-1).status, "failed");
  assert.match(h.messages.at(-1).error, /恢复原查询页面/);
});

test("standalone return reselects the original dates and verifies the same order set", async () => {
  const h = harness([[row("O1", "R1").e]]);
  class Input extends Element {
    get value() { return this._value || ""; }
    set value(v) { this._value = v; }
    dispatchEvent() {}
  }
  const input = new Input();
  input.classList = { contains: cls => cls === "deal-date" };
  const field = new Element("", { "input": [input], "label": [new Element("交易日期")] });
  const selected = [];
  const cell = date => {
    const e = new Element();
    e.getAttribute = () => date;
    e.onClick = () => selected.push(date);
    return e;
  };
  const confirm = new Element("确定");
  const calendar = new Element("", { "td[lay-ymd]": [cell("2026-10-1"), cell("2026-10-4")],
    ".laydate-btns-confirm": [confirm] });
  let queried = 0, opened = false;
  input.onClick = () => { opened = true; };
  const query = new Element("查询");
  query.onClick = () => { queried++; };
  h.doc.selectors[".search-item"] = [field];
  h.doc.selectors["input.deal-date"] = [input];
  h.doc.selectors[".layui-laydate"] = () => opened ? [calendar] : [];
  h.doc.selectors["button"] = [query];
  h.context.HTMLInputElement = Input;
  h.context.Event = class {};
  h.context.location.href = "https://portal.test/app#/auditOfTrade2026";
  const checkpoint = { url: h.context.location.href, page: 1, total: 1, signature: "O1::R1",
    filters: [{label:"交易日期",value:"2026/10/01 ~ 2026/10/04",date:true,readonly:false}] };
  await h.api.restoreList(checkpoint);
  assert.deepEqual(selected, ["2026-10-1", "2026-10-4"]);
  assert.equal(input.value, checkpoint.filters[0].value);
  assert.equal(queried, 1);
  await assert.rejects(h.api.restoreList({...checkpoint, signature:"O2::R2"}), /订单集合与原查询不同/);
});
