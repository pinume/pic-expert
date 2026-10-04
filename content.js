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
      setInput(jump[0], String(target));
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
        value: input.value, date: input.classList.contains("deal-date") || input.classList.contains("clear-date-merge-detail"),
        readonly: input.readOnly } : null;
    }).filter(Boolean)
  });
  const setInput = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const openDateCalendar = async (input, label) => {
    // The route may render the input before laydate binds its focus/click handler.
    let nextAttempt = 0, attempts = 0;
    await log("日期控件", "等待初始化并打开：" + label);
    const findCalendar = () => {
      const calendars = all(".layui-laydate");
      if (calendars.length > 1) throw new Error("日期控件不唯一，已停止。");
      return calendars[0] || null;
    };
    const calendar = await wait(() => {
      const existing = findCalendar();
      if (existing) return existing;
      if (Date.now() >= nextAttempt) {
        attempts += 1;
        nextAttempt = Date.now() + 1000;
        input.blur?.();
        input.focus?.();
        // Focus may already open the calendar. A following click can toggle it shut.
        let opened = findCalendar();
        if (opened) return opened;
        input.dispatchEvent(new Event("focus"));
        opened = findCalendar();
        if (opened) return opened;
        input.click();
        return findCalendar();
      }
      return false;
    }, "原日期控件未打开（已重试聚焦和点击，请查看运行日志）。").catch(async error => {
      await log("日期控件", error.message + " 尝试 " + attempts + " 次；日历节点 " +
        document.querySelectorAll(".layui-laydate").length + "，可见 " + all(".layui-laydate").length +
        "；输入连接 " + input.isConnected + "，禁用 " + input.disabled + "，只读 " + input.readOnly, "error");
      throw error;
    });
    await log("日期控件", "已打开，尝试 " + attempts + " 次");
    return calendar;
  };
  const selectCalendarDate = async date => {
    const [year, month] = date.split("-").map(Number), target = year * 12 + month;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const calendars = all(".layui-laydate");
      if (calendars.length !== 1) throw new Error("日期控件消失或不唯一。");
      const calendar = calendars[0];
      const cells = all("td[lay-ymd]", calendar).filter(e => e.getAttribute("lay-ymd") === date &&
        !["laydate-disabled", "laydate-day-prev", "laydate-day-next"].some(cls => e.classList.contains(cls)));
      if (cells.length === 1) { cells[0].click(); await sleep(200); return; }
      if (cells.length > 1) throw new Error("目标日期不唯一。");
      const panels = all(".layui-laydate-main", calendar).map(panel => {
        const match = clean(panel.querySelector(".laydate-set-ym")?.textContent).match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
        return match ? { panel, month: Number(match[1]) * 12 + Number(match[2]) } : null;
      }).filter(Boolean);
      if (!panels.length || attempt === 24) throw new Error("原日期范围无法恢复。");
      const before = panels.map(p => p.month).join(",");
      const previous = target < panels[0].month;
      if (!previous && target <= panels.at(-1).month) throw new Error("原日期不可选，已停止。");
      const panel = previous ? panels[0].panel : panels.at(-1).panel;
      const arrows = all(previous ? ".laydate-prev-m" : ".laydate-next-m", panel).filter(e => !e.classList.contains("laydate-disabled"));
      if (arrows.length !== 1) throw new Error("日期月份切换入口不唯一。");
      arrows[0].click();
      await wait(() => all(".layui-laydate-main", calendar).map(p => {
        const match = clean(p.querySelector(".laydate-set-ym")?.textContent).match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
        return match ? Number(match[1]) * 12 + Number(match[2]) : "";
      }).join(",") !== before, "日期月份没有更新。");
    }
  };
  const restoreList = async checkpoint => {
    await log("返回列表", "恢复原查询路由，目标页 " + checkpoint.page);
    const destination = new URL(checkpoint.url);
    if (destination.origin !== location.origin || destination.pathname !== location.pathname ||
      destination.hash.split("?")[0] !== "#/auditOfTrade2026") throw new Error("无法安全恢复原查询页面。");
    // Portal return buttons route to other modules. Restore only the recorded frame route.
    location.hash = destination.hash;
    await wait(() => all("input.deal-date").length === 1, "未能返回原采集列表。");
    const items = all(".search-item").filter(item => item.querySelector("input"));
    if (items.length !== checkpoint.filters.length) throw new Error("查询条件结构发生变化。");
    for (let i = 0; i < items.length; i += 1) {
      const input = items[i].querySelector("input"), saved = checkpoint.filters[i];
      const label = clean(items[i].querySelector("label")?.textContent || items[i].firstChild?.textContent);
      if (label !== saved.label) throw new Error("查询字段顺序发生变化。");
      if (saved.date && saved.value) {
        await openDateCalendar(input, label);
        for (const date of CORE.dateRange(saved.value)) {
          await selectCalendarDate(date);
        }
        const calendars = all(".layui-laydate");
        if (calendars.length !== 1) throw new Error("日期控件消失或不唯一。");
        const calendar = calendars[0];
        const confirm = all(".laydate-btns-confirm", calendar);
        if (confirm.length !== 1 || confirm[0].classList.contains("laydate-disabled")) throw new Error("日期确认控件不可用或不唯一。");
        confirm[0].click();
        await wait(() => input.value === saved.value, "日期控件确认后未恢复原日期范围。");
        await log("日期控件", "已选择并确认原日期范围");
      } else if (saved.readonly && input.value !== saved.value) {
        input.click();
        for (const part of saved.value.split(/\s*\/\s*/)) {
          const choice = await wait(() => {
            const matches = all(".el-cascader-node__label").filter(e => clean(e.textContent) === part);
            return matches.length === 1 && matches[0];
          }, "无法恢复原订单状态。");
          choice.click();
        }
      } else setInput(input, saved.value);
      if (input.value !== saved.value) throw new Error("恢复后的查询条件与原查询不同。");
    }
    const query = all("button").filter(e => clean(e.textContent) === "查询");
    if (query.length !== 1) throw new Error("查询入口不唯一。");
    await log("恢复查询", "条件已核对，执行原查询");
    query[0].click();
    await wait(() => !loading() && currentTable() && pager().total === checkpoint.total, "原查询结果没有恢复。");
    await goToPage(checkpoint.page);
    if (pager().page !== checkpoint.page || signature() !== checkpoint.signature) throw new Error("恢复后的订单集合与原查询不同，已停止。");
    await log("返回列表", "原页码和订单集合已确认");
  };
  const findAssets = scope => {
    const result = {};
    for (const kind of ["SN码", "发票"]) {
      const containers = all(".image-container1", scope).filter(e => CORE.assetKind(e.querySelector("p")?.textContent) === kind);
      const urls = containers.flatMap(e => all("img.el-image__inner", e).filter(i => i.complete && i.naturalWidth > 0).map(i => i.currentSrc || i.src));
      // Generic dialogs use local field containers, never climb into sibling image groups.
      if (!containers.length) {
        for (const field of all(".el-form-item,.ant-form-item", scope)) {
          if (CORE.assetKind(field.querySelector("label")?.textContent) !== kind) continue;
          urls.push(...all("img", field).filter(i => i.complete && i.naturalWidth > 0).map(i => i.currentSrc || i.src));
        }
      }
      result[kind] = CORE.chooseUnique(urls);
    }
    return result;
  };
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
    const empty = { ...id, snFile: "", invoiceFile: "" };
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
      let assets;
      do {
        assets = findAssets(detail.element);
        if (assets["SN码"] && assets["发票"]) break;
        if (stopped) throw new Error("用户停止任务。");
        await sleep(250);
      } while (Date.now() < deadline);
      if (!assets["SN码"] || !assets["发票"]) {
        result = { ...empty, result: "跳过", reason: "SN码或发票图片缺失、未加载或不唯一" };
      } else {
        const prepared = { "SN码": await prepareAsset(assets["SN码"]), "发票": await prepareAsset(assets["发票"]) };
        await log("配对下载", "两张图片已读取并验证格式");
        const downloaded = await checkedSend({ type: "PIC_EXPERT_DOWNLOAD_PAIR", taskId, ...id, assets: prepared });
        result = { ...id, result: "成功", reason: "", snFile: downloaded.files["SN码"].filename, invoiceFile: downloaded.files["发票"].filename };
      }
    } catch (error) {
      result = { ...empty, result: "失败", reason: error.message,
        snFile: error.files?.["SN码"]?.filename || "", invoiceFile: error.files?.["发票"]?.filename || "" };
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
              row: { ...id, result: "失败", reason: error.message, snFile: "", invoiceFile: "" } });
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
  if (typeof module !== "undefined" && module.exports) module.exports = { currentTable, findAssets, detailScope, run, processRow, restoreList, goToPage, openDateCalendar, selectCalendarDate };
})();
