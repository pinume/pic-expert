const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

test("sanitizePathPart removes unsafe filename characters", () => {
  assert.equal(core.sanitizePathPart('  17681925556N:/?*  '), "17681925556N____");
});

test("buildManifestCsv emits one header and quotes fields", () => {
  const csv = core.buildManifestCsv([{orderNo:"1",referenceNo:"A",result:"成功",reason:'x,"y"',snFile:"SN码.jpg",invoiceFile:"发票.jpg"}]);
  assert.match(csv, /^\uFEFF订单号,参考号,处理结果,原因,SN码文件,发票文件/);
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
