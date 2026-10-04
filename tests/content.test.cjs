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
  dispatchEvent() {}
  contains(other) { return other === this; }
  click() { this.onClick?.(); }
}
function harness(pages, detail = null) {
  let page = 1, opened = false, time = 0, listener;
  const scheduled = [];
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
    getComputedStyle: e => ({ display: "block", visibility: "visible", ...e.style }),
    chrome: { runtime: { onMessage: { addListener: f => { listener = f; } },
      sendMessage: async message => { messages.push(message); return { ok: true }; } } },
    module: { exports: {} }, location: { href: "https://portal.test/app#/unsupported", origin: "https://portal.test", pathname: "/app" },
    URL, Event: class { constructor(type) { this.type = type; } }, Date: { now: () => time }, setTimeout: (fn, ms) => {
      time += ms;
      for (const item of scheduled.splice(0)) {
        if (item.at <= time) item.fn(); else scheduled.push(item);
      }
      fn();
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../content.js"), "utf8"), context);
  return { context, doc, api: context.module.exports, messages,
    schedule: (ms, fn) => scheduled.push({at:time + ms, fn}), setPage: value => { page = value; },
    open: () => { opened = true; }, probe: () => {
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
  confirm.onClick = () => { input.value = "2026/10/01 ~ 2026/10/04"; };
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

test("pager changing before delayed rows does not skip the next page", async () => {
  const pages = [[row("O1","R1").e, row("O2","R2").e], [row("O3","R3").e, row("O4","R4").e]];
  const h = harness(pages), fresh = pages[1];
  const next = h.doc.querySelector(".el-pagination").querySelector(".btn-next");
  next.onClick = () => {
    h.setPage(2); pages[1] = pages[0];
    h.schedule(1800, () => { pages[1] = fresh; });
  };
  await h.api.run("T1");
  assert.equal(h.messages.at(-1).status, "completed");
  assert.deepEqual(h.messages.filter(m => m.type === "PIC_EXPERT_MANIFEST_ROW").map(m => m.row.orderNo), ["O1","O2","O3","O4"]);
});
test("unchanged rows after pager change fail rather than report completion", async () => {
  const pages = [[row("O1","R1").e], [row("O2","R2").e]], h = harness(pages);
  h.doc.querySelector(".el-pagination").querySelector(".btn-next").onClick = () => {
    h.setPage(2); pages[1] = pages[0];
  };
  await h.api.run("T1");
  assert.equal(h.messages.at(-1).status, "failed");
  assert.match(h.messages.at(-1).error, /翻页/);
});
test("overlapping pages fail on duplicate identity even when signatures differ", async () => {
  const h = harness([[row("O1","R1").e], [row("O1","R1").e, row("O2","R2").e]]);
  await h.api.run("T1");
  assert.equal(h.messages.at(-1).status, "failed");
  assert.match(h.messages.at(-1).error, /重复订单/);
});
test("fixed-column detail control is matched by both identities", async () => {
  const main = row("O1","R1",false), wrong = row("O1","R2",false), clone = row("O1","R1",false);
  main.control.style.visibility = "hidden";
  const h = harness([[main.e]], new Element("订单号 O1 商品信息"));
  const fixed = h.api.currentTable().root.querySelector(".el-table__fixed-body-wrapper");
  fixed.selectors["tbody tr"] = [wrong.e, clone.e];
  let clicks = 0;
  wrong.control.onClick = () => { throw new Error("wrong reference clicked"); };
  clone.control.onClick = () => { clicks++; h.open(); };
  await h.api.run("T1");
  assert.equal(clicks, 1);
  assert.match(h.messages.at(-1).error, /恢复原查询页面/);
});
test("ambiguous visible fixed-column controls fail safely", async () => {
  const main = row("O1","R1",false);
  main.control.style.visibility = "hidden";
  const h = harness([[main.e]]);
  h.api.currentTable().root.querySelector(".el-table__fixed-body-wrapper").selectors["tbody tr"] =
    [row("O1","R1",false).e, row("O1","R1",false).e];
  const result = await h.api.processRow(main.e, h.api.currentTable(), "T1");
  assert.equal(result.reason, "详情入口不唯一");
});
test("visible main control takes precedence over its fixed clone", async () => {
  const main = row("O1","R1",false), clone = row("O1","R1",false);
  const h = harness([[main.e]], new Element("订单号 O1 商品信息"));
  h.api.currentTable().root.querySelector(".el-table__fixed-body-wrapper").selectors["tbody tr"] = [clone.e];
  let clicks = 0;
  main.control.onClick = () => { clicks++; h.open(); };
  clone.control.onClick = () => { throw new Error("clone should not be clicked"); };
  await h.api.run("T1");
  assert.equal(clicks, 1);
});
test("visible page numbers restore distant pages directly", async () => {
  const h = harness(Array.from({length:8}, (_, i) => [row("O" + i,"R" + i).e]));
  const pager = h.doc.querySelector(".el-pagination"), number = new Element("8");
  let clicks = 0;
  number.onClick = () => { clicks++; h.setPage(8); };
  pager.selectors[".el-pager .number"] = [number];
  pager.querySelector(".btn-next").onClick = () => { throw new Error("sequential paging used"); };
  await h.api.goToPage(8);
  assert.equal(clicks, 1);
});
test("jump input restores distant pages with native input and Enter", async () => {
  const h = harness(Array.from({length:8}, (_, i) => [row("O" + i,"R" + i).e]));
  const events = [];
  class Input extends Element {
    get value() { return this._value || ""; }
    set value(v) { this._value = v; }
    dispatchEvent(e) { events.push(e.type); if (e.type === "keyup" && e.keyCode === 13) h.setPage(Number(this.value)); }
  }
  h.context.HTMLInputElement = Input;
  h.context.Event = class { constructor(type, args) { this.type = type; Object.assign(this, args); } };
  h.context.KeyboardEvent = h.context.Event;
  h.doc.querySelector(".el-pagination").selectors[".el-pagination__jump input"] = [new Input()];
  await h.api.goToPage(8);
  assert.deepEqual(events, ["input","change","keyup"]);
});
test("material modification in matching fixed clone skips the whole order", async () => {
  const main = row("O1","R1",false), h = harness([[main.e]]);
  h.api.currentTable().root.querySelector(".el-table__fixed-body-wrapper").selectors["tbody tr"] = [row("O1","R1",true).e];
  const result = await h.api.processRow(main.e, h.api.currentTable(), "T1");
  assert.equal(result.result, "跳过");
  assert.equal(result.reason, "材料修改");
});
test("without jump controls page restoration safely supports forward and backward steps", async () => {
  const h = harness([[row("O1","R1").e],[row("O2","R2").e],[row("O3","R3").e]]);
  await h.api.goToPage(3);
  assert.equal(h.api.currentTable().rows[0].textContent.startsWith("O3"), true);
  await h.api.goToPage(1);
  assert.equal(h.api.currentTable().rows[0].textContent.startsWith("O1"), true);
});
test("date calendar opens via focus after its handler initializes late", async () => {
  const h = harness([[row("O1","R1").e]]), input = new Element(), calendar = new Element();
  let bound = false, opened = false, focuses = 0;
  input.focus = () => { focuses++; if (bound) opened = true; };
  input.blur = () => {};
  h.schedule(1800, () => { bound = true; });
  h.doc.selectors[".layui-laydate"] = () => opened ? [calendar] : [];
  assert.equal(await h.api.openDateCalendar(input, "交易日期"), calendar);
  assert.ok(focuses >= 3);
});
test("date calendar times out safely and does not query when unavailable", async () => {
  const h = harness([[row("O1","R1").e]]), input = new Element();
  let clicks = 0;
  input.onClick = () => { clicks++; };
  await assert.rejects(h.api.openDateCalendar(input, "交易日期"), /原日期控件未打开/);
  assert.equal(clicks, 15);
});
test("multiple visible date calendars fail without choosing one", async () => {
  const h = harness([[row("O1","R1").e]]);
  h.doc.selectors[".layui-laydate"] = [new Element(),new Element()];
  await assert.rejects(h.api.openDateCalendar(new Element(), "交易日期"), /日期控件不唯一/);
});
test("task failure emits a diagnostic stage before finalizing", async () => {
  const h = harness([[row("O1","R1",false).e]], null);
  await h.api.run("T1");
  const entries = h.messages.filter(m => m.type === "PIC_EXPERT_LOG");
  assert.ok(entries.some(m => m.stage === "打开详情"));
  assert.equal(entries.at(-1).stage, "任务中断");
  assert.equal(entries.at(-1).level, "error");
  assert.equal(entries.at(-1).message, h.messages.at(-1).error);
});
test("focus-opened calendar is not immediately closed by a following click", async () => {
  const h = harness([[row("O1","R1").e]]), input = new Element(), calendar = new Element();
  let opened = false, clicks = 0;
  input.focus = () => { opened = true; };
  input.onClick = () => { clicks++; opened = !opened; };
  h.doc.selectors[".layui-laydate"] = () => opened ? [calendar] : [];
  assert.equal(await h.api.openDateCalendar(input, "交易日期"), calendar);
  assert.equal(clicks, 0);
  assert.equal(opened, true);
});
test("explicit focus event opens calendar without an additional toggle click", async () => {
  const h = harness([[row("O1","R1").e]]), input = new Element(), calendar = new Element();
  let opened = false, clicks = 0;
  input.focus = () => {};
  input.dispatchEvent = e => { if (e.type === "focus") opened = true; };
  input.onClick = () => { clicks++; opened = !opened; };
  h.doc.selectors[".layui-laydate"] = () => opened ? [calendar] : [];
  assert.equal(await h.api.openDateCalendar(input, "交易日期"), calendar);
  assert.equal(clicks, 0);
});
test("restoring an earlier month navigates calendar and selects only the exact date", async () => {
  const h = harness([[row("O1","R1").e]]), calendar = new Element(), panel = new Element();
  let month = 10, selected = false;
  const arrow = new Element(), cell = new Element("3");
  cell.getAttribute = () => "2026-9-3";
  cell.onClick = () => { selected = true; };
  arrow.onClick = () => { month--; };
  panel.selectors[".laydate-set-ym"] = () => [new Element("2026 年 " + month + " 月")];
  panel.selectors[".laydate-prev-m"] = [arrow];
  calendar.selectors[".layui-laydate-main"] = [panel];
  calendar.selectors["td[lay-ymd]"] = () => month === 9 ? [cell] : [];
  h.doc.selectors[".layui-laydate"] = [calendar];
  await h.api.selectCalendarDate("2026-9-3");
  assert.equal(month, 9);
  assert.equal(selected, true);
});
test("ambiguous date cells fail instead of selecting the first", async () => {
  const h = harness([[row("O1","R1").e]]), calendar = new Element();
  const cells = [new Element("3"), new Element("3")];
  cells.forEach(cell => { cell.getAttribute = () => "2026-10-3"; cell.onClick = () => { throw new Error("ambiguous date clicked"); }; });
  calendar.selectors["td[lay-ymd]"] = cells;
  h.doc.selectors[".layui-laydate"] = [calendar];
  await assert.rejects(h.api.selectCalendarDate("2026-10-3"), /目标日期不唯一/);
});
