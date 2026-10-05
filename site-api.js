(() => {
  const API = "/uisportal/api/uis-tradein-server/";
  const IMAGE = API + "img/tradein/download/";
  const STATUS_CODES = new Map([
    ["待提交/暂存", ["01"]], ["待审核/待商家审核", ["07"]],
    ["待审核/待核销", ["20", "03"]], ["待审核/待发票核验", ["02"]],
    ["待审核/待审核", ["S01"]], ["已通过/审核通过", ["S02"]],
    ["已通过/核销成功", ["H02"]], ["已退回/发票核验未通过", ["04"]],
    ["已退回/商家审核未通过", ["08"]], ["已退回/核销未通过", ["H03"]],
    ["已退回/审核未通过", ["S03"]], ["已退回/审核已终止", ["S04"]]
  ]);
  const MATERIAL_MODIFICATION = new Set(["04", "08", "H03", "S03"]);
  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const parseJson = value => typeof value === "string" ? JSON.parse(value) : value;
  const parseRange = (value, name, required = false) => {
    if (!value && !required) return null;
    const parts = String(value).split("~").map(part => part.trim().replace(/\//g, ""));
    if (parts.length !== 2 || parts.some(part => !/^\d{8}$/.test(part))) throw new Error(name + "格式无法识别。");
    return parts;
  };
  const byLabel = (doc, label) => [...doc.querySelectorAll(".search-item")].find(item =>
    clean(item.querySelector("label")?.textContent).replace(/[＊*]/g, "") === label);
  const inputValue = (doc, label) => clean(byLabel(doc, label)?.querySelector("input")?.value);
  const selectedStatuses = item => {
    const tags = [...item.querySelectorAll(".el-tag__content")].map(tag => clean(tag.textContent)).filter(Boolean);
    if (!tags.length) {
      const text = clean(item.querySelector(".el-input__inner")?.value);
      if (text) throw new Error("订单状态筛选无法安全识别。");
      return [];
    }
    return [...new Set(tags.flatMap(tag => {
      const normalized = tag.replace(/\s+/g, "");
      const direct = STATUS_CODES.get(normalized);
      if (direct) return direct;
      const matches = [...STATUS_CODES].filter(([path]) => path.endsWith("/" + normalized));
      if (matches.length !== 1) throw new Error("订单状态筛选无法安全识别：" + tag);
      return matches[0][1];
    }))];
  };
  const readQuery = doc => {
    const tradeRange = parseRange(inputValue(doc, "交易日期"), "交易日期", true);
    const settlementRange = parseRange(inputValue(doc, "提交日期"), "提交日期");
    const statusItem = byLabel(doc, "订单状态");
    if (!statusItem) throw new Error("无法识别订单状态筛选。");
    const params = {
      merOrderId: inputValue(doc, "订单号"),
      transRef: inputValue(doc, "参考号"),
      beginTransDate: tradeRange[0], endTransDate: tradeRange[1],
      status: selectedStatuses(statusItem)
    };
    if (settlementRange) [params.beginTime, params.endTime] = settlementRange;
    return params;
  };
  const visiblePage = doc => {
    const tables = [...doc.querySelectorAll(".el-table")];
    if (tables.length !== 1) throw new Error("无法唯一识别当前订单列表。");
    const table = tables[0];
    const headers = [...table.querySelectorAll(".el-table__header-wrapper thead th")].map(cell => clean(cell.textContent).replace(/\s/g, ""));
    const orderColumn = headers.findIndex(value => /^(订单号|订单编号|业务订单号)$/.test(value));
    const referenceColumn = headers.findIndex(value => /^(参考号|检索参考号|交易参考号)$/.test(value));
    if (orderColumn < 0 || referenceColumn < 0) throw new Error("无法识别当前列表的订单身份列。");
    const rows = [...table.querySelectorAll(".el-table__body-wrapper tbody tr")].filter(row => row.querySelectorAll("td").length);
    const identities = rows.map(row => {
      const cells = [...row.querySelectorAll("td")];
      return { orderNo: clean(cells[orderColumn]?.textContent), referenceNo: clean(cells[referenceColumn]?.textContent) };
    });
    if (identities.some(identity => !identity.orderNo || !identity.referenceNo)) throw new Error("当前列表的订单身份不完整。");
    const pager = doc.querySelector(".el-pagination");
    const page = Number(pager?.querySelector(".el-pager .active")?.textContent);
    const totalText = clean(pager?.querySelector(".el-pagination__total")?.textContent);
    const total = Number(totalText.match(/共\s*(\d+)\s*条/)?.[1]);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(total)) throw new Error("无法识别当前列表页码或总数。");
    return { page, total, signature: identities.map(identity => identity.orderNo + "::" + identity.referenceNo).join("\n") };
  };
  const context = (doc, location) => {
    if (location.hash.split("?")[0] !== "#/auditOfTrade2026") throw new Error("请先返回已查询的订单列表。");
    const sizeText = doc.querySelector(".el-pagination__sizes select, .el-pagination__sizes .el-input__inner")?.value;
    const size = Number(String(sizeText || "").match(/^\s*(\d+)/)?.[1]);
    if (!Number.isInteger(size) || size < 1) throw new Error("无法识别订单分页大小。");
    return { url: location.href, filters: readQuery(doc), size, visiblePage: visiblePage(doc) };
  };
  const isReady = (doc, location) => {
    try {
      const resources = doc.defaultView?.performance?.getEntriesByType("resource") || [];
      context(doc, location);
      return doc.querySelectorAll(".el-pagination").length === 1 &&
        resources.some(entry => new URL(entry.name).pathname.endsWith("/portal/yjhx/v3/queryList"));
    }
    catch { return false; }
  };
  const signature = rows => rows.map(row => {
    const order = clean(row.merOrderId), reference = clean(row.transRef);
    return order + "::" + reference;
  }).join("\n");
  const request = async (path, body, token, fetcher = fetch) => {
    let response;
    try {
      response = await fetcher(API + path, {
        method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(50000),
        headers: { "Content-Type": "application/json;charset=UTF-8", "X-Requested-With": "XMLHttpRequest", userPortalToken: token },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw new Error(error.name === "TimeoutError" ? "网站接口请求超时。" : "网站接口连接失败。");
    }
    if (!response.ok) {
      const error = new Error([401, 403].includes(response.status) ? "登录状态已失效，请重新登录并恢复原查询。" : "网站接口请求失败：" + response.status);
      error.auth = [401, 403].includes(response.status);
      throw error;
    }
    if (response.headers?.get("content-type")?.includes("text/html")) {
      const error = new Error("登录状态已失效，请重新登录并恢复原查询。");
      error.auth = true;
      throw error;
    }
    let result;
    try { result = await response.json(); }
    catch { throw new Error("网站接口返回内容无法识别。"); }
    if (!(result?.success === true || result?.code === 0)) {
      const message = clean(result?.message);
      const auth = /登录|token|认证|未授权|过期/i.test(message);
      const error = new Error(auth ? "登录状态已失效，请重新登录并恢复原查询。" : message || "网站接口拒绝了请求。");
      error.auth = auth;
      throw error;
    }
    return result.data;
  };
  const makeClient = (token, fetcher) => {
    if (!token) throw new Error("登录状态已失效，请重新登录并恢复原查询。");
    return {
      async list(filters, current, size) {
        const data = await request("portal/yjhx/v3/queryList", { ...filters, current, size }, token, fetcher);
        if (!Array.isArray(data?.list) || !Number.isInteger(Number(data.total))) throw new Error("订单列表接口响应不完整。");
        return { rows: data.list, total: Number(data.total) };
      },
      async assets(row, origin) {
        if (!row?.mchntId || !row?.id) throw new Error("订单详情身份字段缺失。");
        const detail = await request("portal/yjhx/v3/queryDtl", { mchntId: row.mchntId, uuid: row.id }, token, fetcher);
        if (!detail?.templateId) throw new Error("订单详情接口未返回模板编号。");
        const templateData = await request("portal/yjhx/v3/queryTemplateInfo/" + encodeURIComponent(detail.templateId), {}, token, fetcher);
        const product = parseJson(detail.productJson);
        const groups = parseJson(templateData?.productJson);
        if (!product || typeof product !== "object" || !Array.isArray(groups)) throw new Error("订单图片字段无法识别。");
        const found = {};
        for (const item of groups.flatMap(group => Array.isArray(group?.its) ? group.its : [])) {
          if (item?.type !== "img") continue;
          const kind = globalThis.PIC_EXPERT_PAGE_CORE.assetKind(item.desc || item.name);
          if (!kind || !item.key) continue;
          const value = clean(product[item.key]);
          if (!value) continue;
          const url = imageUrl(value, origin, token);
          (found[kind] ||= new Set()).add(url);
        }
        return Object.fromEntries([...globalThis.PIC_EXPERT_CORE.ASSET_KINDS].map(kind => {
          const urls = [...(found[kind] || [])];
          return [kind, { url: urls.length === 1 ? urls[0] : null, ambiguous: urls.length > 1 }];
        }));
      }
    };
  };
  const imageUrl = (value, origin, token) => {
    let url;
    try {
      url = /^https?:\/\//i.test(value) ? new URL(value) : new URL(IMAGE + encodeURIComponent(value), origin);
    } catch { throw new Error("图片地址无法识别。"); }
    if (url.origin !== origin || !url.pathname.includes("/img/tradein/download/")) throw new Error("图片地址不属于订单图片接口。");
    url.searchParams.set("userPortalToken", token);
    return url.href;
  };
  globalThis.PIC_EXPERT_SITE_API = Object.freeze({ context, isReady, signature, makeClient, imageUrl, MATERIAL_MODIFICATION });
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.PIC_EXPERT_SITE_API;
})();
