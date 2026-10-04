const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

test("sanitizePathPart removes unsafe filename characters", () => {
  assert.equal(core.sanitizePathPart('  17681925556N:/?*  '), "17681925556N____");
});

test("buildManifestCsv emits one header and quotes fields", () => {
  const csv = core.buildManifestCsv([{orderNo:"1",referenceNo:"A",result:"成功",reason:'x,"y"',snFile:"SN码.jpg",invoiceFile:"发票.jpg"}]);
  assert.equal(csv.split("\r\n")[0], "\uFEFF订单号,参考号,处理结果,原因");
  assert.match(csv, /"x,""y"""/);
});

test("task IDs do not collide in the same second", () => {
  const date = new Date("2026-10-04T12:00:00Z");
  assert.notEqual(core.makeTaskId(date), core.makeTaskId(date));
});
test("extension derives from actual bytes, not an extensionless URL", () => {
  assert.deepEqual(core.imageFormat([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), { mime: "image/png", extension: ".png" });
  assert.deepEqual(core.imageFormat([0xff,0xd8,0xff]), { mime: "image/jpeg", extension: ".jpg" });
  assert.throws(() => core.imageFormat(Buffer.from("<html>login</html>")), /无法识别/);
});
test("manifest contains only four columns even when image paths exist", () => {
  const row = {orderNo:"O1",referenceNo:"R1",result:"成功",reason:"",...core.manifestFiles({"SN码":{filename:"SN码.jpg"},"发票":{filename:"发票.jpg"},"证明材料图三":{filename:"证明材料图三.png"}})};
  const csv = core.buildManifestCsv([row]).split("\r\n");
  assert.equal(csv[0], "\uFEFF订单号,参考号,处理结果,原因");
  assert.equal(csv[1], "O1,R1,成功,");
});
