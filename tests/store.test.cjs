const test = require("node:test");
const assert = require("node:assert/strict");
require("fake-indexeddb/auto");
const { TaskStore } = require("../store.js");
let sequence = 0;
function fixture(initial = null) {
  let value = initial;
  const writes = [];
  const storage = {
    get: async () => ({picExpertTask:structuredClone(value)}),
    set: async data => {writes.push(structuredClone(data));value=structuredClone(data.picExpertTask);}
  };
  const name = "pic-expert-test-" + process.pid + "-" + sequence++;
  return {store:new TaskStore(storage,name),storage,name,writes,value:() => value};
}
const task = () => ({id:"T1",status:"running",scanned:0,completed:0,skipped:0,failed:0});
test("legacy migration preserves rows, pairs and logs but replaces storage with a small pointer", async () => {
  const h = fixture({...task(),manifestRows:[{orderNo:"O1",referenceNo:"R1",result:"成功"}],downloads:{R1:{orderNo:"O1",status:"complete",files:{}}},logs:[{message:"old log"}]});
  const saved = await h.store.getTask();
  assert.equal(saved.completed,1);
  assert.equal(saved.manifestRows,undefined);
  assert.equal(saved.downloads,undefined);
  assert.deepEqual(h.value(),{id:"T1",storeVersion:1});
  assert.equal((await h.store.getRow("T1",{orderNo:"O1",referenceNo:"R1"})).result,"成功");
  assert.equal((await h.store.getPair("T1","R1")).status,"complete");
  assert.equal((await h.store.logs("T1"))[0].message,"old log");
});
test("metadata and changed records commit atomically, with no duplicate order rows", async () => {
  const h=fixture(), t=task();
  await h.store.save(t,{rows:[{orderNo:"O1",referenceNo:"R1",result:"失败"}]});
  await h.store.save({...t,completed:1},{rows:[{orderNo:"O1",referenceNo:"R1",result:"成功"}]});
  assert.equal((await h.store.rows("T1")).length,1);
  assert.equal((await h.store.rows("T1"))[0].result,"成功");
  await assert.rejects(h.store.save({...t,status:"broken"},{rows:[{orderNo:"O2",referenceNo:"R2",bad:()=>{}}]}));
  assert.equal((await h.store.getTask()).status,"running");
  assert.equal((await h.store.rows("T1")).length,1);
});
test("worker restart reopens persisted records and recent logs are ordered", async () => {
  const h=fixture();
  await h.store.save(task(),{logs:Array.from({length:550},(_,i)=>({message:String(i)}))});
  const restarted=new TaskStore(h.storage,h.name);
  assert.equal((await restarted.getTask()).id,"T1");
  const recent=await restarted.logs("T1",500);
  assert.equal(recent.length,500);
  assert.equal(recent[0].message,"50");
  assert.equal(recent.at(-1).message,"549");
  assert.equal((await restarted.logs("T1",Infinity)).length,550);
});
test("log pagination returns every entry exactly once across task boundaries", async () => {
  const h=fixture();
  await h.store.save(task(),{logs:Array.from({length:17},(_,i)=>({message:String(i)}))});
  await h.store.save({...task(),id:"T2"},{logs:[{message:"different task"}]});
  let next=0, page, entries=[];
  do {
    page=await h.store.logPage("T1",next,5); entries.push(...page.logs); next=page.next;
  }while(page.more);
  assert.deepEqual(entries.map(e=>e.message),Array.from({length:17},(_,i)=>String(i)));
});
test("migration retry after pointer-write failure does not duplicate full logs", async () => {
  const h=fixture({...task(),logs:[{message:"once"}]});
  const set=h.storage.set; let failed=false;
  h.storage.set=async data=>{if(!failed){failed=true;throw new Error("pointer failed");}return set(data);};
  await assert.rejects(h.store.getTask(),/pointer failed/);
  await h.store.getTask();
  assert.equal((await h.store.logs("T1",Infinity)).length,1);
});
test("20,000 stored order records do not enlarge metadata or popup-sized log reads", async () => {
  const h=fixture();
  const rows=Array.from({length:20000},(_,i)=>({orderNo:"O"+i,referenceNo:"R"+i,result:"成功",reason:""}));
  await h.store.save({...task(),scanned:20000,completed:20000},{rows});
  const saved=await h.store.getTask();
  assert.ok(JSON.stringify(saved).length<200);
  assert.equal((await h.store.getRow("T1",{orderNo:"O19999",referenceNo:"R19999"})).result,"成功");
  await h.store.save({...saved,page:200});
  assert.equal((await h.store.rows("T1")).length,20000);
  assert.equal(h.writes.length,1);
});
