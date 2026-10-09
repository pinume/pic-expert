class MemoryStore {
  constructor(initial = null) {
    this.tasks = new Map(); this.rowMap = new Map(); this.pairMap = new Map(); this.logMap = new Map(); this.pageMap = new Map(); this.writes = [];
    if (initial) {
      const {manifestRows = [],downloads = {},logs = [],...task} = structuredClone(initial);
      task.scanned = manifestRows.length;
      for (const [key,result] of [["completed","成功"],["skipped","跳过"],["failed","失败"]]) task[key] = manifestRows.filter(r => r.result === result).length;
      this.activeId = task.id; this.tasks.set(task.id,task);
      this.rowMap.set(task.id,new Map(manifestRows.map(r => [JSON.stringify([r.orderNo,r.referenceNo]),r])));
      this.pairMap.set(task.id,new Map(Object.entries(downloads).map(([referenceNo,pair]) => [referenceNo,{referenceNo,...pair}])));
      this.logMap.set(task.id,logs);
    }
  }
  async getTask() { return structuredClone(this.tasks.get(this.activeId) || null); }
  async save(task, changes = {}) {
    this.activeId = task.id; this.tasks.set(task.id,structuredClone(task));
    this.rowMap.set(task.id,this.rowMap.get(task.id) || new Map());
    this.pairMap.set(task.id,this.pairMap.get(task.id) || new Map());
    this.logMap.set(task.id,this.logMap.get(task.id) || []);
    this.pageMap.set(task.id,this.pageMap.get(task.id) || new Map());
    for (const row of changes.rows || []) this.rowMap.get(task.id).set(JSON.stringify([row.orderNo,row.referenceNo]),structuredClone(row));
    for (const pair of changes.pairs || []) this.pairMap.get(task.id).set(pair.referenceNo,structuredClone(pair));
    for (const page of changes.pages || []) this.pageMap.get(task.id).set(page.page,structuredClone(page));
    this.logMap.get(task.id).push(...structuredClone(changes.logs || []));
    this.writes.push({metadataBytes:JSON.stringify(task).length,rows:changes.rows?.length || 0,pairs:changes.pairs?.length || 0});
  }
  async getRow(id,row) { return structuredClone(this.rowMap.get(id)?.get(JSON.stringify([row.orderNo,row.referenceNo])) || null); }
  async getPair(id,ref) { return structuredClone(this.pairMap.get(id)?.get(ref) || null); }
  async getPage(id,page) { return structuredClone(this.pageMap.get(id)?.get(page) || null); }
  async rows(id) { return structuredClone([...this.rowMap.get(id)?.values() || []]); }
  async pairs(id) { return structuredClone([...this.pairMap.get(id)?.values() || []]); }
  async logs(id,limit=500) { const logs=this.logMap.get(id) || []; return structuredClone(limit===Infinity?logs:logs.slice(-limit)); }
  async logPage(id,after=0,limit=5000) { const logs=this.logMap.get(id)||[]; const end=Math.min(after+limit,logs.length); return {logs:structuredClone(logs.slice(after,end)),next:end,more:end<logs.length}; }
  snapshot() {
    const task = this.tasks.get(this.activeId);
    return task ? structuredClone({...task,manifestRows:[...this.rowMap.get(task.id)?.values() || []],downloads:Object.fromEntries(this.pairMap.get(task.id) || []),logs:(this.logMap.get(task.id) || []).slice(-500)}) : null;
  }
}
module.exports = {MemoryStore};
