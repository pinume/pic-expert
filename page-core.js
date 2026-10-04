(() => {
  const normalize = (value) => String(value ?? "").replace(/\s+/g, "").trim();

  const inferColumns = (headers) => {
    const normalized = headers.map(normalize);
    const find = (patterns) => normalized.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
    return {
      orderNo: find([/^订单号$/, /^订单编号$/, /^业务订单号$/]),
      referenceNo: find([/^参考号$/, /^检索参考号$/, /^交易参考号$/]),
      operation: find([/^操作$/, /^操作项$/])
    };
  };

  const isMaterialModification = (text) => /材料修改/.test(String(text ?? ""));

  const isImageLikeUrl = (value) => {
    const text = String(value ?? "").trim();
    return /^(?:https?:|blob:|data:image\/)/i.test(text) || /\.(?:jpe?g|png|webp|gif|bmp|tiff?|heic|pdf)(?:[?#].*)?$/i.test(text);
  };

  const chooseUnique = (values) => {
    const unique = [...new Set(values.filter(Boolean))];
    return unique.length === 1 ? unique[0] : null;
  };

  const api = Object.freeze({ normalize, inferColumns, isMaterialModification, isImageLikeUrl, chooseUnique });
  globalThis.PIC_EXPERT_PAGE_CORE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
