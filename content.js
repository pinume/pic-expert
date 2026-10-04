(() => {
  if (globalThis.__PIC_EXPERT_CONTENT_INSTALLED__) return;
  globalThis.__PIC_EXPERT_CONTENT_INSTALLED__ = true;

  const CORE = globalThis.PIC_EXPERT_PAGE_CORE;
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const visible = (element) => {
    if (!(element instanceof Element) || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const send = (message) => chrome.runtime.sendMessage(message);

  const currentTable = () => {
    const tables = [...document.querySelectorAll("table")].filter(visible);
    const ranked = tables.map((table) => {
      const headers = [...table.querySelectorAll("thead th")].map((cell) => clean(cell.innerText || cell.textContent));
      const fallbackHeaders = headers.length ? headers : [...(table.querySelector("tr")?.children || [])].map((cell) => clean(cell.innerText || cell.textContent));
      const columns = CORE.inferColumns(fallbackHeaders);
      const score = Number(columns.orderNo >= 0) + Number(columns.referenceNo >= 0) + Number(columns.operation >= 0);
      return { table, headers: fallbackHeaders, columns, score };
    }).sort((a, b) => b.score - a.score);
    return ranked[0]?.score >= 2 ? ranked[0] : null;
  };

  const tableRows = (table) => [...table.querySelectorAll("tbody tr")].filter(visible)
    .filter((row) => [...row.querySelectorAll("td")].length > 0);

  const rowIdentity = (row, columns) => {
    const cells = [...row.querySelectorAll("td")];
    const orderNo = clean(cells[columns.orderNo]?.innerText || cells[columns.orderNo]?.textContent);
    const referenceNo = clean(cells[columns.referenceNo]?.innerText || cells[columns.referenceNo]?.textContent);
    return { orderNo, referenceNo };
  };

  const detailControl = (row, operationIndex) => {
    const cells = [...row.querySelectorAll("td")];
    const scope = cells[operationIndex] || row;
    const controls = [...scope.querySelectorAll("a,button,[role=button]")].filter(visible)
      .filter((element) => /^(?:查看详情|详情)$/.test(clean(element.innerText || element.textContent)));
    return controls.length === 1 ? controls[0] : null;
  };

  const visibleLayers = () => [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],.el-dialog__wrapper,.el-dialog,.ant-modal-wrap,.ant-modal,.layui-layer,.modal,.modal-dialog')]
    .filter(visible);

  const layerSignature = () => visibleLayers().map((layer) => clean(layer.innerText || layer.textContent).slice(0, 500)).join("\n---\n");

  const waitForDetailOpen = async (before, identity) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const layers = visibleLayers();
      const changed = layerSignature() !== before;
      const matching = layers.filter((layer) => {
        const text = clean(layer.innerText || layer.textContent);
        return (!identity.orderNo || text.includes(identity.orderNo)) || (!identity.referenceNo || text.includes(identity.referenceNo));
      });
      if (matching.length === 1) return matching[0];
      if (changed && layers.length === 1) return layers[0];
      await sleep(150);
    }
    return null;
  };

  const resolveUrl = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    if (/^(?:data:image\/|blob:)/i.test(raw)) return raw;
    try { return new URL(raw, location.href).href; } catch { return null; }
  };

  const urlsFromNode = (node) => {
    const values = [];
    const candidates = [node, ...node.querySelectorAll?.("img,a,[src],[href]") || []];
    for (const element of candidates) {
      if (!(element instanceof Element)) continue;
      for (const attr of ["src", "data-src", "data-original", "href"]) {
        const value = element.getAttribute(attr);
        if (value && CORE.isImageLikeUrl(value)) values.push(resolveUrl(value));
      }
      const style = getComputedStyle(element).backgroundImage;
      const match = style?.match(/url\(["']?(.+?)["']?\)/i);
      if (match?.[1] && CORE.isImageLikeUrl(match[1])) values.push(resolveUrl(match[1]));
    }
    return values.filter(Boolean);
  };

  const findLabeledAsset = (layer, labelPattern) => {
    const nodes = [...layer.querySelectorAll("*")].filter(visible)
      .filter((element) => labelPattern.test(clean(element.innerText || element.textContent)));
    const candidates = [];
    for (const node of nodes) {
      let current = node;
      for (let depth = 0; current && depth < 6 && layer.contains(current); depth += 1, current = current.parentElement) {
        const urls = urlsFromNode(current);
        if (urls.length) {
          candidates.push(...urls);
          break;
        }
      }
    }
    const direct = [...layer.querySelectorAll("img,a")].filter(visible).flatMap((element) => {
      const hint = `${element.getAttribute("alt") || ""} ${element.getAttribute("title") || ""} ${element.getAttribute("aria-label") || ""}`;
      return labelPattern.test(hint) ? urlsFromNode(element) : [];
    });
    return CORE.chooseUnique([...candidates, ...direct]);
  };

  const closeDetail = async (layer) => {
    const controls = [...layer.querySelectorAll("button,a,[role=button],.el-dialog__headerbtn,.ant-modal-close,.layui-layer-close")]
      .filter(visible);
    const exact = controls.filter((element) => /^(?:关闭|返回|取消|×|✕)?$/.test(clean(element.innerText || element.textContent)) &&
      (/关闭|Close/i.test(element.getAttribute("aria-label") || element.getAttribute("title") || "") || clean(element.innerText || element.textContent)));
    const candidate = exact.length === 1 ? exact[0] : controls.find((element) => /^(?:关闭|返回)$/.test(clean(element.innerText || element.textContent)));
    if (!candidate) return false;
    candidate.click();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!visible(layer)) return true;
      await sleep(100);
    }
    return !visible(layer);
  };

  const nextPageControl = () => {
    const selectors = [
      "button[aria-label='下一页']", "a[aria-label='下一页']", ".el-pagination .btn-next",
      ".ant-pagination-next button", ".ant-pagination-next a", ".layui-laypage-next"
    ];
    const candidates = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))].filter(visible);
    const textCandidates = [...document.querySelectorAll("button,a,[role=button]")].filter(visible)
      .filter((element) => /^(?:下一页|下页|>)$/.test(clean(element.innerText || element.textContent)));
    for (const element of [...candidates, ...textCandidates]) {
      const disabled = element.disabled || element.getAttribute("aria-disabled") === "true" ||
        element.classList.contains("disabled") || element.classList.contains("is-disabled") || element.closest(".disabled,.is-disabled");
      if (!disabled) return element;
    }
    return null;
  };

  const tableSignature = () => {
    const current = currentTable();
    if (!current) return "";
    return tableRows(current.table).slice(0, 3).map((row) => clean(row.innerText || row.textContent)).join("\n");
  };

  const goNextPage = async () => {
    const control = nextPageControl();
    if (!control) return false;
    const before = tableSignature();
    control.click();
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await sleep(250);
      const after = tableSignature();
      if (after && after !== before) return true;
    }
    throw new Error("点击下一页后查询结果没有更新，已停止以避免重复下载。 ");
  };

  const processRow = async ({ row, columns, taskId }) => {
    const identity = rowIdentity(row, columns);
    if (!identity.orderNo || !identity.referenceNo) {
      return { ...identity, result: "跳过", reason: "订单号或参考号缺失", snFile: "", invoiceFile: "" };
    }
    if (CORE.isMaterialModification(row.innerText || row.textContent)) {
      return { ...identity, result: "跳过", reason: "材料修改", snFile: "", invoiceFile: "" };
    }
    const control = detailControl(row, columns.operation);
    if (!control) return { ...identity, result: "失败", reason: "未找到唯一的查看详情入口", snFile: "", invoiceFile: "" };

    const before = layerSignature();
    control.click();
    const layer = await waitForDetailOpen(before, identity);
    if (!layer) return { ...identity, result: "失败", reason: "查看详情未打开", snFile: "", invoiceFile: "" };

    try {
      const snUrl = findLabeledAsset(layer, /^(?:S\/?N码|SN码|序列号)(?:[:：].*)?$/i);
      const invoiceUrl = findLabeledAsset(layer, /^(?:发票|发票图片)(?:[:：].*)?$/i);
      if (!snUrl || !invoiceUrl) {
        return { ...identity, result: "跳过", reason: !snUrl && !invoiceUrl ? "SN码和发票均缺失" : !snUrl ? "SN码缺失" : "发票缺失", snFile: "", invoiceFile: "" };
      }

      const sn = await send({ type: "PIC_EXPERT_DOWNLOAD_FILE", taskId, referenceNo: identity.referenceNo, kind: "SN码", url: snUrl });
      if (!sn?.ok) throw new Error(`SN码下载失败：${sn?.error || "未知错误"}`);
      const invoice = await send({ type: "PIC_EXPERT_DOWNLOAD_FILE", taskId, referenceNo: identity.referenceNo, kind: "发票", url: invoiceUrl });
      if (!invoice?.ok) throw new Error(`发票下载失败：${invoice?.error || "未知错误"}`);
      return { ...identity, result: "成功", reason: "", snFile: sn.result.filename, invoiceFile: invoice.result.filename };
    } catch (error) {
      return { ...identity, result: "失败", reason: error?.message || String(error), snFile: "", invoiceFile: "" };
    } finally {
      if (!await closeDetail(layer)) throw new Error(`订单 ${identity.orderNo} 的详情窗口未能安全关闭。`);
    }
  };

  const run = async () => {
    const started = await send({ type: "PIC_EXPERT_TASK_BEGIN", sourceUrl: location.href });
    if (!started?.ok) throw new Error(started?.error || "无法创建下载任务。 ");
    const taskId = started.task.id;
    const seen = new Set();
    let page = 1, scanned = 0, completed = 0, skipped = 0, failed = 0;

    try {
      while (true) {
        const current = currentTable();
        if (!current || current.columns.orderNo < 0 || current.columns.referenceNo < 0 || current.columns.operation < 0) {
          throw new Error("当前查询结果中未识别到订单号、参考号和操作列。请先在目标页面完成查询。 ");
        }
        const rows = tableRows(current.table);
        if (!rows.length) throw new Error("当前查询结果没有可处理的订单行。 ");

        for (const row of rows) {
          const identity = rowIdentity(row, current.columns);
          const key = `${identity.orderNo}::${identity.referenceNo}`;
          if (seen.has(key)) continue;
          seen.add(key);
          scanned += 1;
          let result;
          try {
            result = await processRow({ row, columns: current.columns, taskId });
          } catch (error) {
            result = { ...identity, result: "失败", reason: error?.message || String(error), snFile: "", invoiceFile: "" };
          }
          if (result.result === "成功") completed += 1;
          else if (result.result === "跳过") skipped += 1;
          else failed += 1;
          await send({ type: "PIC_EXPERT_MANIFEST_ROW", taskId, row: result });
          await send({ type: "PIC_EXPERT_PROGRESS", taskId, page, scanned, completed, skipped, failed, stage: `${page} 页：${scanned} 笔已检查` });
        }

        if (!await goNextPage()) break;
        page += 1;
        await send({ type: "PIC_EXPERT_PROGRESS", taskId, page, scanned, completed, skipped, failed, stage: `进入第 ${page} 页` });
      }

      const ended = await send({ type: "PIC_EXPERT_TASK_END", taskId, status: "completed" });
      if (!ended?.ok) throw new Error(ended?.error || "下载清单生成失败。 ");
      return { ok: true, task: ended.task };
    } catch (error) {
      await send({ type: "PIC_EXPERT_TASK_END", taskId, status: "failed", error: error?.message || String(error) }).catch(() => null);
      throw error;
    }
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "PIC_EXPERT_START") return false;
    run().then((result) => sendResponse(result)).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });
})();
