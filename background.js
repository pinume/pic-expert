importScripts("core.js", "store.js", "order-downloads.js");
const { buildManifestCsv, makeTaskId } = globalThis.PIC_EXPERT_CORE;
const db = globalThis.PIC_EXPERT_STORE;
const endings = new Map(), manifestExports = new Map();
let stateQueue = Promise.resolve();
const getTask = () => db.getTask();
const mutate = operation => {
  const promise = stateQueue.then(operation);
  stateQueue = promise.catch(() => {});
  return promise;
};
const assertTask = (task, id, sender, running = true) => {
  if (!task || task.id !== id || (running && (task.forcePause || !["running", "pausing"].includes(task.status)))) throw new Error("任务身份已失效。");
  if (sender.tab && (sender.tab.id !== task.tabId || sender.frameId !== task.frameId)) throw new Error("消息来自其他页面或 frame。");
};
const appendLog = (changes, stage, message, level = "info") => {
  changes.logs.push({ time: new Date().toISOString(), level: level === "error" ? "error" : "info",
    stage: String(stage || "任务").slice(0, 80), message: String(message || "").slice(0, 500) });
};
const update = (id, sender, operation, running = true) => mutate(async () => {
  const task = await getTask();
  assertTask(task, id, sender, running);
  const changes = { rows: [], pairs: [], logs: [] };
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
    scanned: 0, completed: 0, skipped: 0, failed: 0, currentRows: [] };
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
  if (sender.tab) throw new Error("请从扩展弹窗继续任务。");
  const task = await getTask();
  if (!task || !(["paused", "failed"].includes(task.status) || task.status === "completed" && task.failed > 0) || !task.checkpoint) throw new Error("没有可继续的断点，请先完成原查询。");
  if (!Number.isInteger(message.tabId) || !Number.isInteger(message.frameId)) throw new Error("目标页面不完整。");
  task.tabId = message.tabId; task.frameId = message.frameId; task.status = "running"; task.error = "";
  task.generation = (task.generation || 0) + 1;
  delete task.forcePause; task.manifestError = "";
  delete task.finishedAt; delete task.finalStatus; delete task.manifestDownloadId;
  const changes = { logs: [] }; appendLog(changes, "继续任务", "沿用任务目录，核对断点后重新扫描全部分页");
  await db.save(task, changes); return task;
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
      case "PIC_EXPERT_CHECKPOINT":
        return { ok: true, task: await update(message.taskId, sender, t => {
          const previous = t.checkpoint;
          if (t.currentRows?.length) throw new Error("当前页仍有订单正在处理，不能更新断点。");
          t.checkpoint = { ...message.checkpoint, visitedBefore: previous?.page === message.checkpoint.page ? previous.visitedBefore : message.checkpoint.visitedBefore };
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
          t.currentRows.push({ ...message.identity, page: t.page });
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
