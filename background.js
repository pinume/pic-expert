importScripts("core.js");

const { sanitizePathPart, extensionFromUrl, buildManifestCsv, makeTaskId } = globalThis.PIC_EXPERT_CORE;
const TASK_KEY = "picExpertTask";
const activeDownloads = new Map();

const storageGet = async () => (await chrome.storage.local.get(TASK_KEY))[TASK_KEY] || null;
const storageSet = async (task) => chrome.storage.local.set({ [TASK_KEY]: task });

const updateTask = async (patch) => {
  const current = await storageGet();
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await storageSet(next);
  return next;
};

const waitForDownload = (downloadId, timeoutMs = 120000) => new Promise((resolve, reject) => {
  let timer;
  const finish = (error, value) => {
    chrome.downloads.onChanged.removeListener(listener);
    clearTimeout(timer);
    error ? reject(error) : resolve(value);
  };
  const listener = (delta) => {
    if (delta.id !== downloadId) return;
    if (delta.error?.current) finish(new Error(delta.error.current));
    else if (delta.state?.current === "interrupted") finish(new Error("download_interrupted"));
    else if (delta.state?.current === "complete") finish(null, downloadId);
  };
  chrome.downloads.onChanged.addListener(listener);
  timer = setTimeout(() => finish(new Error("download_timeout")), timeoutMs);
});

const startTask = async ({ sourceUrl = "" } = {}) => {
  const existing = await storageGet();
  if (existing && existing.status === "running") {
    throw new Error("已有下载任务正在运行，请等待当前任务完成。 ");
  }
  const task = {
    id: makeTaskId(),
    status: "running",
    sourceUrl,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    page: 1,
    scanned: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    manifestRows: [],
    downloads: {}
  };
  await storageSet(task);
  return task;
};

const appendManifestRow = async (taskId, row) => {
  const task = await storageGet();
  if (!task || task.id !== taskId || task.status !== "running") throw new Error("任务身份已失效。 ");
  const key = `${row.orderNo}::${row.referenceNo}`;
  const existingIndex = task.manifestRows.findIndex((item) => `${item.orderNo}::${item.referenceNo}` === key);
  if (existingIndex >= 0) task.manifestRows[existingIndex] = row;
  else task.manifestRows.push(row);
  task.updatedAt = new Date().toISOString();
  await storageSet(task);
  return task;
};

const downloadFile = async ({ taskId, referenceNo, kind, url }) => {
  const task = await storageGet();
  if (!task || task.id !== taskId || task.status !== "running") throw new Error("任务身份已失效。 ");
  if (!referenceNo || !["SN码", "发票"].includes(kind) || !url) throw new Error("下载参数不完整。 ");

  const dedupeKey = `${taskId}::${referenceNo}::${kind}`;
  if (task.downloads[dedupeKey]?.status === "complete") return task.downloads[dedupeKey];
  if (activeDownloads.has(dedupeKey)) return activeDownloads.get(dedupeKey);

  const promise = (async () => {
    const reference = sanitizePathPart(referenceNo, "unknown-reference");
    const extension = extensionFromUrl(url);
    const filename = `pic-expert/${taskId}/${reference}/${kind}${extension}`;
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
    if (!Number.isInteger(downloadId)) throw new Error("Chrome 未返回有效下载编号。 ");
    await waitForDownload(downloadId);
    const current = await storageGet();
    if (!current || current.id !== taskId || current.status !== "running") throw new Error("下载完成时任务身份已失效。 ");
    const result = { status: "complete", downloadId, filename };
    current.downloads[dedupeKey] = result;
    current.updatedAt = new Date().toISOString();
    await storageSet(current);
    return result;
  })().finally(() => activeDownloads.delete(dedupeKey));

  activeDownloads.set(dedupeKey, promise);
  return promise;
};

const finalizeTask = async ({ taskId, status = "completed", error = "" }) => {
  const task = await storageGet();
  if (!task || task.id !== taskId) throw new Error("任务身份已失效。 ");
  const csv = buildManifestCsv(task.manifestRows || []);
  const dataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  const manifestFilename = `pic-expert/${taskId}/下载清单.csv`;
  const manifestDownloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: manifestFilename,
    saveAs: false,
    conflictAction: "uniquify"
  });
  await waitForDownload(manifestDownloadId);
  task.status = status;
  task.error = error;
  task.manifestFilename = manifestFilename;
  task.finishedAt = new Date().toISOString();
  task.updatedAt = task.finishedAt;
  await storageSet(task);
  return task;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "PIC_EXPERT_TASK_BEGIN":
        return { ok: true, task: await startTask({ sourceUrl: sender.tab?.url || message.sourceUrl || "" }) };
      case "PIC_EXPERT_DOWNLOAD_FILE":
        return { ok: true, result: await downloadFile(message) };
      case "PIC_EXPERT_MANIFEST_ROW":
        return { ok: true, task: await appendManifestRow(message.taskId, message.row) };
      case "PIC_EXPERT_PROGRESS": {
        const current = await storageGet();
        if (!current || current.id !== message.taskId || current.status !== "running") throw new Error("任务身份已失效。 ");
        const patch = {};
        for (const key of ["page", "scanned", "completed", "skipped", "failed", "stage"]) {
          if (message[key] !== undefined) patch[key] = message[key];
        }
        return { ok: true, task: await updateTask(patch) };
      }
      case "PIC_EXPERT_TASK_END":
        return { ok: true, task: await finalizeTask(message) };
      case "PIC_EXPERT_TASK_STATE":
        return { ok: true, task: await storageGet() };
      default:
        return { ok: false, error: "unknown_message" };
    }
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
