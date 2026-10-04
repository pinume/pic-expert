importScripts("core.js");
const { sanitizePathPart, buildManifestCsv, makeTaskId, REQUIRED_KINDS, ASSET_KINDS, manifestFiles } = globalThis.PIC_EXPERT_CORE;
const TASK_KEY = "picExpertTask";
const pairs = new Map();
const endings = new Map();
let stateQueue = Promise.resolve();
const getTask = async () => (await chrome.storage.local.get(TASK_KEY))[TASK_KEY] || null;
const saveTask = task => chrome.storage.local.set({ [TASK_KEY]: task });
const appendLog = (task, stage, message, level = "info") => {
  task.logs ||= [];
  task.logs.push({ time: new Date().toISOString(), level: level === "error" ? "error" : "info",
    stage: String(stage || "任务").slice(0, 80), message: String(message || "").slice(0, 500) });
  task.logs = task.logs.slice(-500);
};
const mutate = operation => {
  const promise = stateQueue.then(operation);
  stateQueue = promise.catch(() => {});
  return promise;
};
const assertTask = (task, id, sender, running = true) => {
  if (!task || task.id !== id || (running && task.status !== "running")) throw new Error("任务身份已失效。");
  if (sender.tab && (sender.tab.id !== task.tabId || sender.frameId !== task.frameId)) throw new Error("消息来自其他页面或 frame。");
};
const waitForDownload = async (id, timeoutMs = 120000, taskId = null) => {
  if (!Number.isInteger(id)) throw new Error("Chrome 未返回有效下载编号。");
  // Read persistent state: completion may precede listener setup or worker restart.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (taskId) {
      const task = await getTask();
      if (task?.id !== taskId || task.status !== "running") throw new Error("任务已停止。");
    }
    const [item] = await chrome.downloads.search({ id });
    if (!item) throw new Error("下载记录丢失。");
    if (item.state === "complete") return item;
    if (item.state === "interrupted") throw new Error(item.error || "download_interrupted");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("download_timeout");
};
const startTask = message => mutate(async () => {
  const existing = await getTask();
  if (["running", "stopping", "finalizing"].includes(existing?.status)) throw new Error("已有任务正在运行；页面中断时请先点击停止任务。");
  if (!Number.isInteger(message.tabId) || !Number.isInteger(message.frameId)) throw new Error("目标页面不完整。");
  const task = { id: makeTaskId(), status: "running", tabId: message.tabId, frameId: message.frameId,
    sourceUrl: message.sourceUrl, startedAt: new Date().toISOString(), page: 1,
    scanned: 0, completed: 0, skipped: 0, failed: 0, manifestRows: [], downloads: {} };
  appendLog(task, "创建任务", "任务 " + task.id + "，frame " + task.frameId);
  await saveTask(task);
  return task;
});
const patchTask = (id, sender, operation, running = true) => mutate(async () => {
  const task = await getTask();
  assertTask(task, id, sender, running);
  operation(task);
  task.updatedAt = new Date().toISOString();
  await saveTask(task);
  return task;
});
const validateAssets = assets => {
  const formats = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp" };
  if (!assets || REQUIRED_KINDS.some(kind => !assets[kind])) throw new Error("必须提供 SN码和发票两张图片。");
  if (Object.keys(assets).some(kind => !ASSET_KINDS.includes(kind))) throw new Error("图片类型不受支持。");
  const kinds = ASSET_KINDS.filter(kind => Object.hasOwn(assets, kind));
  for (const kind of kinds) {
    const asset = assets?.[kind];
    if (!asset || !formats[asset.extension] || !asset.url?.startsWith("data:" + formats[asset.extension] + ";base64,")) {
      throw new Error(kind + "图片格式未验证。");
    }
  }
  return kinds;
};
const downloadPair = async (message, sender) => {
  const { taskId, orderNo, referenceNo, assets } = message;
  const kinds = validateAssets(assets);
  if (!orderNo || !/^[A-Za-z0-9_-]+$/.test(referenceNo || "")) throw new Error("订单身份不完整。");
  const key = taskId + "::" + referenceNo;
  await patchTask(taskId, sender, task => {
    const previous = task.downloads[referenceNo];
    if (previous && previous.orderNo !== orderNo) throw new Error("同一参考号对应多个订单，已停止。");
    if (!previous) task.downloads[referenceNo] = { orderNo, status: "pending", files: {} };
  });
  if (pairs.has(key)) return pairs.get(key);
  const promise = (async () => {
    let task = await getTask();
    assertTask(task, taskId, sender);
    let pair = task.downloads[referenceNo];
    if (pair.status === "complete") return pair.files;
    if (pair.status === "failed") throw new Error(pair.error || "该参考号下载失败，需重新运行任务。");
    try {
      for (const kind of kinds) {
        task = await getTask();
        assertTask(task, taskId, sender);
        const existing = task.downloads[referenceNo].files[kind];
        const filename = existing?.filename || "pic-expert/" + taskId + "/" + sanitizePathPart(referenceNo) + "/" + kind + assets[kind].extension;
        const downloadId = existing?.downloadId ?? await chrome.downloads.download({
          url: assets[kind].url, filename, saveAs: false, conflictAction: "overwrite"
        });
        await patchTask(taskId, sender, t => {
          t.downloads[referenceNo].files[kind] = { downloadId, filename };
          appendLog(t, "下载图片", kind + "，编号 " + downloadId + "，路径 " + filename);
        }, false);
        await waitForDownload(downloadId, 120000, taskId);
      }
      task = await patchTask(taskId, sender, t => {
        t.downloads[referenceNo].status = "complete";
        appendLog(t, "配对完成", "参考号 " + referenceNo + "，共 " + kinds.length + " 张图片下载完成");
      });
      return task.downloads[referenceNo].files;
    } catch (error) {
      // Remove only this pair's files; retain paths when rollback fails.
      task = await getTask();
      if (task?.id === taskId) {
        pair = task.downloads[referenceNo];
        const leftovers = {};
        for (const [kind, file] of Object.entries(pair.files)) {
          try {
            await chrome.downloads.cancel(file.downloadId).catch(() => {});
            await chrome.downloads.removeFile(file.downloadId);
          } catch { leftovers[kind] = file; }
        }
        const reason = error.message + (Object.keys(leftovers).length ? "；部分文件无法清理，请查看运行日志。" : "");
        await patchTask(taskId, sender, t => {
          t.downloads[referenceNo] = { orderNo, status: "failed", files: leftovers, error: reason };
          appendLog(t, "下载回滚", "参考号 " + referenceNo + "：" + reason, "error");
          for (const [kind, file] of Object.entries(leftovers)) appendLog(t, "残留文件", kind + "：" + file.filename, "error");
        }, false);
        const failure = new Error(reason);
        failure.files = leftovers;
        throw failure;
      }
      throw error;
    }
  })().finally(() => pairs.delete(key));
  pairs.set(key, promise);
  return promise;
};
const finalizeTask = (message, sender) => {
  const { taskId } = message;
  if (endings.has(taskId)) return endings.get(taskId);
  const promise = (async () => {
    let task = await patchTask(taskId, sender, t => {
      if (t.finishedAt) return;
      t.status = "finalizing";
      t.finalStatus = message.status === "completed" ? "completed" : "failed";
      t.error = message.error || t.error || "";
      appendLog(t, "结束任务", t.finalStatus + (t.error ? "：" + t.error : ""), t.finalStatus === "failed" ? "error" : "info");
    }, false);
    if (!task.finishedAt) {
      await Promise.allSettled([...pairs.entries()].filter(([key]) => key.startsWith(taskId + "::")).map(([, promise]) => promise));
      task = await getTask();
      for (const [referenceNo, pair] of Object.entries(task.downloads)) {
        if (pair.status === "pending") {
          const leftovers = {};
          for (const [kind, file] of Object.entries(pair.files)) {
            try {
              await chrome.downloads.cancel(file.downloadId).catch(() => {});
              await chrome.downloads.removeFile(file.downloadId);
            } catch { leftovers[kind] = file; }
          }
          await patchTask(taskId, sender, t => {
            t.downloads[referenceNo] = { ...pair, status: "failed", files: leftovers,
              error: "任务中断。" + (Object.keys(leftovers).length ? "部分文件无法清理，请查看运行日志。" : "") };
            appendLog(t, "恢复下载", "参考号 " + referenceNo + "：" + t.downloads[referenceNo].error, "error");
            for (const [kind, file] of Object.entries(leftovers)) appendLog(t, "残留文件", kind + "：" + file.filename, "error");
          }, false);
        }
      }
      task = await patchTask(taskId, sender, t => {
        for (const [referenceNo, pair] of Object.entries(t.downloads)) {
          const existing = t.manifestRows.find(row => row.referenceNo === referenceNo && row.orderNo === pair.orderNo);
          const row = existing || { orderNo: pair.orderNo, referenceNo, result: "成功", reason: "" };
          if (pair.status !== "complete") {
            row.result = "失败";
            row.reason = [...new Set([row.reason, pair.error || "下载未完成。"].filter(Boolean))].join("；");
          }
          Object.assign(row, manifestFiles(pair.files));
          if (!existing) t.manifestRows.push(row);
        }
        if (t.currentRow && !t.manifestRows.some(row => row.orderNo === t.currentRow.orderNo && row.referenceNo === t.currentRow.referenceNo)) {
          t.manifestRows.push({ ...t.currentRow, result: "失败", reason: t.error || "任务中断。", ...manifestFiles() });
        }
        delete t.currentRow;
        t.scanned = t.manifestRows.length;
        t.finishedAt = new Date().toISOString();
        for (const [key, result] of [["completed", "成功"], ["skipped", "跳过"], ["failed", "失败"]]) {
          t[key] = t.manifestRows.filter(row => row.result === result).length;
        }
      }, false);
    }
    const settle = () => patchTask(taskId, sender, t => {
      if (t.finalStatus) { t.status = t.finalStatus; delete t.finalStatus; }
    }, false);
    if (task.manifestDownloadId !== undefined) {
      try {
        await waitForDownload(task.manifestDownloadId);
        await patchTask(taskId, sender, t => { t.manifestError = ""; }, false);
      }
      catch (error) { await patchTask(taskId, sender, t => { t.manifestError = "清单下载失败：" + error.message; }, false); }
      return settle();
    }
    const filename = "pic-expert/" + taskId + "/下载清单.csv";
    try {
      const downloadId = await chrome.downloads.download({
        url: "data:text/csv;charset=utf-8," + encodeURIComponent(buildManifestCsv(task.manifestRows)),
        filename, saveAs: false, conflictAction: "overwrite"
      });
      task = await patchTask(taskId, sender, t => { t.manifestDownloadId = downloadId; t.manifestFilename = filename; }, false);
      await waitForDownload(downloadId);
      task = await patchTask(taskId, sender, t => { t.manifestError = ""; appendLog(t, "下载清单", "清单已下载：" + filename); }, false);
    } catch (error) {
      task = await patchTask(taskId, sender, t => {
        t.manifestError = "清单下载失败：" + error.message;
        appendLog(t, "下载清单", t.manifestError, "error");
      }, false);
    }
    return settle();
  })().finally(() => endings.delete(taskId));
  endings.set(taskId, promise);
  return promise;
};
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "PIC_EXPERT_TASK_BEGIN": return { ok: true, task: await startTask(message) };
      case "PIC_EXPERT_LOG":
        await patchTask(message.taskId, sender, t => { appendLog(t, message.stage, message.message, message.level); }, false);
        return { ok: true };
      case "PIC_EXPERT_DOWNLOAD_PAIR": return { ok: true, files: await downloadPair(message, sender) };
      case "PIC_EXPERT_ROW_BEGIN":
        return { ok: true, task: await patchTask(message.taskId, sender, t => {
          t.currentRow = message.identity;
          appendLog(t, "检查订单", "订单 " + message.identity.orderNo + "，参考号 " + message.identity.referenceNo);
        }) };
      case "PIC_EXPERT_MANIFEST_ROW":
        return { ok: true, task: await patchTask(message.taskId, sender, t => {
          const key = r => r.orderNo + "::" + r.referenceNo;
          const index = t.manifestRows.findIndex(r => key(r) === key(message.row));
          if (index < 0) t.manifestRows.push(message.row); else t.manifestRows[index] = message.row;
          if (index < 0) appendLog(t, "订单结果", message.row.result + (message.row.reason ? "：" + message.row.reason : ""), message.row.result === "失败" ? "error" : "info");
          if (t.currentRow && key(t.currentRow) === key(message.row)) delete t.currentRow;
        }) };
      case "PIC_EXPERT_PROGRESS":
        return { ok: true, task: await patchTask(message.taskId, sender, t => {
          for (const key of ["page", "scanned", "completed", "skipped", "failed", "stage"]) {
            if (message[key] !== undefined) t[key] = message[key];
          }
        }) };
      case "PIC_EXPERT_TASK_END": return { ok: true, task: await finalizeTask(message, sender) };
      case "PIC_EXPERT_TASK_STOP": {
        const task = await getTask();
        if (!task || !["running", "stopping", "finalizing"].includes(task.status)) return { ok: true, task };
        await patchTask(task.id, sender, t => { t.status = "stopping"; t.finalStatus = "failed"; t.error = "用户停止任务。"; }, false);
        await chrome.tabs.sendMessage(task.tabId, { type: "PIC_EXPERT_STOP" }, { frameId: task.frameId }).catch(() => {});
        return { ok: true, task: await finalizeTask({ taskId: task.id, status: "failed", error: "用户停止任务。" }, sender) };
      }
      case "PIC_EXPERT_MANIFEST_RETRY": {
        const task = await getTask();
        if (!task || !["completed", "failed"].includes(task.status)) throw new Error("请等待任务结束。");
        if (task.manifestDownloadId !== undefined) {
          const [item] = await chrome.downloads.search({ id: task.manifestDownloadId });
          if (["complete", "in_progress"].includes(item?.state)) {
            try {
              await waitForDownload(item.id);
              return { ok: true, task: await patchTask(task.id, sender, t => { t.manifestError = ""; }, false) };
            } catch (error) {
              await patchTask(task.id, sender, t => { t.manifestError = "清单下载失败：" + error.message; }, false);
              throw error;
            }
          }
        }
        await patchTask(task.id, sender, t => { delete t.manifestDownloadId; }, false);
        return { ok: true, task: await finalizeTask({ taskId: task.id }, sender) };
      }
      case "PIC_EXPERT_TASK_STATE": return { ok: true, task: await getTask() };
      default: return { ok: false, error: "unknown_message" };
    }
  })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message, files: error.files }));
  return true;
});
