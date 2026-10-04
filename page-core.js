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

  const chooseUnique = (values) => {
    const unique = [...new Set(values.filter(Boolean))];
    return unique.length === 1 ? unique[0] : null;
  };

  const assetKind = (label) => {
    const text = normalize(label).replace(/^[（(](?:必填|选填)[）)]/, "").replace(/[:：]$/, "");
    if (/^(?:S\/?N码(?:照片|图片)?|序列号(?:照片|图片)?)$/i.test(text)) return "SN码";
    if (/^发票(?:照片|图片)?$/.test(text)) return "发票";
    const proof = text.match(/^证明材料图([一二三123])$/);
    if (proof) return "证明材料图" + ({1:"一",2:"二",3:"三"}[proof[1]] || proof[1]);
    return null;
  };
  const chooseFrame = (results) => {
    const frames = results.filter(x => x.result?.ok && x.result.ready);
    if (frames.length !== 1) throw new Error(frames.length ? "发现多个订单列表，无法唯一定位。" : "未找到已查询的订单列表，请先完成查询。");
    return frames[0].frameId;
  };
  const hasIdentity = (text, orderNo) => {
    const escaped = String(orderNo).replace(/[.*+?^\$\{\}()|[\]\\]/g, "\\$&");
    return Boolean(orderNo) && new RegExp(`(?:^|[^a-zA-Z0-9])${escaped}(?:$|[^a-zA-Z0-9])`).test(text);
  };
  const api = Object.freeze({ normalize, inferColumns, isMaterialModification, chooseUnique, assetKind, chooseFrame, hasIdentity });
  globalThis.PIC_EXPERT_PAGE_CORE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
