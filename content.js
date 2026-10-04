(() => {
  if (globalThis.__PIC_EXPERT_CONTENT_INSTALLED__) return;
  globalThis.__PIC_EXPERT_CONTENT_INSTALLED__ = true;
  const CORE = globalThis.PIC_EXPERT_PAGE_CORE;
  const FILES = globalThis.PIC_EXPERT_CORE;
  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const visible = e => e instanceof Element && e.getClientRects().length > 0 &&
    getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const all = (selector, scope = document) => [...scope.querySelectorAll(selector)].filter(visible);
  let running = false, stopped = false;
  let activeTaskId = null;
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
  const currentTable = () => {
    const tables = [
      ...all(".el-table").map(root => ({
        root, header: root.querySelector(".el-table__header-wrapper"),
        body: root.querySelector(".el-table__body-wrapper")
      })),
      ...all("table").filter(t => !t.closest(".el-table")).map(t => ({ root: t, header: t, body: t }))
    ].filter(t => t.header && t.body).map(t => {
      const headers = [...t.header.querySelectorAll("thead th")].map(e => clean(e.textContent));
      const columns = CORE.inferColumns(headers);
      const rows = all("tbody tr", t.body).filter(r => r.querySelectorAll("td").length);
      return { ...t, columns, rows };
    }).filter(t => t.rows.length && Object.values(t.columns).every(i => i >= 0));
    return tables.length === 1 ? tables[0] : null;
  };
  const identity = (row, columns) => {
    const cells = [...row.querySelectorAll("td")];
    return { orderNo: clean(cells[columns.orderNo]?.textContent), referenceNo: clean(cells[columns.referenceNo]?.textContent) };
  };
  const key = value => value.orderNo + "::" + value.referenceNo;
  const signature = () => {
    const table = currentTable();
    return table ? table.rows.map(r => key(identity(r, table.columns))).join("\n") : "";
  };
  const loading = () => all(".el-loading-mask").length > 0;
  const pager = () => {
    const scopes = all(".el-pagination");
    if (scopes.length !== 1) throw new Error("无法唯一识别分页控件。");
    const scope = scopes[0];
    const page = Number(scope.querySelector(".el-pager .active")?.textContent);
    const totalText = clean(scope.querySelector(".el-pagination__total")?.textContent);
    const total = Number(totalText.match(/共\s*(\d+)\s*条/)?.[1]);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(total)) throw new Error("无法识别当前页码或总条数。");
    return { scope, page, total };
  };
  const disabled = e => !e || e.disabled || e.getAttribute("aria-disabled") === "true" || e.classList.contains("is-disabled");
  const waitPage = async (target, total, previousSignature) => {
    let candidate = "", stableSince = 0;
    await wait(() => {
      const after = pager(), value = signature();
      if (loading() || after.page !== target || after.total !== total || !value || value === previousSignature) {
        candidate = ""; return false;
      }
      if (candidate !== value) { candidate = value; stableSince = Date.now(); return false; }
      return Date.now() - stableSince >= 600;
    }, "翻页后页码或订单结果未能确认。");
  };
  const pageStep = async direction => {
    const before = pager();
    const previousSignature = signature();
    const button = before.scope.querySelector(direction > 0 ? ".btn-next" : ".btn-prev");
    if (disabled(button)) return false;
    await log("翻页", before.page + " → " + (before.page + direction));
    button.click();
    await waitPage(before.page + direction, before.total, previousSignature);
    await log("翻页", "目标页订单集合已确认");
    return true;
  };
  const goToPage = async target => {
    const before = pager();
    if (before.page === target) return;
    await log("恢复页码", before.page + " → " + target);
    const previousSignature = signature();
    const numbers = all(".el-pager .number", before.scope).filter(e => Number(e.textContent) === target);
    const jump = all(".el-pagination__jump input", before.scope);
    if (numbers.length === 1 && !disabled(numbers[0])) numbers[0].click();
    else if (jump.length === 1 && !disabled(jump[0])) {
      setPageInput(jump[0], String(target));
      jump[0].dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    } else {
      while (pager().page !== target) {
        if (!await pageStep(pager().page < target ? 1 : -1)) throw new Error("无法恢复原查询页码。");
      }
      return;
    }
    await waitPage(target, before.total, previousSignature);
  };
  const snapshot = () => ({
    url: location.href, signature: signature(), ...((({ page, total }) => ({ page, total }))(pager())),
    filters: all(".search-item").map(item => {
      const input = item.querySelector("input");
      return input ? { label: clean(item.querySelector("label")?.textContent || item.firstChild?.textContent),
        value: input.value } : null;
    }).filter(Boolean)
  });
  const setPageInput = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const restoreList = async checkpoint => {
    await log("返回列表", "返回原列表；仅核对已有查询，不修改条件或执行查询");
    const destination = new URL(checkpoint.url);
    if (destination.origin !== location.origin || destination.pathname !== location.pathname ||
      destination.hash.split("?")[0] !== "#/auditOfTrade2026") throw new Error("无法安全返回原查询页面。");
    if (location.hash !== destination.hash) location.hash = destination.hash;
    await wait(() => !loading() && currentTable() && all(".group-manager-container-float2.trade-in").length === 0,
      "返回后原查询结果未保留，请手动恢复原列表后重新开始；扩展不会修改日期或执行查询。");
    const restored = snapshot();
    if (JSON.stringify(restored.filters) !== JSON.stringify(checkpoint.filters) || restored.total !== checkpoint.total) {
      throw new Error("返回后原查询条件或总条数未保留，已停止；扩展不会修改日期或执行查询。");
    }
    await goToPage(checkpoint.page);
    if (signature() !== checkpoint.signature) throw new Error("返回后的订单集合与原查询不同，已停止。");
    await log("返回列表", "原查询条件、页码和订单集合已确认");
  };
  const inspectAssets = scope => {
    const result = {};
    for (const kind of FILES.ASSET_KINDS) {
      const containers = all(".image-container1", scope).filter(e => CORE.assetKind(e.querySelector("p")?.textContent) === kind);
      const images = containers.flatMap(e => all("img.el-image__inner", e));
      let pending = containers.some(e => all(".el-image__loading", e).length > 0);
      // Generic dialogs use local field containers, never climb into sibling image groups.
      if (!containers.length) {
        for (const field of all(".el-form-item,.ant-form-item", scope)) {
          if (CORE.assetKind(field.querySelector("label")?.textContent) !== kind) continue;
          images.push(...all("img", field));
          pending ||= all(".el-image__loading", field).length > 0;
        }
      }
      const urls = [...new Set(images.filter(i => i.complete && i.naturalWidth > 0).map(i => i.currentSrc || i.src).filter(Boolean))];
      pending ||= images.some(i => !i.complete || i.naturalWidth <= 0);
      result[kind] = { url: CORE.chooseUnique(urls), pending, ambiguous: urls.length > 1 };
    }
    return result;
  };
  const findAssets = scope => Object.fromEntries(Object.entries(inspectAssets(scope)).map(([kind, state]) => [kind, state.url]));
  const prepareAsset = async url => {
    const response = await fetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("图片读取失败：" + response.status);
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
  const detailScope = orderNo => {
    const standalone = all(".group-manager-container-float2.trade-in").filter(e => CORE.hasIdentity(clean(e.textContent), orderNo));
    if (standalone.length === 1) return { element: standalone[0], standalone: true };
    // Select inner dialogs, excluding their outer wrappers.
    const dialogs = all('[role="dialog"],.el-dialog,.ant-modal,.layui-layer,.modal-dialog')
      .filter(e => CORE.hasIdentity(clean(e.textContent), orderNo));
    const leaves = dialogs.filter(e => !dialogs.some(other => other !== e && e.contains(other)));
    return leaves.length === 1 ? { element: leaves[0], standalone: false } : null;
  };
  const returnToList = async (detail, checkpoint) => {
    if (detail.standalone) return restoreList(checkpoint);
    const closes = all("button,a,[role=button]", detail.element).filter(e =>
      /^(关闭|取消|返回|×|✕)$/.test(clean(e.textContent)) || /^(关闭|Close)$/i.test(e.getAttribute("aria-label") || ""));
    if (closes.length !== 1) throw new Error("无法唯一识别详情关闭入口。");
    closes[0].click();
    await wait(() => !visible(detail.element) && currentTable(), "详情未能安全关闭。");
    if (signature() !== checkpoint.signature || pager().page !== checkpoint.page) throw new Error("详情关闭后订单列表发生变化。");
  };
  const processRow = async (row, table, taskId) => {
    const id = identity(row, table.columns);
    const empty = { ...id, ...FILES.manifestFiles() };
    if (!id.orderNo || !id.referenceNo) return { ...empty, result: "跳过", reason: "订单号或参考号缺失" };
    const clones = all(".el-table__fixed-body-wrapper", table.root).flatMap(body => all("tbody tr", body))
      .filter(other => key(identity(other, table.columns)) === key(id));
    const matchingRows = [row, ...clones];
    if (matchingRows.some(other => CORE.isMaterialModification(other.textContent))) return { ...empty, result: "跳过", reason: "材料修改" };
    const rowControls = other => {
      const cell = other.querySelectorAll("td")[table.columns.operation];
      return cell ? all("button,a,[role=button]", cell).filter(e => /^(查看详情|详情)$/.test(clean(e.textContent))) : [];
    };
    const mainControls = rowControls(row);
    const controls = mainControls.length ? mainControls : [...new Set(clones.flatMap(rowControls))];
    if (controls.length !== 1) return { ...empty, result: "失败", reason: "详情入口不唯一" };
    const checkpoint = snapshot();
    await log("打开详情", "订单 " + id.orderNo + "，参考号 " + id.referenceNo);
    controls[0].click();
    const detail = await wait(() => detailScope(id.orderNo), "详情未打开或订单身份不匹配。");
    await log("打开详情", "订单身份已确认");
    let result;
    try {
      // Wait for detail data and image rendering; DOM absence immediately after navigation is not missing data.
      await sleep(600);
      const deadline = Date.now() + 8000;
      let assets, states;
      do {
        states = inspectAssets(detail.element);
        assets = Object.fromEntries(Object.entries(states).map(([kind, state]) => [kind, state.url]));
        if (FILES.REQUIRED_KINDS.every(kind => assets[kind]) && FILES.PROOF_KINDS.every(kind => !states[kind].pending)) break;
        if (stopped) throw new Error("用户停止任务。");
        await sleep(250);
      } while (Date.now() < deadline);
      if (!assets["SN码"] || !assets["发票"]) {
        result = { ...empty, result: "跳过", reason: "SN码或发票图片缺失、未加载或不唯一" };
      } else {
        for (const kind of FILES.PROOF_KINDS) {
          if (states[kind].ambiguous || states[kind].pending) throw new Error(kind + "图片未加载或不唯一，已停止该订单下载。");
        }
        const prepared = {};
        for (const kind of FILES.ASSET_KINDS) {
          if (assets[kind]) {
            await log("读取图片", kind + "：验证图片格式");
            try { prepared[kind] = await prepareAsset(assets[kind]); }
            catch (error) { throw new Error(kind + "：" + error.message); }
          }
          else if (FILES.PROOF_KINDS.includes(kind)) await log("证明材料", kind + "为空，跳过");
        }
        await log("配对下载", "共 " + Object.keys(prepared).length + " 张图片已读取并验证格式");
        const downloaded = await checkedSend({ type: "PIC_EXPERT_DOWNLOAD_PAIR", taskId, ...id, assets: prepared });
        result = { ...id, result: "成功", reason: "", ...FILES.manifestFiles(downloaded.files) };
      }
    } catch (error) {
      result = { ...empty, result: "失败", reason: error.message, ...FILES.manifestFiles(error.files) };
    }
    // Record this outcome before returning, so navigation failures retain the completed pair.
    await checkedSend({ type: "PIC_EXPERT_MANIFEST_ROW", taskId, row: result });
    try { await returnToList(detail, checkpoint); }
    catch (error) { error.rowRecorded = true; throw error; }
    return result;
  };
  const run = async taskId => {
    activeTaskId = taskId;
    let scanned = 0, completed = 0, skipped = 0, failed = 0, visited = 0;
    const seen = new Set();
    try {
      await log("任务启动", "开始扫描当前查询全部分页");
      await goToPage(1);
      const initial = snapshot();
      const total = initial.total;
      while (true) {
        const table = currentTable();
        if (!table) throw new Error("无法唯一识别订单表格。");
        const pageSignature = signature();
        const ids = table.rows.map(row => identity(row, table.columns));
        for (const id of ids) {
          if (stopped) throw new Error("用户停止任务。");
          if (signature() !== pageSignature || JSON.stringify(snapshot().filters) !== JSON.stringify(initial.filters)) throw new Error("任务运行期间查询结果或条件发生变化。");
          visited += 1;
          if (visited > total) throw new Error("扫描条数超过原查询总条数。");
          if (seen.has(key(id))) throw new Error("查询结果出现重复订单身份，已停止。");
          seen.add(key(id));
          const fresh = currentTable();
          const matches = fresh?.rows.filter(row => key(identity(row, fresh.columns)) === key(id)) || [];
          if (matches.length !== 1) throw new Error("无法唯一定位原订单行。");
          scanned += 1;
          await checkedSend({ type: "PIC_EXPERT_ROW_BEGIN", taskId, identity: id });
          let result;
          try { result = await processRow(matches[0], fresh, taskId); }
          catch (error) {
            if (!error.rowRecorded) await checkedSend({ type: "PIC_EXPERT_MANIFEST_ROW", taskId,
              row: { ...id, result: "失败", reason: error.message, ...FILES.manifestFiles() } });
            throw error;
          }
          if (result.result === "成功") completed += 1;
          else if (result.result === "跳过") skipped += 1;
          else failed += 1;
          // Skipped rows never opened details, and therefore need their manifest entry here.
          await checkedSend({ type: "PIC_EXPERT_MANIFEST_ROW", taskId, row: result });
          await checkedSend({ type: "PIC_EXPERT_PROGRESS", taskId, page: pager().page, scanned, completed, skipped, failed });
        }
        if (!await pageStep(1)) break;
      }
      if (visited !== total) throw new Error("扫描条数与查询总条数不一致，已停止。");
      await checkedSend({ type: "PIC_EXPERT_TASK_END", taskId, status: "completed" });
    } catch (error) {
      await log("任务中断", error.message, "error");
      await chrome.runtime.sendMessage({ type: "PIC_EXPERT_TASK_END", taskId, status: "failed", error: error.message }).catch(() => {});
    } finally { running = false; activeTaskId = null; }
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PIC_EXPERT_PROBE") {
      sendResponse({ ok: true, ready: Boolean(currentTable()) }); return false;
    }
    if (message?.type === "PIC_EXPERT_STOP") { stopped = true; sendResponse({ ok: true }); return false; }
    if (message?.type !== "PIC_EXPERT_START") return false;
    if (running) { sendResponse({ ok: false, error: "当前页面已有任务。" }); return false; }
    running = true; stopped = false;
    // Acknowledge immediately: closing the popup must not cancel an hours-long run.
    sendResponse({ ok: true });
    void run(message.taskId);
    return false;
  });
  // Exposed only by Node's test harness; not installed on the page's MAIN world.
  if (typeof module !== "undefined" && module.exports) module.exports = { currentTable, findAssets, detailScope, run, processRow, restoreList, goToPage };
})();
