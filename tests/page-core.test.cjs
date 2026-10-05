const test = require("node:test");
const assert = require("node:assert/strict");
const page = require("../page-core.js");

test("material modification markers are excluded", () => {
  assert.equal(page.isMaterialModification("材料修改"), true);
  assert.equal(page.isMaterialModification("审核通过"), false);
});

test("portal template labels map to supported image kinds", () => {
  assert.equal(page.assetKind("（必填）SN码照片"), "SN码");
  assert.equal(page.assetKind("（必填）发票图片"), "发票");
  assert.equal(page.assetKind("证明材料图一"), "证明材料图一");
  assert.equal(page.assetKind("（选填）证明材料图2"), "证明材料图二");
  assert.equal(page.assetKind("证明材料图四"), null);
});

test("frame choice rejects missing or ambiguous queried order pages", () => {
  assert.equal(page.chooseFrame([{ frameId: 0, result: { ok: true, ready: false } }, { frameId: 4, result: { ok: true, ready: true } }]), 4);
  assert.throws(() => page.chooseFrame([]), /未找到/);
  assert.throws(() => page.chooseFrame([{ frameId: 1, result: { ok: true, ready: true } }, { frameId: 2, result: { ok: true, ready: true } }]), /多个/);
});
