const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const retryButton = document.querySelector("#retry");
const statusElement = document.querySelector("#status");
const progressElement = document.querySelector("#progress");
const errorElement = document.querySelector("#error");
const logsElement = document.querySelector("#logs");
const copyLogsButton = document.querySelector("#copy-logs");
const copyStatusElement = document.querySelector("#copy-status");
const request = async message => {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "后台无响应。");
  return response;
};
const renderTask = task => {
  const labels = { running: "运行中", stopping: "正在停止", finalizing: "正在生成清单", completed: "已完成", failed: "已停止" };
  statusElement.textContent = task ? labels[task.status] || task.status : "未开始";
  progressElement.textContent = task ? "页 " + task.page + " · 已检查 " + task.scanned +
    " · 成功 " + task.completed + " · 跳过 " + task.skipped + " · 失败 " + task.failed : "";
  errorElement.textContent = [task?.error, task?.manifestError].filter(Boolean).join("\n");
  startButton.disabled = ["running", "stopping", "finalizing"].includes(task?.status);
  stopButton.hidden = !["running", "stopping", "finalizing"].includes(task?.status);
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
startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  errorElement.textContent = "";
  let task;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("没有可用的当前标签页。");
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, files: ["core.js", "page-core.js", "content.js"]
    });
    const probes = await Promise.all(injected.map(async result => ({
      frameId: result.frameId,
      result: await chrome.tabs.sendMessage(tab.id, { type: "PIC_EXPERT_PROBE" }, { frameId: result.frameId }).catch(() => null)
    })));
    const frameId = globalThis.PIC_EXPERT_PAGE_CORE.chooseFrame(probes);
    task = (await request({ type: "PIC_EXPERT_TASK_BEGIN", sourceUrl: tab.url, tabId: tab.id, frameId })).task;
    const response = await chrome.tabs.sendMessage(tab.id, { type: "PIC_EXPERT_START", taskId: task.id }, { frameId });
    if (!response?.ok) throw new Error(response?.error || "页面任务启动失败。");
    renderTask(task);
  } catch (error) {
    if (task) await request({ type: "PIC_EXPERT_TASK_END", taskId: task.id, status: "failed", error: error.message }).catch(() => {});
    await refresh();
    errorElement.textContent = error.message;
    startButton.disabled = false;
  }
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
