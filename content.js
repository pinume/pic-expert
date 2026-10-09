(() => {
  if (globalThis.__PIC_EXPERT_CONTENT_INSTALLED__) return;
  globalThis.__PIC_EXPERT_CONTENT_INSTALLED__ = true;
  const CORE = globalThis.PIC_EXPERT_PAGE_CORE;
  const FILES = globalThis.PIC_EXPERT_CORE;
  const SITE = globalThis.PIC_EXPERT_SITE_API;
  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let running = false, stopped = false, pauseRequested = false, forcePauseRequested = false, activeTaskId = null;
  let requestController = null;
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
  const pageContext = () => SITE.context(document, location);
  const legacyFilters = () => [...document.querySelectorAll(".search-item")].map(item => {
    const input = item.querySelector("input");
    return input ? { label: clean(item.querySelector("label")?.textContent || item.firstChild?.textContent), value: input.value } : null;
  }).filter(Boolean);
  const taskFetch = async (url, options = {}) => {
    const signal = AbortSignal.any([requestController.signal, options.signal].filter(Boolean));
    try { return await fetch(url, { ...options, signal }); }
    catch (error) { if (signal.aborted) throw signal.reason; throw error; }
  };
  const getClient = () => SITE.makeClient(globalThis.localStorage?.getItem("userPortalVerifyToken"), taskFetch);
  const prepareAsset = async url => {
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await taskFetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(30000) });
        if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 1) break;
      } catch (error) {
        if (requestController.signal.aborted || attempt === 1 || !["TypeError", "TimeoutError", "AbortError"].includes(error.name)) throw error;
      }
      await log("读取重试", "图片网络读取失败，等待 1 秒后重试一次");
      await sleep(1000);
    }
    if ([401, 403].includes(response.status)) {
      const error = new Error("登录状态已失效，请重新登录并恢复原查询。");
      error.auth = true;
      throw error;
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
  const processRow = async (row, client, taskId, ensureActive, note) => {
    const id = identity(row), empty = { ...id, ...FILES.manifestFiles() };
    if (!id.orderNo || !id.referenceNo) return { ...empty, result: "失败", reason: "订单号或参考号缺失" };
    const reason = message => [note, message].filter(Boolean).join("；");
    try {
      await log("读取详情", "订单 " + id.orderNo + "，参考号 " + id.referenceNo);
      const states = await client.assets(row, location.origin);
      ensureActive();
      if (FILES.REQUIRED_KINDS.some(kind => !states[kind]?.length)) {
        return { ...empty, result: "跳过", reason: reason("SN码或发票图片缺失") };
      }
      for (const kind of FILES.PROOF_KINDS) {
        if (states[kind].length > 1) throw new Error(kind + "图片不唯一，已停止该订单下载。");
      }
      const assets = Object.fromEntries(FILES.ASSET_KINDS.flatMap(kind => states[kind].map((url, i, urls) =>
        [urls.length > 1 ? kind + "-" + (i + 1) : kind, url])));
      const kinds = Object.keys(assets);
      const prepared = {};
      let cursor = 0;
      const readers = Array.from({ length: Math.min(2, kinds.length) }, async () => {
        while (cursor < kinds.length) {
          ensureActive();
          const kind = kinds[cursor++];
          await log("读取图片", kind + "：验证图片格式");
          try { prepared[kind] = await prepareAsset(assets[kind]); }
          catch (error) {
            if (error.auth) { requestController.abort(error); throw error; }
            throw new Error(kind + "：" + error.message);
          }
        }
      });
      const results = await Promise.allSettled(readers);
      const failure = results.find(result => result.status === "rejected" && result.reason.auth) ||
        results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      for (const kind of FILES.PROOF_KINDS) if (!assets[kind]) await log("证明材料", kind + "为空，跳过");
      ensureActive();
      const downloaded = await checkedSend({ type: "PIC_EXPERT_DOWNLOAD_PAIR", taskId, ...id, assets: prepared, note });
      return { ...id, result: "成功", reason: note, ...FILES.manifestFiles(downloaded.files) };
    } catch (error) {
      if (error.auth || error.fatal) { requestController.abort(error); throw error; }
      return { ...empty, result: "失败", reason: reason(error.message), ...FILES.manifestFiles(error.files) };
    }
  };
  const loadPage = async (client, context, page, total = null) => {
    const result = await client.list(context.filters, page, context.size);
    if (!Number.isInteger(result.total) || result.total < 0) throw new Error("接口返回的订单总数无效，已停止。");
    if (total !== null && result.total !== total) throw new Error("接口返回的查询总数发生变化，已停止。");
    const expected = Math.max(0, Math.min(context.size, result.total - page * context.size));
    if (result.rows.length !== expected) throw new Error("接口分页条数与查询总数不一致，已停止。");
    if (result.rows.some(row => !identity(row).orderNo || !identity(row).referenceNo)) throw new Error("订单列表缺少订单号或参考号，已停止。");
    return result;
  };
  const run = async (taskId, checkpoint = null) => {
    running = true; pauseRequested = false; forcePauseRequested = false; stopped = false; activeTaskId = taskId;
    requestController = new AbortController();
    const seen = new Set();
    let visited = 0, failure = null, haltPromise, listing = true;
    const halt = error => {
      if (!failure) {
        failure = requestController.signal.aborted ? requestController.signal.reason : error;
        requestController.abort(failure);
        haltPromise = checkedSend({ type: "PIC_EXPERT_TASK_HALT", taskId, error: failure.message }).catch(() => {});
      }
      return haltPromise;
    };
    try {
      const initialContext = pageContext();
      let listSize = checkpoint ? checkpoint.size || initialContext.size : initialContext.listSize || initialContext.size;
      const readAll = Boolean(initialContext.listSize) && listSize >= initialContext.listSize;
      let context = { ...initialContext, size: listSize };
      const initialQuery = JSON.stringify(initialContext.filters);
      const initialVisiblePage = JSON.stringify(initialContext.visiblePage);
      const ensureContextUnchanged = () => {
        const current = pageContext();
        if (JSON.stringify(current.filters) !== initialQuery || current.url !== initialContext.url ||
          current.size !== initialContext.size || JSON.stringify(current.visiblePage) !== initialVisiblePage) {
          const error = new Error("任务运行期间查询条件或页面发生变化。");
          error.fatal = true;
          throw error;
        }
        return { ...current, size: listSize };
      };
      const ensureActive = () => {
        requestController.signal.throwIfAborted();
        context = ensureContextUnchanged();
      };
      if (checkpoint) {
        if (context.url !== checkpoint.url || (!initialContext.listSize && checkpoint.size && initialContext.size !== checkpoint.size) ||
          (checkpoint.query && JSON.stringify(context.filters) !== JSON.stringify(checkpoint.query)) ||
          (!checkpoint.query && JSON.stringify(legacyFilters()) !== JSON.stringify(checkpoint.filters))) {
          throw new Error("当前查询与断点不同，请手动恢复原查询；扩展不会调整日期或点击查询。");
        }
        if (!Number.isInteger(checkpoint.page) || checkpoint.page < 1 || (checkpoint.total !== null && !Number.isInteger(checkpoint.total))) {
          throw new Error("旧版断点信息不完整，无法安全继续；请开始新任务。");
        }
      }
      await checkedSend({ type: "PIC_EXPERT_LIST_BEGIN", taskId, checkpoint: {
        url: context.url, page: 1, total: null, signature: null,
        query: context.filters, size: context.size, visitedBefore: 0
      } });
      const client = getClient();
      await log("任务启动", "先通过网站接口读取完整订单列表");
      let displayedPage = await loadPage(client, readAll ? context : initialContext,
        readAll ? 0 : initialContext.visiblePage.page - 1, checkpoint?.total ?? null);
      if (readAll && displayedPage.total > listSize) {
        listSize = displayedPage.total;
        context = ensureContextUnchanged();
        displayedPage = await loadPage(client, context, 0, displayedPage.total);
        await checkedSend({ type: "PIC_EXPERT_CHECKPOINT", taskId, checkpoint: {
          url: context.url, page: 1, total: displayedPage.total, signature: null,
          query: context.filters, size: listSize, visitedBefore: 0
        } });
      }
      const visibleStart = (initialContext.visiblePage.page - 1) * initialContext.size;
      const visibleRows = readAll ? displayedPage.rows.slice(visibleStart, visibleStart + initialContext.size) : displayedPage.rows;
      if (!context.hasOtherFilters && (displayedPage.total !== initialContext.visiblePage.total ||
        SITE.signature(visibleRows) !== initialContext.visiblePage.signature)) {
        throw new Error("接口结果与页面当前查询不一致，任务暂停；请重新执行查询后再继续。");
      }
      const total = displayedPage.total;
      const pageCount = Math.max(1, Math.ceil(total / context.size));
      for (let page = 0; page < pageCount; page++) {
        ensureActive();
        if (pauseRequested) throw new Error("列表读取已暂停。");
        const result = (readAll && page === 0) || (!readAll && context.size === initialContext.size && page === initialContext.visiblePage.page - 1)
          ? displayedPage : await loadPage(client, context, page, total);
        ensureActive();
        if (checkpoint?.signature && page + 1 === checkpoint.page && SITE.signature(result.rows) !== checkpoint.signature) {
          throw new Error("断点页订单集合已变化，不能安全继续。");
        }
        const saved = (await checkedSend({ type: "PIC_EXPERT_LIST_GET", taskId, page: page + 1 })).page;
        if (saved && SITE.signature(saved.rows) !== SITE.signature(result.rows)) {
          throw new Error("已保存的订单列表发生变化，不能安全继续。");
        }
        for (const row of result.rows) {
          const id = identity(row), key = id.orderNo + "::" + id.referenceNo;
          if (seen.has(key)) throw new Error("查询结果出现重复订单身份，任务暂停。");
          seen.add(key);
        }
        await checkedSend({ type: "PIC_EXPERT_LIST_PAGE", taskId, page: page + 1, total, rows: result.rows });
      }
      if (seen.size !== total) throw new Error("扫描条数与查询总条数不一致，任务暂停。");
      ensureActive();
      if (pauseRequested) throw new Error("列表读取已暂停。");
      await checkedSend({ type: "PIC_EXPERT_LIST_COMPLETE", taskId });
      listing = false;
      for (let page = 0; page < pageCount; page++) {
        ensureActive();
        if (pauseRequested) throw new Error("已等待在途订单结束，任务暂停。");
        const result = (await checkedSend({ type: "PIC_EXPERT_LIST_GET", taskId, page: page + 1 })).page;
        if (!result) throw new Error("已保存的订单列表缺失，请停止并开始新任务。");
        await checkedSend({ type: "PIC_EXPERT_CHECKPOINT", taskId, checkpoint: {
          url: context.url, page: page + 1, total, signature: SITE.signature(result.rows),
          query: context.filters, size: context.size, visitedBefore: visited
        } });
        let cursor = 0;
        const workers = Array.from({ length: Math.min(3, result.rows.length) }, async () => {
          while (!pauseRequested && !stopped && !failure && cursor < result.rows.length) {
            const row = result.rows[cursor++], id = identity(row);
            try {
              ensureActive();
              visited += 1;
              if (visited > total) throw new Error("扫描条数超过原查询总条数。");
              const status = await checkedSend({ type: "PIC_EXPERT_ROW_STATUS", taskId, identity: id });
              if (status.done) continue;
              if (pauseRequested || stopped || failure) return;
              ensureActive();
              const note = CORE.isMaterialModification([row.statusDesc, row.statusText].join(" ")) ? "材料修改" : "";
              await checkedSend({ type: "PIC_EXPERT_ROW_BEGIN", taskId, identity: id, note });
              const outcome = await processRow(row, client, taskId, ensureActive, note);
              ensureActive();
              await checkedSend({ type: "PIC_EXPERT_MANIFEST_ROW", taskId, row: outcome });
            } catch (error) {
              if (!stopped && !forcePauseRequested) await halt(error);
              return;
            }
          }
        });
        await Promise.allSettled(workers);
        if (failure) throw failure;
        ensureActive();
        if (pauseRequested) throw new Error("已等待在途订单结束，任务暂停。");
      }
      if (visited !== total) throw new Error("扫描条数与查询总条数不一致，已停止。");
      ensureContextUnchanged();
      await checkedSend({ type: "PIC_EXPERT_TASK_END", taskId, status: "completed" });
    } catch (error) {
      error = failure || (requestController.signal.aborted ? requestController.signal.reason : error);
      if (!stopped && (error.auth || listing && !forcePauseRequested && !pauseRequested)) {
        await log("自动暂停", error.message, "error");
        await checkedSend({ type: "PIC_EXPERT_TASK_AUTO_PAUSE", taskId, error: error.message });
        return;
      }
      if (pauseRequested && !failure && !stopped) {
        await log("暂停任务", error.message);
        await chrome.runtime.sendMessage({ type: "PIC_EXPERT_TASK_PAUSED", taskId, error: stopped ? error.message : "" }).catch(() => {});
        return;
      }
      await log("任务中断", error.message, "error");
      await chrome.runtime.sendMessage({ type: "PIC_EXPERT_TASK_END", taskId, status: "failed", error: error.message }).catch(() => {});
    } finally { running = false; activeTaskId = null; requestController = null; }
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
    if (message?.type === "PIC_EXPERT_STOP") {
      stopped = true; requestController?.abort(new Error("用户停止任务。"));
      sendResponse({ ok: true, running }); return false;
    }
    if (message?.type === "PIC_EXPERT_PAUSE") {
      pauseRequested = true;
      if (message.force) {
        forcePauseRequested = true;
        requestController?.abort(new Error("立即暂停当前等待。"));
      }
      sendResponse({ ok: true, running }); return false;
    }
    if (message?.type !== "PIC_EXPERT_START") return false;
    if (running) { sendResponse({ ok: false, error: "当前页面已有任务。" }); return false; }
    running = true; stopped = false; pauseRequested = false;
    sendResponse({ ok: true });
    void run(message.taskId, message.checkpoint || null);
    return false;
  });
  if (typeof module !== "undefined" && module.exports) module.exports = { run };
})();
