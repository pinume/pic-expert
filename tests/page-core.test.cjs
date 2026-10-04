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
