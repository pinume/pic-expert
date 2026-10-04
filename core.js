(() => {
  const INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001F]/g;

  const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

  const sanitizePathPart = (value, fallback = "unknown") => {
    const cleaned = cleanText(value).replace(INVALID_FILENAME, "_").replace(/[. ]+$/g, "").slice(0, 120);
    return cleaned || fallback;
  };

  const extensionFromUrl = (rawUrl, fallback = ".jpg") => {
    try {
      const url = new URL(rawUrl);
      const match = url.pathname.match(/(\.[a-z0-9]{2,5})$/i);
      if (match && /^\.(?:jpe?g|png|webp|gif|bmp|tiff?|heic|pdf)$/i.test(match[1])) return match[1].toLowerCase();
    } catch {}
    return fallback;
  };

  const csvCell = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const buildManifestCsv = (rows) => {
    const headers = ["订单号", "参考号", "处理结果", "原因", "SN码文件", "发票文件"];
    const lines = [headers, ...rows.map((row) => [
      row.orderNo,
      row.referenceNo,
      row.result,
      row.reason,
      row.snFile,
      row.invoiceFile
    ])];
    return `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}`;
  };

  const makeTaskId = (date = new Date()) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  };

  const api = Object.freeze({ cleanText, sanitizePathPart, extensionFromUrl, buildManifestCsv, makeTaskId });
  globalThis.PIC_EXPERT_CORE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
