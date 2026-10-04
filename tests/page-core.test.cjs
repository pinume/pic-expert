const test = require("node:test");
const assert = require("node:assert/strict");
const page = require("../page-core.js");

test("inferColumns finds order, reference and operation columns by label", () => {
  assert.deepEqual(page.inferColumns(["序号", "订单号", "检索参考号", "状态", "操作"]), { orderNo: 1, referenceNo: 2, operation: 4 });
});

test("material modification is always excluded", () => {
  assert.equal(page.isMaterialModification("审核通过 材料修改 查看详情"), true);
  assert.equal(page.isMaterialModification("审核通过 查看详情"), false);
});

test("chooseUnique refuses ambiguous assets", () => {
  assert.equal(page.chooseUnique(["a.jpg", "a.jpg"]), "a.jpg");
  assert.equal(page.chooseUnique(["a.jpg", "b.jpg"]), null);
});

test("actual portal labels distinguish images from text and proof material", () => {
  assert.equal(page.assetKind("（必填）SN码照片"), "SN码");
  assert.equal(page.assetKind("（必填）发票图片"), "发票");
  assert.equal(page.assetKind("证明材料图一"), null);
  assert.equal(page.assetKind("S/N码:12345"), null);
});
test("iframe choice rejects missing and ambiguous queried lists", () => {
  assert.equal(page.chooseFrame([{frameId:0,result:{ok:true,ready:false}},{frameId:4,result:{ok:true,ready:true}}]), 4);
  assert.throws(() => page.chooseFrame([]), /未找到/);
  assert.throws(() => page.chooseFrame([{frameId:1,result:{ok:true,ready:true}},{frameId:2,result:{ok:true,ready:true}}]), /多个/);
});
test("date restoration parses the observed portal format", () => {
  assert.deepEqual(page.dateRange("2026/10/01 ~ 2026/10/04"), ["2026-10-1", "2026-10-4"]);
  assert.throws(() => page.dateRange(""), /无法解析/);
});
test("detail identity cannot be a substring of another order", () => {
  assert.equal(page.hasIdentity("订单号 O123 交易日期", "O123"), true);
  assert.equal(page.hasIdentity("订单号 O1234", "O123"), false);
});
