(() => {
  if (globalThis.__PIC_EXPERT_CONTENT_INSTALLED__) return;
  globalThis.__PIC_EXPERT_CONTENT_INSTALLED__ = true;
  const CORE = globalThis.PIC_EXPERT_PAGE_CORE;
  const FILES = globalThis.PIC_EXPERT_CORE;
  const SITE = globalThis.PIC_EXPERT_SITE_API;
  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let running = false, stopped = false, pauseRequested = false, activeTaskId = null;
  const log = async (stage, message, level = "info") => {
    console[level === "error" ? "error" : "info"]?.("[Pic Expert] " + stage + "：" + message);
    if (activeTaskId) await chrome.runtime.sendMessage({ type: "PIC_EXPERT_LOG", taskId: activeTaskId, stage, message, level }).catch(() => {});
  };
  const checkedSend = async message => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      const error = new Error(response?.error || "后台任务无响应。");
      error.files = response?.files;
      throw error;
    }
    return response;
  };
  const wait = async (predicate, reason, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (stopped) throw new Error("用户停止任务。");
      const value = predicate();
      if (value) return value;
      await sleep(200);
    }
    throw new Error(reason);
  };
  const pageContext = () => SITE.context(document, location);
  const legacyFilters = () => [...document.querySelectorAll(".search-item")].map(item => {
    const input = item.querySelector("input");
    return input ? { label: clean(item.querySelector("label")?.textContent || item.firstChild?.textContent), value: input.value } : null;
  }).filter(Boolean);
  const getClient = () => SITE.makeClient(globalThis.localStorage?.getItem("userPortalVerifyToken"));
  const prepareAsset = async url => {
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(30000) });
        if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 1) break;
      } catch (error) {
        if (attempt === 1 || !["TypeError", "TimeoutError", "AbortError"].includes(error.name)) throw error;
      }
      await log("读取重试", "图片网络读取失败，等待 1 秒后重试一次");
      await sleep(1000);
    }
    if (!response.ok) throw new Error("图片读取失败：" + response.status);
    if (response.headers?.get("content-type")?.includes("text/html")) {
      const error = new Error("图片接口返回了登录页面，请重新登录并恢复原查询。");
      error.auth = true;
      throw error;
    }
    const blob = await response.blob();
    const format = FILES.imageFormat(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
    const urlData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("图片读取失败。"));
      reader.readAsDataURL(new Blob([blob], { type: format.mime }));
    });
    return { url: urlData, extension: format.extension };
  };
  const identity = row => ({ orderNo: clean(row.merOrderId), referenceNo: clean(row.transRef) });
  const processRow = async (row, client, taskId) => {
    const id = identity(row), empty = { ...id, ...FILES.manifestFiles() };
    if (!id.orderNo || !id.referenceNo) return { ...empty, result: "失败", reason: "订单号或参考号缺失" };
    if (SITE.MATERIAL_MODIFICATION.has(String(row.status)) || CORE.isMaterialModification(row.statusDesc || row.statusText)) {
      return { ...empty, result: "跳过", reason: "材料修改" };
    }
    try {
      await log("读取详情", "订单 " + id.orderNo + "，参考号 " + id.referenceNo);
      const states = await client.assets(row, location.origin);
      const assets = Object.fromEntries(Object.entries(states).map(([kind, state]) => [kind, state.url]));
      if (FILES.REQUIRED_KINDS.some(kind => !assets[kind])) {
        return { ...empty, result: "跳过", reason: "SN码或发票图片缺失或不唯一" };
      }
      for (const kind of FILES.PROOF_KINDS) {
        if (states[kind].ambiguous) throw new Error(kind + "图片不唯一，已停止该订单下载。");
      }
      const kinds = FILES.ASSET_KINDS.filter(kind => assets[kind]);
      const prepared = {};
      let cursor = 0;
      const readers = Array.from({ length: Math.min(2, kinds.length) }, async () => {
        while (cursor < kinds.length) {
          const kind = kinds[cursor++];
          await log("读取图片", kind + "：验证图片格式");
          try { prepared[kind] = await prepareAsset(assets[kind]); }
          catch (error) {
            if (error.auth) throw error;
            throw new Error(kind + "：" + error.message);
          }
        }
      });
      const results = await Promise.allSettled(readers);
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      for (const kind of FILES.PROOF_KINDS) if (!assets[kind]) await log("证明材料", kind + "为空，跳过");
      const downloaded = await checkedSend({ type: "PIC_EXPERT_DOWNLOAD_PAIR", taskId, ...id, assets: prepared });
      return { ...id, result: "成功", reason: "", ...FILES.manifestFiles(downloaded.files) };
    } catch (error) {
      if (error.auth) throw error;
      return { ...empty, result: "失败", reason: error.message, ...FILES.manifestFiles(error.files) };
    }
  };
  const loadPage = async (client, context, page, total = null) => {
    const result = await client.list(context.filters, page, context.size);
    if (total !== null && result.total !== total) throw new Error("接口返回的查询总数发生变化，已停止。");
    const expected = Math.max(0, Math.min(context.size, result.total - page * context.size));
    if (result.rows.length !== expected) throw new Error("接口分页条数与查询总数不一致，已停止。");
    if (result.rows.some(row => !identity(row).orderNo || !identity(row).referenceNo)) throw new Error("订单列表缺少订单号或参考号，已停止。");
    return result;
  };
  const run = async (taskId, checkpoint = null) => {
    pauseRequested = false; stopped = false; activeTaskId = taskId;
    const seen = new Set();
    let visited = checkpoint?.visitedBefore || 0;
    try {
      const initialContext = pageContext();
      let context = initialContext;
      const initialQuery = JSON.stringify(initialContext.filters);
      const initialVisiblePage = JSON.stringify(initialContext.visiblePage);
      const ensureContextUnchanged = () => {
        const current = pageContext();
        if (JSON.stringify(current.filters) !== initialQuery || current.url !== initialContext.url ||
          current.size !== initialContext.size || JSON.stringify(current.visiblePage) !== initialVisiblePage) {
          throw new Error("任务运行期间查询条件或页面发生变化。");
        }
        return current;
      };
      const client = getClient();
      if (checkpoint) {
        if (context.url !== checkpoint.url || (checkpoint.size && context.size !== checkpoint.size) ||
          (checkpoint.query && JSON.stringify(context.filters) !== JSON.stringify(checkpoint.query)) ||
          (!checkpoint.query && JSON.stringify(legacyFilters()) !== JSON.stringify(checkpoint.filters))) {
          throw new Error("当前查询与断点不同，请手动恢复原查询；扩展不会调整日期或点击查询。");
        }
        if (!Number.isInteger(checkpoint.page) || checkpoint.page < 1 || !Number.isInteger(checkpoint.total)) {
          throw new Error("旧版断点信息不完整，无法安全继续；请开始新任务。");
        }
      }
      await log("任务启动", "通过网站接口读取当前查询的全部分页");
      const displayedPage = await loadPage(client, context, initialContext.visiblePage.page - 1);
      if (displayedPage.total !== initialContext.visiblePage.total || SITE.signature(displayedPage.rows) !== initialContext.visiblePage.signature) {
        throw new Error("接口结果与页面当前查询不一致，已停止；请重新执行查询后再开始。");
      }
      let page = checkpoint ? checkpoint.page - 1 : 0;
      let result = page === initialContext.visiblePage.page - 1
        ? displayedPage : await loadPage(client, context, page, checkpoint?.total ?? null);
      const total = result.total;
      if (checkpoint && (SITE.signature(result.rows) !== checkpoint.signature || total !== checkpoint.total)) {
        throw new Error("断点页订单集合已变化，不能安全继续。");
      }
      while (true) {
        const pageSignature = SITE.signature(result.rows);
        await checkedSend({ type: "PIC_EXPERT_CHECKPOINT", taskId, checkpoint: {
          url: context.url, page: page + 1, total, signature: pageSignature,
          filters: legacyFilters(), query: context.filters, size: context.size, visitedBefore: visited
        } });
        for (const row of result.rows) {
          if (pauseRequested) throw new Error("已在订单边界暂停。");
          if (stopped) throw new Error("用户停止任务。");
          context = ensureContextUnchanged();
          const id = identity(row), key = id.orderNo + "::" + id.referenceNo;
          visited += 1;
          if (visited > total) throw new Error("扫描条数超过原查询总条数。");
          if (seen.has(key)) throw new Error("查询结果出现重复订单身份，已停止。");
          seen.add(key);
          const status = await checkedSend({ type: "PIC_EXPERT_ROW_STATUS", taskId, identity: id });
          if (status.done) continue;
          await checkedSend({ type: "PIC_EXPERT_ROW_BEGIN", taskId, identity: id });
          let outcome;
          try { outcome = await processRow(row, client, taskId); }
          catch (error) {
            if (error.auth) throw error;
            outcome = { ...id, result: "失败", reason: error.message, ...FILES.manifestFiles() };
          }
          await checkedSend({ type: "PIC_EXPERT_MANIFEST_ROW", taskId, row: outcome });
        }
        if (pauseRequested) throw new Error("已在订单边界暂停。");
        if ((page + 1) * context.size >= total) break;
        page += 1;
        ensureContextUnchanged();
        result = await loadPage(client, context, page, total);
      }
      if (visited !== total) throw new Error("扫描条数与查询总条数不一致，已停止。");
      ensureContextUnchanged();
      await checkedSend({ type: "PIC_EXPERT_TASK_END", taskId, status: "completed" });
    } catch (error) {
      if (pauseRequested) {
        await log("暂停任务", error.message);
        await chrome.runtime.sendMessage({ type: "PIC_EXPERT_TASK_PAUSED", taskId, error: stopped ? error.message : "" }).catch(() => {});
        return;
      }
      await log("任务中断", error.message, "error");
      await chrome.runtime.sendMessage({ type: "PIC_EXPERT_TASK_END", taskId, status: "failed", error: error.message }).catch(() => {});
    } finally { running = false; activeTaskId = null; }
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PIC_EXPERT_PROBE") {
      const ready = SITE.isReady(document, location);
      let tradeDateRange = null;
      if (ready) {
        try {
          const { filters } = pageContext();
          tradeDateRange = [filters.beginTransDate, filters.endTransDate];
        } catch {}
      }
      sendResponse({ ok: true, ready, running, tradeDateRange }); return false;
    }
    if (message?.type === "PIC_EXPERT_STOP") { stopped = true; sendResponse({ ok: true }); return false; }
    if (message?.type === "PIC_EXPERT_PAUSE") { pauseRequested = true; sendResponse({ ok: true, running }); return false; }
    if (message?.type !== "PIC_EXPERT_START") return false;
    if (running) { sendResponse({ ok: false, error: "当前页面已有任务。" }); return false; }
    running = true; stopped = false; pauseRequested = false;
    sendResponse({ ok: true });
    void run(message.taskId, message.checkpoint || null);
    return false;
  });
  if (typeof module !== "undefined" && module.exports) module.exports = { run };
})();
