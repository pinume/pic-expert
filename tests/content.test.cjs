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
test("portal labels select real previews including proof images", () => {
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
  assert.equal(h.api.findAssets(scope)["证明材料图一"], real.currentSrc);
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
  assert.match(h.messages.at(-1).error, /返回原查询页面/);
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
  assert.match(h.messages.at(-1).error, /返回原查询页面/);
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
test("task failure emits a diagnostic stage before finalizing", async () => {
  const h = harness([[row("O1","R1",false).e]], null);
  await h.api.run("T1");
  const entries = h.messages.filter(m => m.type === "PIC_EXPERT_LOG");
  assert.ok(entries.some(m => m.stage === "打开详情"));
  assert.equal(entries.at(-1).stage, "任务中断");
  assert.equal(entries.at(-1).level, "error");
  assert.equal(entries.at(-1).message, h.messages.at(-1).error);
});
function preservedList(h, value = "2026/10/01 ~ 2026/10/04") {
  const input = new Element(); input.value = value;
  input.onClick = () => { throw new Error("date input clicked"); };
  input.dispatchEvent = () => { throw new Error("date input modified"); };
  const field = new Element("", {"input":[input],"label":[new Element("交易日期*")]});
  const query = new Element("查询"); query.onClick = () => { throw new Error("query clicked"); };
  h.doc.selectors[".search-item"] = [field];
  h.doc.selectors["button"] = [query];
  return {url:"https://portal.test/app#/auditOfTrade2026",page:1,total:1,signature:"O1::R1",filters:[{label:"交易日期*",value}]};
}
test("return validates preserved results without clicking dates or query", async () => {
  const h = harness([[row("O1","R1").e]]), checkpoint = preservedList(h);
  await h.api.restoreList(checkpoint);
  assert.equal(h.context.location.hash, "#/auditOfTrade2026");
});
test("lost original conditions stop without resetting dates or querying", async () => {
  const h = harness([[row("O1","R1").e]]), checkpoint = preservedList(h);
  h.doc.querySelector(".search-item").querySelector("input").value = "";
  await assert.rejects(h.api.restoreList(checkpoint), /原查询条件或总条数未保留/);
});
test("changed preserved orders stop without attempting to requery", async () => {
  const h = harness([[row("O2","R2").e]]), checkpoint = preservedList(h);
  await assert.rejects(h.api.restoreList(checkpoint), /订单集合与原查询不同/);
});
function withImages(labels) {
  const one = row("O1","R1",false);
  const containers = labels.map(label => {
    const img = new Element(); Object.assign(img,{complete:true,naturalWidth:100,currentSrc:"https://portal.test/" + label});
    return new Element("",{"p":[new Element(label)],"img.el-image__inner":[img]});
  });
  const detail = new Element("订单号 O1",{".image-container1":containers});
  const h = harness([[one.e]],detail);
  one.control.onClick = h.open;
  h.context.Blob = Blob; h.context.AbortSignal = AbortSignal;
  h.context.fetch = async () => ({ok:true,blob:async () => new Blob([new Uint8Array([0xff,0xd8,0xff])])});
  h.context.FileReader = class { readAsDataURL(blob) {this.result="data:" + blob.type + ";base64,/9j/";this.onload();} };
  h.context.chrome.runtime.sendMessage = async message => {
    h.messages.push(message);
    if (message.type === "PIC_EXPERT_DOWNLOAD_PAIR") return {ok:true,files:Object.fromEntries(Object.keys(message.assets).map(kind => [kind,{filename:"R1/" + kind + ".jpg"}]))};
    return {ok:true};
  };
  return {h,containers};
}
test("all three available proof images are sent and recorded alongside required images", async () => {
  const {h} = withImages(["SN码照片","发票图片","证明材料图一","证明材料图二","证明材料图三"]);
  await h.api.run("T1");
  const message = h.messages.find(m => m.type === "PIC_EXPERT_DOWNLOAD_PAIR");
  assert.deepEqual(Object.keys(message.assets), ["SN码","发票","证明材料图一","证明材料图二","证明材料图三"]);
  const result = h.messages.find(m => m.type === "PIC_EXPERT_MANIFEST_ROW").row;
  assert.equal(result.proof3File, "R1/证明材料图三.jpg");
});
test("proof images remain optional and gaps retain their original label", async () => {
  const {h} = withImages(["SN码照片","发票图片","证明材料图三"]);
  await h.api.run("T1");
  const message = h.messages.find(m => m.type === "PIC_EXPERT_DOWNLOAD_PAIR");
  assert.deepEqual(Object.keys(message.assets), ["SN码","发票","证明材料图三"]);
  const result = h.messages.find(m => m.type === "PIC_EXPERT_MANIFEST_ROW").row;
  assert.equal(result.proof1File, "");
  assert.equal(result.proof2File, "");
  assert.equal(result.proof3File, "R1/证明材料图三.jpg");
});
test("present proof image is awaited until loaded", async () => {
  const {h,containers} = withImages(["SN码照片","发票图片","证明材料图一"]);
  const image = containers[2].querySelector("img.el-image__inner");
  image.complete = false; image.naturalWidth = 0;
  h.schedule(2000, () => { image.complete = true; image.naturalWidth = 100; });
  await h.api.run("T1");
  assert.ok(h.messages.find(m => m.type === "PIC_EXPERT_DOWNLOAD_PAIR").assets["证明材料图一"]);
});
test("ambiguous proof images prevent the whole order download", async () => {
  const {h,containers} = withImages(["SN码照片","发票图片","证明材料图一"]);
  const another = new Element(); Object.assign(another,{complete:true,naturalWidth:100,currentSrc:"https://portal.test/other"});
  containers[2].selectors["img.el-image__inner"].push(another);
  await h.api.run("T1");
  assert.equal(h.messages.some(m => m.type === "PIC_EXPERT_DOWNLOAD_PAIR"), false);
  assert.match(h.messages.find(m => m.type === "PIC_EXPERT_MANIFEST_ROW").row.reason, /证明材料图一.*不唯一/);
});
