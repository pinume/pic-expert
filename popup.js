const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const retryButton = document.querySelector("#retry");
const pauseButton = document.querySelector("#pause");
const resumeButton = document.querySelector("#resume");
const exportLogsButton = document.querySelector("#export-logs");
const statusElement = document.querySelector("#status");
const progressElement = document.querySelector("#progress");
const completionElement = document.querySelector("#completion");
const errorElement = document.querySelector("#error");
const logsElement = document.querySelector("#logs");
const copyLogsButton = document.querySelector("#copy-logs");
const copyStatusElement = document.querySelector("#copy-status");
let exportingLogs = false;
const request = async message => {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "后台无响应。");
  return response;
};
const renderTask = task => {
  const labels = { running: "运行中", pausing: "等待当前订单结束后暂停", paused: "已暂停", stopping: "正在停止", finalizing: "正在生成清单", completed: "已完成", failed: "已停止" };
  statusElement.textContent = task ? labels[task.status] || task.status : "未开始";
  progressElement.textContent = task ? "页 " + task.page + " · 已检查 " + task.scanned +
    " · 成功 " + task.completed + " · 跳过 " + task.skipped + " · 失败 " + task.failed +
    (task.checkpoint ? " · 查询总数 " + task.checkpoint.total : "") : "";
  const terminal = task && ["completed", "failed"].includes(task.status);
  completionElement.hidden = !terminal;
  completionElement.dataset.status = terminal ? task.status : "";
  completionElement.textContent = terminal ?
    (task.status === "completed" ? "任务已完成" : "任务已停止") + "。成功 " + task.completed + "，跳过 " + task.skipped +
      "，失败 " + task.failed + "。" + (task.manifestError ? "清单下载失败" :
        task.manifestDownloadId !== undefined ? "清单已下载" : "清单状态未知") : "";
  errorElement.textContent = [task?.error, task?.manifestError].filter(Boolean).join("\n");
  startButton.disabled = ["running", "pausing", "stopping", "finalizing"].includes(task?.status);
  stopButton.hidden = !["running", "pausing", "paused", "stopping", "finalizing"].includes(task?.status);
  pauseButton.hidden = !["running", "pausing"].includes(task?.status);
  pauseButton.textContent = task?.status === "pausing" ? "立即暂停当前等待" : "暂停任务";
  resumeButton.hidden = !["paused", "failed"].includes(task?.status) || !task?.checkpoint;
  exportLogsButton.disabled = !task || exportingLogs;
  retryButton.hidden = !task?.manifestError;
  const logText = (task?.logs || []).map(entry => new Date(entry.time).toLocaleString("zh-CN", { hour12: false }) +
    " [" + entry.level + "] " + entry.stage + "：" + entry.message).join("\n");
  if (logsElement.value !== logText) {
    logsElement.value = logText;
    logsElement.scrollTop = logsElement.scrollHeight;
  }
  copyLogsButton.disabled = !logText;
};
const refresh = async () => {
  try { renderTask((await request({ type: "PIC_EXPERT_TASK_STATE" })).task); }
  catch (error) { errorElement.textContent = error.message; }
};
const launch = async resume => {
  startButton.disabled = true;
  errorElement.textContent = "";
  let task;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("没有可用的当前标签页。");
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, files: ["core.js", "page-core.js", "site-api.js", "content.js"]
    });
    const probes = await Promise.all(injected.map(async result => ({
      frameId: result.frameId,
      result: await chrome.tabs.sendMessage(tab.id, { type: "PIC_EXPERT_PROBE" }, { frameId: result.frameId }).catch(() => null)
    })));
    const frameId = globalThis.PIC_EXPERT_PAGE_CORE.chooseFrame(probes);
    const probe = probes.find(item => item.frameId === frameId)?.result;
    if (probe?.running) throw new Error("页面上一笔任务仍在退出，请稍候，或手动刷新并恢复原查询后继续。");
    task = (await request({ type: resume ? "PIC_EXPERT_TASK_RESUME" : "PIC_EXPERT_TASK_BEGIN", tabId: tab.id, frameId,
      ...(resume ? {} : { tradeDateRange: probe?.tradeDateRange }) })).task;
    const response = await chrome.tabs.sendMessage(tab.id, { type: "PIC_EXPERT_START", taskId: task.id, checkpoint: resume ? task.checkpoint : null }, { frameId });
    if (!response?.ok) throw new Error(response?.error || "页面任务启动失败。");
    renderTask(task);
  } catch (error) {
    if (task) await request({ type: "PIC_EXPERT_TASK_END", taskId: task.id, status: "failed", error: error.message }).catch(() => {});
    await refresh();
    errorElement.textContent = error.message;
    startButton.disabled = false;
  }
};
startButton.addEventListener("click", () => launch(false));
resumeButton.addEventListener("click", async () => {
  resumeButton.disabled = true;
  try { await launch(true); } finally { resumeButton.disabled = false; }
});
pauseButton.addEventListener("click", async () => {
  pauseButton.disabled = true;
  try { renderTask((await request({ type: "PIC_EXPERT_TASK_PAUSE" })).task); }
  catch (error) { errorElement.textContent = error.message; }
  finally { pauseButton.disabled = false; }
});
exportLogsButton.addEventListener("click", async () => {
  exportingLogs = true;
  exportLogsButton.disabled = true;
  try { await request({ type: "PIC_EXPERT_LOG_EXPORT" }); copyStatusElement.textContent = "完整日志已开始下载"; }
  catch (error) { errorElement.textContent = error.message; }
  finally { exportingLogs = false; exportLogsButton.disabled = false; }
});
stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  try { renderTask((await request({ type: "PIC_EXPERT_TASK_STOP" })).task); }
  catch (error) { errorElement.textContent = error.message; }
  finally { stopButton.disabled = false; }
});
retryButton.addEventListener("click", async () => {
  retryButton.disabled = true;
  try { renderTask((await request({ type: "PIC_EXPERT_MANIFEST_RETRY" })).task); }
  catch (error) { errorElement.textContent = error.message; }
  finally { retryButton.disabled = false; }
});
copyLogsButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(logsElement.value);
    copyStatusElement.textContent = "已复制";
  } catch {
    logsElement.focus();
    logsElement.select();
    copyStatusElement.textContent = document.execCommand("copy") ? "已复制" : "请手动复制已选中的日志";
  }
});
refresh();
const pollTimer = setInterval(refresh, 1000);
window.addEventListener("unload", () => clearInterval(pollTimer));
