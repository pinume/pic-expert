const startButton = document.querySelector("#start");
const statusElement = document.querySelector("#status");
const progressElement = document.querySelector("#progress");
const errorElement = document.querySelector("#error");
let pollTimer = null;

const renderTask = (task) => {
  if (!task) {
    statusElement.textContent = "未开始";
    progressElement.textContent = "";
    return;
  }
  const labels = { running: "运行中", completed: "已完成", failed: "已停止" };
  statusElement.textContent = labels[task.status] || task.status;
  progressElement.textContent = `页 ${task.page || 1} · 已检查 ${task.scanned || 0} · 成功 ${task.completed || 0} · 跳过 ${task.skipped || 0} · 失败 ${task.failed || 0}${task.stage ? ` · ${task.stage}` : ""}`;
  errorElement.textContent = task.error || "";
  startButton.disabled = task.status === "running";
};

const refresh = async () => {
  const response = await chrome.runtime.sendMessage({ type: "PIC_EXPERT_TASK_STATE" }).catch(() => null);
  if (response?.ok) renderTask(response.task);
};

const beginPolling = () => {
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 750);
};

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  errorElement.textContent = "";
  statusElement.textContent = "正在启动…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("没有可用的当前标签页。 ");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["page-core.js", "content.js"] });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "PIC_EXPERT_START" });
    if (!response?.ok) throw new Error(response?.error || "任务启动失败。 ");
    renderTask(response.task);
  } catch (error) {
    errorElement.textContent = error?.message || String(error);
    startButton.disabled = false;
    await refresh();
  }
});

refresh();
beginPolling();
window.addEventListener("unload", () => clearInterval(pollTimer));
