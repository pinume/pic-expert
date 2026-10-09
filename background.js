importScripts("core.js", "store.js", "order-downloads.js");
const { buildManifestCsv, makeTaskId, cleanText } = globalThis.PIC_EXPERT_CORE;
const db = globalThis.PIC_EXPERT_STORE;
const endings = new Map(), manifestExports = new Map();
let stateQueue = Promise.resolve();
const getTask = () => db.getTask();
const isTaskPage = sender => sender.url?.split("?")[0] === chrome.runtime.getURL("popup.html");
const mutate = operation => {
  const promise = stateQueue.then(operation);
  stateQueue = promise.catch(() => {});
  return promise;
};
const assertTask = (task, id, sender, running = true) => {
  if (!task || task.id !== id || (running && (task.forcePause || !["running", "pausing"].includes(task.status)))) throw new Error("任务身份已失效。");
  if (sender.tab && !isTaskPage(sender) && (sender.tab.id !== task.tabId || sender.frameId !== task.frameId)) throw new Error("消息来自其他页面或 frame。");
};
const appendLog = (changes, stage, message, level = "info") => {
  changes.logs.push({ time: new Date().toISOString(), level: level === "error" ? "error" : "info",
    stage: String(stage || "任务").slice(0, 80), message: String(message || "").slice(0, 500) });
};
const update = (id, sender, operation, running = true) => mutate(async () => {
  const task = await getTask();
  assertTask(task, id, sender, running);
  const changes = { rows: [], pairs: [], logs: [], pages: [] };
  await operation(task, changes);
  await db.save(task, changes);
  return task;
});
const summary = async task => task ? { ...task, logs: await db.logs(task.id, 500) } : null;
const taskDirectory = task => task.folderName || task.id;
const waitForDownload = async (id, timeoutMs = 120000, taskId = null) => {
  if (!Number.isInteger(id)) throw new Error("Chrome 未返回有效下载编号。");
  const deadline = Date.now() + timeoutMs;
  // Install before search; a completion event cannot fall between the two.
  let wake;
  const changed = delta => { if (delta.id === id) wake?.(); };
  chrome.downloads.onChanged?.addListener(changed);
  try {
    while (Date.now() < deadline) {
      if (taskId) assertTask(await getTask(), taskId, {}, true);
      const [item] = await chrome.downloads.search({ id });
      if (!item) throw new Error("下载记录丢失。");
      if (item.state === "complete") return item;
      if (item.state === "interrupted") throw new Error(item.error || "download_interrupted");
      await new Promise(resolve => {
        const timer = setTimeout(resolve, Math.min(1000, deadline - Date.now()));
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = null;
    }
    throw new Error("download_timeout");
  } finally { chrome.downloads.onChanged?.removeListener(changed); }
};
const orders = globalThis.PIC_EXPERT_ORDER_DOWNLOADS({
  db, downloads: chrome.downloads, getTask, update, assertTask, appendLog, waitForDownload
});
const startTask = message => mutate(async () => {
  const existing = await getTask();
  if (["running", "pausing", "stopping", "finalizing"].includes(existing?.status)) throw new Error("已有任务运行；页面中断时请先暂停或停止。");
  if (!Number.isInteger(message.tabId) || !Number.isInteger(message.frameId)) throw new Error("目标页面不完整。");
  const range = message.tradeDateRange;
  if (!Array.isArray(range) || range.length !== 2 || range.some(value => typeof value !== "string" || !/^\d{8}$/.test(value))) throw new Error("无法识别本次查询的交易日期区间。");
  const id = makeTaskId();
  const task = { id, folderName: range[0] + "-" + range[1] + "_" + id, status: "running", tabId: message.tabId, frameId: message.frameId,
    startedAt: new Date().toISOString(), page: 1,
    scanned: 0, completed: 0, skipped: 0, failed: 0, currentRows: [], phase: "listing", listed: 0 };
  const changes = { logs: [] };
  appendLog(changes, "创建任务", "任务 " + task.id + "，frame " + task.frameId);
  await db.save(task, changes);
  return task;
});
const exportManifest = (taskId, sender, retry = false) => {
  if (manifestExports.has(taskId)) return manifestExports.get(taskId);
  const promise = (async () => {
  let task = await getTask(); assertTask(task, taskId, sender, false);
  if (task.manifestDownloadId !== undefined && !retry) {
    try { await waitForDownload(task.manifestDownloadId); return await update(taskId, sender, t => { t.manifestError = ""; }, false); }
    catch (error) { return update(taskId, sender, (t, c) => { t.manifestError = "清单下载失败：" + error.message; appendLog(c, "下载清单", t.manifestError, "error"); }, false); }
  }
  const filename = "pic-expert/" + taskDirectory(task) + "/下载清单.csv";
  try {
    const downloadId = await chrome.downloads.download({ url: "data:text/csv;charset=utf-8," + encodeURIComponent(buildManifestCsv(await db.rows(taskId))), filename, saveAs: false, conflictAction: "overwrite" });
    await update(taskId, sender, t => { t.manifestDownloadId = downloadId; }, false);
    await waitForDownload(downloadId);
    return update(taskId, sender, (t, c) => { t.manifestError = ""; appendLog(c, "下载清单", "清单已下载：" + filename); }, false);
  } catch (error) {
    return update(taskId, sender, (t, c) => { t.manifestError = "清单下载失败：" + error.message; appendLog(c, "下载清单", t.manifestError, "error"); }, false);
  }
  })().finally(() => manifestExports.delete(taskId));
  manifestExports.set(taskId, promise);
  return promise;
};
const finalizeTask = (message, sender) => {
  const { taskId } = message;
  if (endings.has(taskId)) return endings.get(taskId);
  const promise = (async () => {
    let task = await update(taskId, sender, (t, c) => {
      if (t.finishedAt) return;
      t.status = "finalizing"; t.finalStatus = message.status === "completed" ? "completed" : "failed";
      t.error = message.error || t.error || "";
      appendLog(c, "结束任务", t.finalStatus + (t.error ? "：" + t.error : ""), t.finalStatus === "failed" ? "error" : "info");
    }, false);
    if (!task.finishedAt) {
      await orders.reconcile(taskId, sender);
      task = await update(taskId, sender, (t, c) => {
        t.finishedAt = new Date().toISOString();
        const durationMs = Math.max(0, Date.now() - (Date.parse(t.startedAt) || Date.now()));
        appendLog(c, "处理汇总", "查询 " + (t.checkpoint?.total ?? "未知") + "，检查 " + t.scanned + "，成功 " + t.completed + "，跳过 " + t.skipped + "，失败 " + t.failed + "，历时 " + Math.round(durationMs / 1000) + " 秒");
      }, false);
    }
    await exportManifest(taskId, sender);
    return update(taskId, sender, t => { if (t.finalStatus) { t.status = t.finalStatus; delete t.finalStatus; } }, false);
  })().finally(() => endings.delete(taskId));
  endings.set(taskId, promise);
  return promise;
};
const pauseTask = async sender => {
  const task = await getTask();
  if (!task || !["running", "pausing"].includes(task.status)) return task;
  const force = task.status === "pausing";
  await update(task.id, sender, (t, c) => { t.status = "pausing"; t.forcePause = force; appendLog(c, "暂停任务", force ? "中断当前等待并保存断点" : "等待在途订单结束"); }, false);
  const response = await chrome.tabs.sendMessage(task.tabId, { type: "PIC_EXPERT_PAUSE", force }, { frameId: task.frameId }).catch(() => null);
  if (!response?.running) {
    await update(task.id, sender, t => { t.forcePause = true; }, false);
    await orders.reconcile(task.id, sender);
    return update(task.id, sender, t => { if (t.status === "pausing") t.status = "paused"; delete t.forcePause; }, false);
  }
  if (force) await orders.reconcile(task.id, sender);
  return getTask();
};
const resumeTask = (message, sender) => mutate(async () => {
  if (sender.tab && !isTaskPage(sender)) throw new Error("请从独立任务页面继续任务。");
  const task = await getTask();
  if (!task || !(["paused", "failed"].includes(task.status) || task.status === "completed" && task.failed > 0) || !task.checkpoint) throw new Error("没有可继续的断点，请先完成原查询。");
  if (!Number.isInteger(message.tabId) || !Number.isInteger(message.frameId)) throw new Error("目标页面不完整。");
  task.tabId = message.tabId; task.frameId = message.frameId; task.status = "running"; task.error = "";
  task.generation = (task.generation || 0) + 1;
  delete task.forcePause; task.manifestError = "";
  delete task.finishedAt; delete task.finalStatus; delete task.manifestDownloadId;
  const changes = { logs: [] }; appendLog(changes, "继续任务", "沿用任务目录，重新读取并核对完整订单列表");
  await db.save(task, changes); return task;
});
const autoPauseTask = async (taskId, sender, error, generation) => {
  let pausing = false;
  const task = await update(taskId, sender, (t, c) => {
    const canPause = ["running", "pausing"].includes(t.status) || t.status === "stopping" && !t.finalStatus;
    if (!canPause || t.forcePause || (generation !== undefined && generation !== (t.generation || 0))) return;
    pausing = true;
    t.status = "pausing"; t.forcePause = true; t.error = error;
    appendLog(c, "自动暂停", error, "error");
  }, false);
  if (!pausing) return task;
  await chrome.tabs.sendMessage(task.tabId, { type: "PIC_EXPERT_PAUSE", force: true }, { frameId: task.frameId }).catch(() => {});
  await orders.reconcile(taskId, sender);
  return update(taskId, sender, t => {
    if (t.status === "pausing" && (t.generation || 0) === (task.generation || 0)) { t.status = "paused"; delete t.forcePause; }
  }, false);
};
const sourceInterrupted = async (tabId, reason) => {
  const task = await getTask();
  if (task?.tabId !== tabId || !["running", "pausing"].includes(task.status)) return;
  await autoPauseTask(task.id, {}, reason, task.generation || 0);
};
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") sourceInterrupted(tabId, "来源网页已刷新或跳转，任务已中断。请等待暂停完成，恢复原日期和状态查询后继续。").catch(error => console.error("中断暂停失败：", error));
});
chrome.tabs.onRemoved.addListener(tabId => {
  sourceInterrupted(tabId, "来源网站标签页已关闭，任务已中断。请重新打开网站并登录，恢复原查询，选择网站标签页后继续。").catch(error => console.error("中断暂停失败：", error));
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "PIC_EXPERT_TASK_BEGIN": return { ok: true, task: await startTask(message) };
      case "PIC_EXPERT_TASK_RESUME": return { ok: true, task: await resumeTask(message, sender) };
      case "PIC_EXPERT_TASK_PAUSE": return { ok: true, task: await summary(await pauseTask(sender)) };
      case "PIC_EXPERT_TASK_PAUSED": {
        const task = await getTask(); assertTask(task, message.taskId, sender, false);
        if (!["pausing", "paused"].includes(task.status)) return { ok: true };
        await orders.reconcile(task.id, sender);
        return { ok: true, task: await update(task.id, sender, t => { if (t.status === "pausing") t.status = "paused"; delete t.forcePause; if (message.error) t.error = message.error; }, false) };
      }
      case "PIC_EXPERT_TASK_AUTO_PAUSE":
        return { ok: true, task: await autoPauseTask(message.taskId, sender, message.error) };
      case "PIC_EXPERT_LIST_BEGIN":
        return { ok: true, task: await update(message.taskId, sender, t => {
          if (t.currentRows.length) throw new Error("仍有订单未完成，不能读取列表。");
          t.phase = "listing"; t.listed = 0;
          t.checkpoint ||= message.checkpoint;
          t.checkpoint.size ??= message.checkpoint.size;
        }) };
      case "PIC_EXPERT_LIST_PAGE":
        return { ok: true, task: await update(message.taskId, sender, (t, c) => {
          if (t.phase !== "listing" || message.page !== Math.floor(t.listed / t.checkpoint.size) + 1) throw new Error("列表页顺序无效。");
          if (!Number.isInteger(message.total) || message.total < 0 || !Array.isArray(message.rows) ||
            message.rows.length !== Math.max(0, Math.min(t.checkpoint.size, message.total - t.listed)) ||
            (t.checkpoint.total !== null && t.checkpoint.total !== message.total)) throw new Error("订单列表条数与原查询不一致。");
          t.total = message.total;
          t.page = message.page;
          t.checkpoint.total ??= message.total;
          if (message.page === 1) t.checkpoint.signature ??= message.rows.map(row => cleanText(row.merOrderId) + "::" + cleanText(row.transRef)).join("\n");
          t.listed += message.rows.length;
          c.pages.push({ page: message.page, rows: message.rows });
          appendLog(c, "读取列表", t.listed === t.total && message.page === 1 ? "已读取完整订单列表 " + t.listed + "/" + t.total : "第 " + message.page + " 页，已读取 " + t.listed + "/" + t.total);
        }) };
      case "PIC_EXPERT_LIST_COMPLETE":
        return { ok: true, task: await update(message.taskId, sender, (t, c) => {
          if (t.phase !== "listing" || t.listed !== t.total) throw new Error("订单列表未读取完整。");
          t.phase = "processing";
          appendLog(c, "列表完成", "已读取全部 " + t.total + " 笔订单，开始处理资料");
        }) };
      case "PIC_EXPERT_LIST_GET": {
        assertTask(await getTask(), message.taskId, sender);
        return { ok: true, page: await db.getPage(message.taskId, message.page) };
      }
      case "PIC_EXPERT_CHECKPOINT":
        return { ok: true, task: await update(message.taskId, sender, t => {
          if (t.currentRows?.length) throw new Error("当前页仍有订单正在处理，不能更新断点。");
          t.checkpoint = { ...message.checkpoint };
          t.page = message.checkpoint.page;
          t.total = message.checkpoint.total;
        }) };
      case "PIC_EXPERT_ROW_STATUS": return { ok: true, ...await orders.status(message, sender) };
      case "PIC_EXPERT_LOG":
        await update(message.taskId, sender, (_t, c) => appendLog(c, message.stage, message.message, message.level), false);
        return { ok: true };
      case "PIC_EXPERT_DOWNLOAD_PAIR": return { ok: true, files: await orders.download(message, sender) };
      case "PIC_EXPERT_ROW_BEGIN":
        return { ok: true, task: await update(message.taskId, sender, (t, c) => {
          if (!message.identity?.orderNo || !message.identity.referenceNo) throw new Error("订单身份不完整。");
          t.currentRows ||= [];
          if (t.currentRows.some(row => row.orderNo === message.identity.orderNo && row.referenceNo === message.identity.referenceNo)) return;
          if (t.currentRows.length >= 3) throw new Error("同时处理的订单不能超过三笔。");
          t.currentRows.push({ ...message.identity, page: t.page, ...(message.note ? { note: message.note } : {}) });
          appendLog(c, "检查订单", "订单 " + message.identity.orderNo + "，参考号 " + message.identity.referenceNo);
        }) };
      case "PIC_EXPERT_MANIFEST_ROW":
        return { ok: true, task: await orders.recordResult(message, sender) };
      case "PIC_EXPERT_TASK_END": return { ok: true, task: await summary(await finalizeTask(message, sender)) };
      case "PIC_EXPERT_TASK_HALT":
        return { ok: true, task: await update(message.taskId, sender, t => { t.status = "stopping"; t.error = message.error || "任务中断。"; }) };
      case "PIC_EXPERT_TASK_STOP": {
        const task = await getTask();
        if (!task || !["running", "pausing", "paused", "stopping", "finalizing"].includes(task.status)) return { ok: true, task: await summary(task) };
        await update(task.id, sender, t => { t.status = "stopping"; t.finalStatus = "failed"; t.error = "用户停止任务。"; }, false);
        const response = await chrome.tabs.sendMessage(task.tabId, { type: "PIC_EXPERT_STOP" }, { frameId: task.frameId }).catch(() => null);
        if (response?.running) return { ok: true, task: await summary(await getTask()) };
        return { ok: true, task: await summary(await finalizeTask({ taskId: task.id, status: "failed", error: "用户停止任务。" }, sender)) };
      }
      case "PIC_EXPERT_MANIFEST_RETRY": {
        const task = await getTask();
        if (!task || !["completed", "failed"].includes(task.status)) throw new Error("请等待任务结束。");
        if (task.manifestDownloadId !== undefined) {
          const [item] = await chrome.downloads.search({ id: task.manifestDownloadId });
          if (["complete", "in_progress"].includes(item?.state)) return { ok: true, task: await summary(await exportManifest(task.id, sender)) };
        }
        return { ok: true, task: await summary(await exportManifest(task.id, sender, true)) };
      }
      case "PIC_EXPERT_LOG_EXPORT": {
        const task = await getTask(); if (!task) throw new Error("没有运行日志。");
        let after = 0, part = 1, page;
        do {
          page = await db.logPage(task.id, after);
          if (!page.logs.length) break;
          const text = page.logs.map(e => e.time + " [" + e.level + "] " + e.stage + "：" + e.message).join("\n");
          const id = await chrome.downloads.download({url:"data:text/plain;charset=utf-8," + encodeURIComponent(text),filename:"pic-expert/" + taskDirectory(task) + "/运行日志-" + String(part++).padStart(3,"0") + ".txt",saveAs:false,conflictAction:"overwrite"});
          await waitForDownload(id);
          after = page.next;
        } while (page.more);
        return { ok: true };
      }
      case "PIC_EXPERT_TASK_STATE": return { ok: true, task: await summary(await getTask()) };
      default: return { ok: false, error: "unknown_message" };
    }
  })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message, files: error.files }));
  return true;
});
