// Order files and results share recovery rules; task control stays in background.js.
globalThis.PIC_EXPERT_ORDER_DOWNLOADS = ({ db, downloads, getTask, update, assertTask, appendLog, waitForDownload }) => {
  const { sanitizePathPart, REQUIRED_KINDS, manifestFiles, fileKind, assetNames } = globalThis.PIC_EXPERT_CORE;
  const pairs = new Map(), recoveries = new Map();
  const upsertRow = async (task, changes, row) => {
    const previous = await db.getRow(task.id, row);
    const counter = result => ({ "成功": "completed", "跳过": "skipped", "失败": "failed" }[result]);
    if (previous && counter(previous.result)) task[counter(previous.result)]--;
    if (counter(row.result)) task[counter(row.result)]++;
    if (!previous) task.scanned++;
    changes.rows.push(row);
    row.page ??= task.currentRows?.find(item => item.orderNo === row.orderNo && item.referenceNo === row.referenceNo)?.page || task.page;
    task.currentRows = (task.currentRows || []).filter(item => item.orderNo !== row.orderNo || item.referenceNo !== row.referenceNo);
  };
  const validateAssets = assets => {
    const formats = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp" };
    const kinds = assetNames(assets);
    if (!assets || REQUIRED_KINDS.some(kind => !kinds.some(name => fileKind(name) === kind))) throw new Error("必须提供 SN码和发票图片。");
    if (kinds.some(kind => !fileKind(kind))) throw new Error("图片类型不受支持。");
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
        await downloads.cancel(file.downloadId).catch(() => {});
        const [item] = await downloads.search({ id: file.downloadId });
        if (!item) throw new Error("下载记录丢失，无法确认文件是否已清理。");
        if (item.exists === false || item.state === "interrupted") continue;
        await downloads.removeFile(file.downloadId);
      } catch {
        const [item] = await downloads.search({ id: file.downloadId }).catch(() => []);
        if (item?.exists !== false) leftovers[kind] = file;
      }
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
      if (!previous) changes.pairs.push({ referenceNo, orderNo, status: "pending", generation: _task.generation || 0, files: {}, note: message.note || "" });
      else if (message.note !== undefined && previous.note !== message.note) changes.pairs.push({ ...previous, note: message.note });
    });
    if (pairs.has(key)) return pairs.get(key);
    const promise = (async () => {
      assertTask(await getTask(), taskId, sender);
      let previous = await db.getPair(taskId, referenceNo);
      if (previous.status === "complete") return previous.files;
      if (previous.status === "failed") {
        const task = await getTask();
        if ((previous.generation || 0) !== (task.generation || 0) && Object.keys(previous.files).length) {
          await rollback(taskId, referenceNo, sender, "继续前重新清理残留文件。");
          previous = await db.getPair(taskId, referenceNo);
        }
        if ((previous.generation || 0) === (task.generation || 0) || Object.keys(previous.files).length) {
          const error = new Error(previous.error); error.files = previous.files; throw error;
        }
        await update(taskId, sender, (_task, changes) => { changes.pairs.push({ ...previous, status: "pending", generation: _task.generation, error: "" }); });
      }
      try {
        for (const kind of kinds) {
          const task = await getTask();
          assertTask(task, taskId, sender);
          const pair = await db.getPair(taskId, referenceNo);
          const existing = pair.files[kind];
          const filename = existing?.filename || "pic-expert/" + (task.folderName || task.id) + "/" + sanitizePathPart(referenceNo) + "/" + kind + assets[kind].extension;
          const downloadId = existing?.downloadId ?? await downloads.download({ url: assets[kind].url, filename, saveAs: false, conflictAction: "overwrite" });
          await update(taskId, sender, (_task, changes) => {
            pair.files[kind] = { downloadId, filename };
            changes.pairs.push(pair);
            appendLog(changes, "下载图片", kind + "，编号 " + downloadId + "，路径 " + filename);
          }, false);
          await waitForDownload(downloadId, 120000, taskId);
        }
        await update(taskId, sender, async (_task, changes) => {
          // The page still confirms its result after checking the query context.
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
      // Recover downloaded orders before marking the remaining in-flight orders failed.
      const existingRows = new Map((await db.rows(taskId)).map(row => [JSON.stringify([row.orderNo, row.referenceNo]), row]));
      for (const pair of await db.pairs(taskId)) {
        const previous = existingRows.get(JSON.stringify([pair.orderNo, pair.referenceNo]));
        const row = previous ? { ...previous } : { orderNo: pair.orderNo, referenceNo: pair.referenceNo, result: "成功", reason: pair.note || "" };
        if (pair.note && !(row.reason || "").includes(pair.note)) row.reason = [pair.note, row.reason].filter(Boolean).join("；");
        if (pair.status !== "complete") { row.result = "失败"; row.reason = [...new Set([row.reason, pair.error || "下载未完成。"].filter(Boolean))].join("；"); }
        Object.assign(row, manifestFiles(pair.files));
        if (previous && JSON.stringify(row) === JSON.stringify(previous)) continue;
        await update(taskId, sender, async (task, changes) => {
          await upsertRow(task, changes, row);
        }, false);
      }
      await update(taskId, sender, async (task, changes) => {
        for (const identity of task.currentRows || []) {
          const previous = await db.getRow(taskId, identity);
          await upsertRow(task, changes, { ...manifestFiles(), ...previous, ...identity, result: "失败", reason: [identity.note, task.error || "任务中断。"].filter(Boolean).join("；") });
        }
        task.currentRows = [];
      }, false);
    })().finally(() => recoveries.delete(taskId));
    recoveries.set(taskId, promise);
    return promise;
  };
  const rowStatus = async (message, sender) => {
    const task = await getTask();
    assertTask(task, message.taskId, sender);
    const row = await db.getRow(message.taskId, message.identity);
    if (row?.page && row.page !== task.page) throw new Error("同一订单出现在不同页，查询结果已变化。");
    if (row?.result === "跳过") return { done: !["材料修改", "SN码或发票图片缺失或不唯一"].includes(row.reason) };
    if (row?.result !== "成功") return { done: false };
    const pair = await db.getPair(message.taskId, message.identity.referenceNo);
    if (!pair || pair.orderNo !== message.identity.orderNo || pair.status !== "complete") return { done: false };
    for (const file of Object.values(pair.files)) {
      const [item] = await downloads.search({ id: file.downloadId });
      if (!item || item.state !== "complete" || item.exists === false) {
        await rollback(message.taskId, pair.referenceNo, sender, "已完成文件不存在，准备重新下载。");
        await update(message.taskId, sender, async (_t, c) => { const failed = await db.getPair(message.taskId, pair.referenceNo); failed.generation = (_t.generation || 0) - 1; c.pairs.push(failed); });
        return { done: false };
      }
    }
    return { done: true };
  };
  const recordResult = (message, sender) => update(message.taskId, sender, async (task, changes) => {
    await upsertRow(task, changes, message.row);
    appendLog(changes, "订单结果", message.row.result + (message.row.reason ? "：" + message.row.reason : ""), message.row.result === "失败" ? "error" : "info");
  });
  return { download: downloadPair, status: rowStatus, recordResult, reconcile };
};
