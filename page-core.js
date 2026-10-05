(() => {
  const isMaterialModification = (text) => /材料修改/.test(String(text ?? ""));

  const assetKind = (label) => {
    const text = String(label ?? "").replace(/\s+/g, "").replace(/^[（(](?:必填|选填)[）)]/, "").replace(/[:：]$/, "");
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
  const api = Object.freeze({ isMaterialModification, assetKind, chooseFrame });
  globalThis.PIC_EXPERT_PAGE_CORE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
