(() => {
  // Rows, pairs and logs are independent records. A metadata update never rewrites them.
  class TaskStore {
    constructor(storage, databaseName = "pic-expert") {
      this.storage = storage;
      this.databaseName = databaseName;
    }
    open() {
      this.database ||= new Promise((resolve, reject) => {
        const request = indexedDB.open(this.databaseName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("tasks", { keyPath: "id" });
          for (const name of ["rows", "pairs"]) {
            const store = db.createObjectStore(name, { keyPath: ["taskId", "key"] });
            store.createIndex("taskId", "taskId");
          }
          const logs = db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
          logs.createIndex("taskId", "taskId");
          logs.createIndex("sequence", ["taskId", "id"]);
        };
        request.onsuccess = () => {
          request.result.onversionchange = () => { request.result.close(); this.database = null; };
          resolve(request.result);
        };
        request.onerror = () => { this.database = null; reject(request.error); };
        request.onblocked = () => { this.database = null; reject(new Error("任务数据库被其他窗口占用，请关闭旧扩展窗口。")); };
      });
      return this.database;
    }
    async ready() {
      this.initializing ||= (async () => {
        const { picExpertTask: legacy } = await this.storage.get("picExpertTask");
        if (!legacy) return;
        if (legacy.storeVersion === 1) { this.activeId = legacy.id; return; }
        const { manifestRows = [], downloads = {}, logs = [], ...task } = legacy;
        task.scanned = manifestRows.length;
        for (const [key, result] of [["completed", "成功"], ["skipped", "跳过"], ["failed", "失败"]]) task[key] = manifestRows.filter(row => row.result === result).length;
        if (!await this.read("tasks", task.id)) await this.commit(task, { rows: manifestRows, pairs: Object.entries(downloads).map(([referenceNo, pair]) => ({ referenceNo, ...pair })), logs });
        await this.storage.set({ picExpertTask: { id: task.id, storeVersion: 1 } });
        this.activeId = task.id;
      })().catch(error => { this.initializing = null; throw error; });
      return this.initializing;
    }
    async read(name, key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    }
    async records(name, taskId, limit = Infinity) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const result = [];
        const index = db.transaction(name).objectStore(name).index("taskId");
        if (limit === Infinity) {
          const request = index.getAll(IDBKeyRange.only(taskId));
          request.onsuccess = () => resolve(request.result.map(record => record.value));
          request.onerror = () => reject(request.error);
          return;
        }
        const request = index.openCursor(IDBKeyRange.only(taskId), "prev");
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || result.length >= limit) { resolve(result.reverse()); return; }
          result.push(cursor.value.value);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    }
    async commit(task, changes = {}) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const names = ["tasks", ...["rows", "pairs", "logs"].filter(name => changes[name]?.length)];
        const tx = db.transaction(names, "readwrite");
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error("任务保存失败。"));
        tx.onerror = () => {}; // onabort is the authoritative failure.
        try {
          tx.objectStore("tasks").put(task);
          for (const row of changes.rows || []) tx.objectStore("rows").put({ taskId: task.id, key: JSON.stringify([row.orderNo, row.referenceNo]), value: row });
          for (const pair of changes.pairs || []) tx.objectStore("pairs").put({ taskId: task.id, key: pair.referenceNo, value: pair });
          for (const entry of changes.logs || []) tx.objectStore("logs").add({ taskId: task.id, value: entry });
        } catch (error) { tx.abort(); reject(error); }
      });
    }
    async save(task, changes = {}) {
      await this.ready();
      await this.commit(task, changes);
      if (this.activeId !== task.id) {
        await this.storage.set({ picExpertTask: { id: task.id, storeVersion: 1 } });
        this.activeId = task.id;
      }
    }
    async getTask() {
      await this.ready();
      return this.activeId ? this.read("tasks", this.activeId) : null;
    }
    async getRow(taskId, identity) { return (await this.read("rows", [taskId, JSON.stringify([identity.orderNo, identity.referenceNo])]))?.value || null; }
    async getPair(taskId, referenceNo) { return (await this.read("pairs", [taskId, referenceNo]))?.value || null; }
    rows(taskId) { return this.records("rows", taskId); }
    pairs(taskId) { return this.records("pairs", taskId); }
    logs(taskId, limit = 500) { return this.records("logs", taskId, limit); }
    async logPage(taskId, after = 0, limit = 5000) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const logs = [];
        let next = after;
        const request = db.transaction("logs").objectStore("logs").index("sequence")
          .openCursor(IDBKeyRange.bound([taskId, after], [taskId, Infinity], true));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || logs.length === limit) { resolve({ logs, next, more: Boolean(cursor) }); return; }
          logs.push(cursor.value.value); next = cursor.primaryKey; cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { TaskStore };
  if (typeof chrome !== "undefined") globalThis.PIC_EXPERT_STORE = new TaskStore(chrome.storage.local);
})();
