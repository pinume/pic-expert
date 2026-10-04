const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

test("sanitizePathPart removes unsafe filename characters", () => {
  assert.equal(core.sanitizePathPart('  17681925556N:/?*  '), "17681925556N____");
});

test("extensionFromUrl keeps supported extensions and falls back", () => {
  assert.equal(core.extensionFromUrl("https://example.com/a.PNG?x=1"), ".png");
  assert.equal(core.extensionFromUrl("https://example.com/image"), ".jpg");
});

test("buildManifestCsv emits one header and quotes fields", () => {
  const csv = core.buildManifestCsv([{orderNo:"1",referenceNo:"A",result:"成功",reason:'x,"y"',snFile:"SN码.jpg",invoiceFile:"发票.jpg"}]);
  assert.match(csv, /^\uFEFF订单号,参考号,处理结果,原因,SN码文件,发票文件/);
  assert.match(csv, /"x,""y"""/);
});
