const openTaskButton = document.querySelector("#open-task");
const entryError = document.querySelector("#entry-error");
chrome.runtime.sendMessage({ type: "PIC_EXPERT_TASK_STATE" }).then(response => {
  if (!response?.ok) throw new Error(response?.error || "无法读取任务状态。");
  const task = response.task;
  const labels = { running: "运行中", pausing: "正在暂停", paused: "已暂停", stopping: "正在停止", finalizing: "生成清单中", completed: "已完成", failed: "已停止" };
  document.querySelector("#entry-status").textContent = task ? labels[task.status] || task.status : "未开始";
  document.querySelector("#entry-progress").textContent = task ? "成功 " + task.completed + " · 跳过 " + task.skipped + " · 失败 " + task.failed : "SN码、发票及证明材料下载";
}).catch(error => { entryError.textContent = error.message; });
openTaskButton.addEventListener("click", async () => {
  openTaskButton.disabled = true;
  try {
    const pageUrl = chrome.runtime.getURL("popup.html");
    const pages = await chrome.tabs.query({ url: pageUrl + "*" });
    if (pages.length) {
      await chrome.tabs.update(pages[0].id, { active: true });
      await chrome.windows.update(pages[0].windowId, { focused: true });
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = new URL(pageUrl);
      if (tab?.url?.startsWith("https://service.chinaums.com/")) url.searchParams.set("tabId", String(tab.id));
      await chrome.tabs.create({ url: url.href });
    }
    window.close();
  } catch (error) { entryError.textContent = error.message; openTaskButton.disabled = false; }
});
