importScripts("core.js", "store.js");
const { sanitizePathPart, buildManifestCsv, makeTaskId, REQUIRED_KINDS, ASSET_KINDS, manifestFiles } = globalThis.PIC_EXPERT_CORE;
const db = globalThis.PIC_EXPERT_STORE;
const pairs = new Map(), endings = new Map(), recoveries = new Map(), manifestExports = new Map();
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
  task.updatedAt = new Date().toISOString();
  await db.save(task, changes);
  return task;
});
const summary = async task => task ? { ...task, logs: await db.logs(task.id, 500) } : null;
const upsertRow = async (task, changes, row) => {
  const previous = await db.getRow(task.id, row);
  const counter = result => ({ "成功": "completed", "跳过": "skipped", "失败": "failed" }[result]);
  if (previous && counter(previous.result)) task[counter(previous.result)]--;
  if (counter(row.result)) task[counter(row.result)]++;
  if (!previous) task.scanned++;
  changes.rows.push(row);
  row.page ??= task.page;
  if (task.currentRow?.orderNo === row.orderNo && task.currentRow?.referenceNo === row.referenceNo) delete task.currentRow;
};
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
const startTask = message => mutate(async () => {
  const existing = await getTask();
  if (["running", "pausing", "stopping", "finalizing"].includes(existing?.status)) throw new Error("已有任务运行；页面中断时请先暂停或停止。");
  if (!Number.isInteger(message.tabId) || !Number.isInteger(message.frameId)) throw new Error("目标页面不完整。");
  const task = { id: makeTaskId(), status: "running", tabId: message.tabId, frameId: message.frameId,
    sourceUrl: message.sourceUrl, startedAt: new Date().toISOString(), page: 1,
    scanned: 0, completed: 0, skipped: 0, failed: 0 };
  const changes = { logs: [] };
  appendLog(changes, "创建任务", "任务 " + task.id + "，frame " + task.frameId);
  await db.save(task, changes);
  return task;
});
const validateAssets = assets => {
  const formats = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp" };
  if (!assets || REQUIRED_KINDS.some(kind => !assets[kind])) throw new Error("必须提供 SN码和发票两张图片。");
  if (Object.keys(assets).some(kind => !ASSET_KINDS.includes(kind))) throw new Error("图片类型不受支持。");
  const kinds = ASSET_KINDS.filter(kind => Object.hasOwn(assets, kind));
  for (const kind of kinds) {
    const asset = assets[kind];
    if (!asset || !formats[asset.extension] || !asset.url?.startsWith("data:" + formats[asset.extension] + ";base64,")) throw new Error(kind + "图片格式未验证。");
  }
  return kinds;
};
const rollback = async (taskId, referenceNo, sender, reason) => {
  const pair = await db.getPair(taskId, referenceNo);
  const leftovers = {};
  for (const [kind, file] of Object.entries(pair.files)) {
    try {
      await chrome.downloads.cancel(file.downloadId).catch(() => {});
      await chrome.downloads.removeFile(file.downloadId);
    } catch { leftovers[kind] = file; }
  }
  const error = reason + (Object.keys(leftovers).length ? "；部分文件无法清理，请查看运行日志。" : "");
  await update(taskId, sender, (_task, changes) => {
    changes.pairs.push({ ...pair, status: "failed", files: leftovers, error });
    appendLog(changes, "下载回滚", "参考号 " + referenceNo + "：" + error, "error");
    for (const [kind, file] of Object.entries(leftovers)) appendLog(changes, "残留文件", kind + "：" + file.filename, "error");
  }, false);
  const failure = new Error(error); failure.files = leftovers;
  return failure;
};
const downloadPair = async (message, sender) => {
  const { taskId, orderNo, referenceNo, assets } = message;
  const kinds = validateAssets(assets);
  if (!orderNo || !/^[A-Za-z0-9_-]+$/.test(referenceNo || "")) throw new Error("订单身份不完整。");
  const key = taskId + "::" + referenceNo;
  await update(taskId, sender, async (_task, changes) => {
    const previous = await db.getPair(taskId, referenceNo);
    if (previous && previous.orderNo !== orderNo) throw new Error("同一参考号对应多个订单，已停止。");
    if (!previous) changes.pairs.push({ referenceNo, orderNo, status: "pending", generation: _task.generation || 0, files: {} });
  });
  if (pairs.has(key)) return pairs.get(key);
  const promise = (async () => {
    assertTask(await getTask(), taskId, sender);
    const previous = await db.getPair(taskId, referenceNo);
    if (previous.status === "complete") return previous.files;
    if (previous.status === "failed") {
      const task = await getTask();
      if ((previous.generation || 0) === (task.generation || 0) || Object.keys(previous.files).length) {
        const error = new Error(previous.error); error.files = previous.files; throw error;
      }
      await update(taskId, sender, (_task, changes) => { changes.pairs.push({ ...previous, status: "pending", generation: _task.generation, error: "" }); });
    }
    try {
      for (const kind of kinds) {
        assertTask(await getTask(), taskId, sender);
        const pair = await db.getPair(taskId, referenceNo);
        const existing = pair.files[kind];
        const filename = existing?.filename || "pic-expert/" + taskId + "/" + sanitizePathPart(referenceNo) + "/" + kind + assets[kind].extension;
        const downloadId = existing?.downloadId ?? await chrome.downloads.download({ url: assets[kind].url, filename, saveAs: false, conflictAction: "overwrite" });
        await update(taskId, sender, (_task, changes) => {
          pair.files[kind] = { downloadId, filename };
          changes.pairs.push(pair);
          appendLog(changes, "下载图片", kind + "，编号 " + downloadId + "，路径 " + filename);
        }, false);
        await waitForDownload(downloadId, 120000, taskId);
      }
      await update(taskId, sender, async (_task, changes) => {
        const pair = await db.getPair(taskId, referenceNo); pair.status = "complete"; changes.pairs.push(pair);
        appendLog(changes, "配对完成", "参考号 " + referenceNo + "，共 " + kinds.length + " 张图片下载完成");
      });
      return (await db.getPair(taskId, referenceNo)).files;
    } catch (error) { throw await rollback(taskId, referenceNo, sender, error.message); }
  })().finally(() => pairs.delete(key));
  pairs.set(key, promise);
  return promise;
};
const reconcile = (taskId, sender) => {
  if (recoveries.has(taskId)) return recoveries.get(taskId);
  const promise = (async () => {
  await Promise.allSettled([...pairs.entries()].filter(([key]) => key.startsWith(taskId + "::")).map(([, promise]) => promise));
  for (const pair of await db.pairs(taskId)) {
    if (pair.status === "pending") await rollback(taskId, pair.referenceNo, sender, "任务中断。");
  }
  const existingRows = new Map((await db.rows(taskId)).map(row => [JSON.stringify([row.orderNo, row.referenceNo]), row]));
  for (const pair of await db.pairs(taskId)) {
    const previous = existingRows.get(JSON.stringify([pair.orderNo, pair.referenceNo]));
    const row = previous ? { ...previous } : { orderNo: pair.orderNo, referenceNo: pair.referenceNo, result: "成功", reason: "" };
    if (pair.status !== "complete") { row.result = "失败"; row.reason = [...new Set([row.reason, pair.error || "下载未完成。"].filter(Boolean))].join("；"); }
    Object.assign(row, manifestFiles(pair.files));
    if (previous && JSON.stringify(row) === JSON.stringify(previous)) continue;
    await update(taskId, sender, async (task, changes) => {
      await upsertRow(task, changes, row);
    }, false);
  }
  await update(taskId, sender, async (task, changes) => {
    if (task.currentRow && !await db.getRow(taskId, task.currentRow)) await upsertRow(task, changes,
      { ...task.currentRow, result: "失败", reason: task.error || "任务中断。", ...manifestFiles() });
    delete task.currentRow;
  }, false);
  })().finally(() => recoveries.delete(taskId));
  recoveries.set(taskId, promise);
  return promise;
};
const exportManifest = (taskId, sender, retry = false) => {
  if (manifestExports.has(taskId)) return manifestExports.get(taskId);
  const promise = (async () => {
  let task = await getTask(); assertTask(task, taskId, sender, false);
  if (task.manifestDownloadId !== undefined && !retry) {
    try { await waitForDownload(task.manifestDownloadId); return await update(taskId, sender, t => { t.manifestError = ""; }, false); }
    catch (error) { return update(taskId, sender, (t, c) => { t.manifestError = "清单下载失败：" + error.message; appendLog(c, "下载清单", t.manifestError, "error"); }, false); }
  }
  const filename = "pic-expert/" + taskId + "/下载清单.csv";
  try {
    const downloadId = await chrome.downloads.download({ url: "data:text/csv;charset=utf-8," + encodeURIComponent(buildManifestCsv(await db.rows(taskId))), filename, saveAs: false, conflictAction: "overwrite" });
    await update(taskId, sender, t => { t.manifestDownloadId = downloadId; t.manifestFilename = filename; }, false);
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
      await reconcile(taskId, sender);
      task = await update(taskId, sender, (t, c) => {
        t.finishedAt = new Date().toISOString();
        t.durationMs = Math.max(0, Date.now() - (Date.parse(t.startedAt) || Date.now()));
        appendLog(c, "处理汇总", "查询 " + (t.checkpoint?.total ?? "未知") + "，检查 " + t.scanned + "，成功 " + t.completed + "，跳过 " + t.skipped + "，失败 " + t.failed + "，历时 " + Math.round(t.durationMs / 1000) + " 秒");
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
  await update(task.id, sender, (t, c) => { t.status = "pausing"; t.forcePause = force; appendLog(c, "暂停任务", force ? "中断当前等待并保存断点" : "等待当前订单结束"); }, false);
  const response = await chrome.tabs.sendMessage(task.tabId, { type: "PIC_EXPERT_PAUSE" }, { frameId: task.frameId }).catch(() => null);
  if (force || !response?.running) {
    await update(task.id, sender, t => { t.forcePause = true; }, false);
    await reconcile(task.id, sender);
    return update(task.id, sender, t => { if (t.status === "pausing") t.status = "paused"; delete t.forcePause; }, false);
  }
  return getTask();
};
const resumeTask = (message, sender) => mutate(async () => {
  if (sender.tab) throw new Error("请从扩展弹窗继续任务。");
  const task = await getTask();
  if (!task || !["paused", "failed"].includes(task.status) || !task.checkpoint) throw new Error("没有可继续的断点，请先完成原查询。");
  if (!Number.isInteger(message.tabId) || !Number.isInteger(message.frameId)) throw new Error("目标页面不完整。");
  task.tabId = message.tabId; task.frameId = message.frameId; task.status = "running"; task.error = "";
  task.generation = (task.generation || 0) + 1;
  delete task.forcePause; task.manifestError = "";
  delete task.finishedAt; delete task.finalStatus; delete task.manifestDownloadId;
  const changes = { logs: [] }; appendLog(changes, "继续任务", "沿用任务目录，从保存页码核对并继续");
  await db.save(task, changes); return task;
});
const rowStatus = async (message, sender) => {
  const task = await getTask();
  assertTask(task, message.taskId, sender);
  const row = await db.getRow(message.taskId, message.identity);
  if (row?.page && row.page !== task.page) throw new Error("同一订单出现在不同页，查询结果已变化。");
  if (row?.result === "跳过") return { done: true };
  if (row?.result !== "成功") return { done: false };
  const pair = await db.getPair(message.taskId, message.identity.referenceNo);
  if (!pair || pair.orderNo !== message.identity.orderNo || pair.status !== "complete") return { done: false };
  for (const file of Object.values(pair.files)) {
    const [item] = await chrome.downloads.search({ id: file.downloadId });
    if (!item || item.state !== "complete" || item.exists === false) {
      await rollback(message.taskId, pair.referenceNo, sender, "已完成文件不存在，准备重新下载。");
      await update(message.taskId, sender, async (_t, c) => { const failed = await db.getPair(message.taskId, pair.referenceNo); failed.generation = (_t.generation || 0) - 1; c.pairs.push(failed); });
      return { done: false };
    }
  }
  return { done: true };
};
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "PIC_EXPERT_TASK_BEGIN": return { ok: true, task: await startTask(message) };
      case "PIC_EXPERT_TASK_RESUME": return { ok: true, task: await resumeTask(message, sender) };
      case "PIC_EXPERT_TASK_PAUSE": return { ok: true, task: await summary(await pauseTask(sender)) };
      case "PIC_EXPERT_TASK_PAUSED": {
        const task = await getTask(); assertTask(task, message.taskId, sender, false);
        if (task.forcePause || !["pausing", "paused"].includes(task.status)) return { ok: true };
        return { ok: true, task: await update(task.id, sender, t => { t.status = "paused"; if (message.error) t.error = message.error; }, false) };
      }
      case "PIC_EXPERT_CHECKPOINT":
        return { ok: true, task: await update(message.taskId, sender, t => {
          const previous = t.checkpoint;
          t.checkpoint = { ...message.checkpoint, visitedBefore: previous?.page === message.checkpoint.page ? previous.visitedBefore : message.checkpoint.visitedBefore };
          t.page = message.checkpoint.page;
        }) };
      case "PIC_EXPERT_ROW_STATUS": return { ok: true, ...await rowStatus(message, sender) };
      case "PIC_EXPERT_LOG":
        await update(message.taskId, sender, (_t, c) => appendLog(c, message.stage, message.message, message.level), false);
        return { ok: true };
      case "PIC_EXPERT_DOWNLOAD_PAIR": return { ok: true, files: await downloadPair(message, sender) };
      case "PIC_EXPERT_ROW_BEGIN":
        return { ok: true, task: await update(message.taskId, sender, (t, c) => { t.currentRow = message.identity; appendLog(c, "检查订单", "订单 " + message.identity.orderNo + "，参考号 " + message.identity.referenceNo); }) };
      case "PIC_EXPERT_MANIFEST_ROW":
        return { ok: true, task: await update(message.taskId, sender, async (t, c) => {
          await upsertRow(t, c, message.row);
          appendLog(c, "订单结果", message.row.result + (message.row.reason ? "：" + message.row.reason : ""), message.row.result === "失败" ? "error" : "info");
        }) };
      case "PIC_EXPERT_PROGRESS":
        return { ok: true, task: await update(message.taskId, sender, t => { t.page = message.page ?? t.page; }) };
      case "PIC_EXPERT_TASK_END": return { ok: true, task: await summary(await finalizeTask(message, sender)) };
      case "PIC_EXPERT_TASK_STOP": {
        const task = await getTask();
        if (!task || !["running", "pausing", "paused", "stopping", "finalizing"].includes(task.status)) return { ok: true, task: await summary(task) };
        await update(task.id, sender, t => { t.status = "stopping"; t.finalStatus = "failed"; t.error = "用户停止任务。"; }, false);
        await chrome.tabs.sendMessage(task.tabId, { type: "PIC_EXPERT_STOP" }, { frameId: task.frameId }).catch(() => {});
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
          const id = await chrome.downloads.download({url:"data:text/plain;charset=utf-8," + encodeURIComponent(text),filename:"pic-expert/" + task.id + "/运行日志-" + String(part++).padStart(3,"0") + ".txt",saveAs:false,conflictAction:"overwrite"});
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
