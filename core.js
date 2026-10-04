(() => {
  const INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001F]/g;
  const REQUIRED_KINDS = Object.freeze(["SN码", "发票"]);
  const PROOF_KINDS = Object.freeze(["证明材料图一", "证明材料图二", "证明材料图三"]);
  const ASSET_KINDS = Object.freeze([...REQUIRED_KINDS, ...PROOF_KINDS]);
  const FILE_FIELDS = Object.freeze(["snFile", "invoiceFile", "proof1File", "proof2File", "proof3File"]);
  const manifestFiles = files => Object.fromEntries(ASSET_KINDS.map((kind, i) => [FILE_FIELDS[i], files?.[kind]?.filename || ""]));

  const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

  const sanitizePathPart = (value, fallback = "unknown") => {
    const cleaned = cleanText(value).replace(INVALID_FILENAME, "_").replace(/[. ]+$/g, "").slice(0, 120);
    return cleaned || fallback;
  };

  const csvCell = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const buildManifestCsv = (rows) => {
    const headers = ["订单号", "参考号", "处理结果", "原因", "SN码文件", "发票文件", ...PROOF_KINDS.map(kind => kind + "文件")];
    const lines = [headers, ...rows.map((row) => [
      row.orderNo,
      row.referenceNo,
      row.result,
      row.reason,
      ...FILE_FIELDS.map(field => row[field])
    ])];
    return `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}`;
  };

  const makeTaskId = (date = new Date()) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${crypto.randomUUID()}`;
  };

  const imageFormat = (bytes) => {
    const b = Array.from(bytes);
    const starts = (...prefix) => prefix.every((v, i) => b[i] === v);
    if (starts(0xff, 0xd8, 0xff)) return { mime: "image/jpeg", extension: ".jpg" };
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: "image/png", extension: ".png" };
    const ascii = String.fromCharCode(...b);
    if (/^GIF8[79]a/.test(ascii)) return { mime: "image/gif", extension: ".gif" };
    if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return { mime: "image/webp", extension: ".webp" };
    if (starts(0x42, 0x4d)) return { mime: "image/bmp", extension: ".bmp" };
    throw new Error("图片内容无法识别，已跳过以避免保存错误文件。");
  };

  const api = Object.freeze({ cleanText, sanitizePathPart, buildManifestCsv, makeTaskId, imageFormat,
    REQUIRED_KINDS, PROOF_KINDS, ASSET_KINDS, FILE_FIELDS, manifestFiles });
  globalThis.PIC_EXPERT_CORE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
