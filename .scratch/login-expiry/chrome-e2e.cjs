const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const repo = path.resolve(__dirname, '../..');
const configPath = path.join(__dirname, 'run.json');
const scripts = ['core.js', 'page-core.js', 'site-api.js', 'content.js', 'background.js', 'store.js', 'order-downloads.js', 'popup.js', 'popup.html', 'styles.css'];
if (process.argv[2] === 'prepare') {
  const root = fs.mkdtempSync('/tmp/pic-export-login-e2e-');
  const cfg = { root, profile: path.join(root, 'profile'), extension: path.join(root, 'extension'), downloads: path.join(root, 'downloads'), port: 9224 };
  for (const dir of [cfg.profile, cfg.extension, cfg.downloads, path.join(cfg.profile, 'Default')]) fs.mkdirSync(dir, { recursive: true });
  for (const file of scripts) fs.copyFileSync(path.join(repo, file), path.join(cfg.extension, file));
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'manifest.json')));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(cfg.extension, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(cfg.profile, 'Default/Preferences'), JSON.stringify({ download: { default_directory: cfg.downloads, prompt_for_download: false, directory_upgrade: true } }));
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  console.log(JSON.stringify(cfg));
  process.exit(0);
}
const cfg = JSON.parse(fs.readFileSync(configPath));
for (const file of scripts) assert.ok(fs.readFileSync(path.join(repo, file)).equals(fs.readFileSync(path.join(cfg.extension, file))), 'Test extension differs: ' + file);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(150); }
  throw new Error('Timed out: ' + label);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(name) {
  const chunk = (type, data) => { const bytes = Buffer.concat([Buffer.from(type), data]); const length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(bytes)); return Buffer.concat([length, bytes, crc]); };
  const header = Buffer.from([0,0,0,1,0,0,0,1,8,2,0,0,0]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('tEXt', Buffer.from('source\0' + name)), chunk('IDAT', zlib.deflateSync(Buffer.from([0,15,100,220]))), chunk('IEND', Buffer.alloc(0))]);
}
const rows = [1,2,3].map(n => ({ merOrderId: 'TEST-O' + n, transRef: 'TEST-R' + n, id: 'TEST-' + n, mchntId: 'LOCAL-TEST', status: n === 2 ? '08' : 'S02', statusDesc: n === 2 ? '材料修改' : '审核通过' }));
const fields = [
  { type: 'img', key: 'sn1', desc: 'SN码' }, { type: 'img', key: 'sn2', desc: 'SN码照片' },
  { type: 'img', key: 'inv1', desc: '发票' }, { type: 'img', key: 'inv2', desc: '发票图片' },
  { type: 'img', key: 'proof', desc: '证明材料图三' }
];
const api = '/uisportal/api/uis-tradein-server/';
const events = [], servedImages = new Map();
let token = 'fixture-old-session', expired = false, expirePending;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const reply = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(status === 200 ? { success: true, data } : { success: false, message: '登录已过期' })); };
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Pic Expert 登录恢复测试（仅3笔）</title>
      <div class="search-item"><label>交易日期*</label><input value="2026/10/01 ~ 2026/10/09"></div>
      <div class="search-item"><label>订单状态</label><input class="el-input__inner" value=""></div>
      <div class="el-table"><div class="el-table__header-wrapper"><table><thead><tr><th>订单号</th><th>参考号</th></tr></thead></table></div>
      <div class="el-table__body-wrapper"><table><tbody>${rows.map(r => '<tr><td>' + r.merOrderId + '</td><td>' + r.transRef + '</td></tr>').join('')}</tbody></table></div></div>
      <div class="el-pagination"><div class="el-pagination__sizes"><select><option>3</option></select></div><div class="el-pager"><span class="active">1</span></div><span class="el-pagination__total">共 3 条</span></div>
      <script>localStorage.setItem('userPortalVerifyToken', ${JSON.stringify(token)}); fetch('${api}portal/yjhx/v3/queryList', {method:'POST',headers:{'Content-Type':'application/json',userPortalToken:${JSON.stringify(token)}},body:JSON.stringify({current:0,size:3})}).then(()=>window.fixtureReady=true);</script>`);
    return;
  }
  let body = ''; for await (const bytes of req) body += bytes;
  const params = body ? JSON.parse(body) : {};
  const givenToken = req.headers.userportaltoken || url.searchParams.get('userPortalToken');
  events.push({ path: url.pathname, uuid: params.uuid || null, session: givenToken === token ? (expired ? 'expired' : 'valid') : 'wrong' });
  if (expired || givenToken !== token) return reply(null, 401);
  if (url.pathname.endsWith('/queryList')) { assert.equal(params.current, 0); return reply({ list: rows, total: 3 }); }
  if (url.pathname.endsWith('/queryDtl')) {
    if (params.uuid === 'TEST-3' && token === 'fixture-old-session') {
      expirePending = () => { expired = true; reply(null, 401); };
      return;
    }
    const n = params.uuid.split('-').at(-1);
    return reply({ templateId: 'T', productJson: { sn1: 'R' + n + '-sn1', inv1: 'R' + n + '-inv1', sn2: n === '2' ? 'R2-sn2' : '', inv2: n === '2' ? 'R2-inv2' : '', proof: n === '3' ? 'R3-proof' : '' } });
  }
  if (url.pathname.includes('/queryTemplateInfo/')) return reply({ productJson: [{ its: fields }] });
  if (url.pathname.includes('/img/tradein/download/')) {
    const name = decodeURIComponent(url.pathname.split('/').at(-1)), bytes = png(name);
    servedImages.set(name, bytes); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(bytes); return;
  }
  res.writeHead(404); res.end();
});
function connect(endpoint) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint), pending = new Map(); let sequence = 0;
    ws.addEventListener('error', reject, { once: true });
    ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (!message.id) return; const item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); });
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); },
      close() { ws.close(); }
    }));
  });
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixture = 'http://127.0.0.1:' + server.address().port + '/#/auditOfTrade2026';
  console.log('Fixture ready; total is fixed at 3 orders.');
  const version = await (await fetch('http://127.0.0.1:' + cfg.port + '/json/version')).json();
  const cdp = await connect(version.webSocketDebuggerUrl);
  let result, diagnostic;
  try {
    const protocol = await (await fetch('http://127.0.0.1:' + cfg.port + '/json/protocol')).json();
    assert.ok(protocol.domains.some(d => d.domain === 'Extensions'), 'Chrome lacks unpacked-extension debugging');
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: cfg.extension });
    const extensionId = loaded.id;
    console.log('Loaded actual extension sources into isolated Chrome: ' + version.Browser);
    const { targetId: pageId } = await cdp.send('Target.createTarget', { url: fixture });
    const pageSession = (await cdp.send('Target.attachToTarget', { targetId: pageId, flatten: true })).sessionId;
    const openPopup = async () => {
      await cdp.send('Target.activateTarget', { targetId: pageId });
      const tab = (await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos.find(t => t.url === fixture);
      assert.ok(tab, 'Fixture tab target unavailable');
      await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
      const popup = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url === 'chrome-extension://' + extensionId + '/popup.html'), 'real extension popup');
      return (await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true })).sessionId;
    };
    let popupSession = await openPopup();
    const evaluate = async (session, expression) => {
      const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    };
    await until(() => evaluate(pageSession, 'Boolean(window.fixtureReady)'), 'initial fixture query');
    await until(() => evaluate(popupSession, 'typeof launch === "function"'), 'extension popup scripts');
    const state = async () => {
      const response = await evaluate(popupSession, 'chrome.runtime.sendMessage({type:"PIC_EXPERT_TASK_STATE"})');
      assert.equal(response.ok, true); return response.task;
    };
    diagnostic = async () => ({
      task: await state(),
      popup: await evaluate(popupSession, '({error:document.querySelector("#error").textContent,startDisabled:document.querySelector("#start").disabled,resumeDisabled:document.querySelector("#resume").disabled,resumeHidden:document.querySelector("#resume").hidden})'),
      downloads: await evaluate(popupSession, 'chrome.downloads.search({}).then(items=>items.map(x=>({filename:x.filename,state:x.state,error:x.error})))'),
      events
    });
    const previous = await state();
    if (previous && ['running', 'pausing', 'paused', 'stopping', 'finalizing'].includes(previous.status)) {
      await evaluate(popupSession, 'chrome.runtime.sendMessage({type:"PIC_EXPERT_TASK_STOP"})');
      await evaluate(popupSession, 'refresh()');
    }
    await until(() => evaluate(popupSession, '!document.querySelector("#start").disabled'), 'start button enabled');
    await evaluate(popupSession, 'document.querySelector("#start").click()');
    const before = await until(async () => { const t = await state(); return t?.completed === 2 && expirePending ? t : null; }, 'first two orders saved');
    assert.equal(before.total, 3); assert.equal(before.phase, 'processing'); assert.equal(before.scanned, 2);
    console.log('Two orders fully saved; releasing HTTP 401 for order 3.');
    expirePending();
    const paused = await until(async () => { const t = await state(); return t?.status === 'paused' ? t : null; }, 'automatic login-expiry pause');
    assert.deepEqual([paused.completed, paused.skipped, paused.failed, paused.currentRows.length], [2, 0, 1, 0]);
    assert.match(paused.error, /登录/); assert.equal(paused.manifestDownloadId, undefined);
    const history = (await evaluate(popupSession, 'chrome.downloads.search({})')).filter(item => item.filename.includes(paused.folderName));
    assert.equal(history.length, 6); assert.ok(history.every(item => item.state === 'complete' && item.exists));
    const taskDir = path.join(cfg.downloads, 'pic-expert', paused.folderName);
    assert.ok(fs.existsSync(taskDir)); assert.ok(!fs.existsSync(path.join(taskDir, 'TEST-R3')));
    const hashes = history.map(item => [item.filename, crypto.createHash('sha256').update(fs.readFileSync(item.filename)).digest('hex')]);
    console.log('Paused correctly: 2 completed, 1 incomplete; all 6 saved images remain.');
    expired = false; token = 'fixture-new-session';
    const beforeResume = events.length;
    await cdp.send('Page.reload', {}, pageSession);
    await until(() => evaluate(pageSession, 'window.fixtureReady && localStorage.getItem("userPortalVerifyToken") === "fixture-new-session"'), 'new login and page reload');
    popupSession = await openPopup();
    await until(() => evaluate(popupSession, 'typeof launch === "function"'), 'reopened popup scripts');
    await evaluate(popupSession, 'refresh()');
    await until(() => evaluate(popupSession, '!document.querySelector("#resume").hidden && !document.querySelector("#resume").disabled'), 'continuation button available');
    await evaluate(popupSession, 'document.querySelector("#resume").click()');
    const finished = await until(async () => { const t = await state(); return t?.status === 'completed' ? t : null; }, 'continuation completion');
    assert.deepEqual([finished.total, finished.scanned, finished.completed, finished.skipped, finished.failed], [3,3,3,0,0]);
    assert.equal(finished.id, paused.id); assert.equal(finished.folderName, paused.folderName);
    assert.deepEqual(events.slice(beforeResume).filter(e => e.path.endsWith('/queryDtl')).map(e => e.uuid), ['TEST-3']);
    for (const [filename, hash] of hashes) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), hash);
    const downloads = (await evaluate(popupSession, 'chrome.downloads.search({})')).filter(item => item.filename.includes(paused.folderName));
    assert.equal(downloads.length, 10); assert.ok(downloads.every(item => item.state === 'complete' && item.exists));
    const expected = [
      ['TEST-R1','SN码.png','R1-sn1'], ['TEST-R1','发票.png','R1-inv1'],
      ['TEST-R2','SN码-1.png','R2-sn1'], ['TEST-R2','SN码-2.png','R2-sn2'], ['TEST-R2','发票-1.png','R2-inv1'], ['TEST-R2','发票-2.png','R2-inv2'],
      ['TEST-R3','SN码.png','R3-sn1'], ['TEST-R3','发票.png','R3-inv1'], ['TEST-R3','证明材料图三.png','R3-proof']
    ];
    for (const [reference,name,source] of expected) assert.ok(fs.readFileSync(path.join(taskDir, reference, name)).equals(servedImages.get(source)), 'Wrong file bytes: ' + reference + '/' + name);
    const csv = fs.readFileSync(path.join(taskDir, '下载清单.csv'), 'utf8');
    assert.equal(csv, '\uFEFF订单号,参考号,处理结果,原因\r\nTEST-O1,TEST-R1,成功,\r\nTEST-O2,TEST-R2,成功,材料修改\r\nTEST-O3,TEST-R3,成功,');
    result = { outcome: 'passed', browser: version.Browser, scope: 'isolated localhost fixture; real Chrome extension APIs, IndexedDB, downloads and popup entry points; fixed 3 orders', paused: { completed: paused.completed, failed: paused.failed }, finished: { completed: finished.completed, failed: finished.failed }, files: expected.length, csv: 1, duplicateDownloads: 0, taskDir, extensionManifestDifference: 'localhost host permission only; runtime sources byte-identical', checks: ['automatic HTTP 401 pause', 'saved files survive', 'page reload and fresh login token', 'same task and folder', 'completed orders not read or downloaded again', 'all filenames and bytes match', 'numbered required images', 'optional proof image', 'material modification CSV note'] };
    fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const details = diagnostic ? await diagnostic().catch(e => ({ diagnosticError: e.message })) : { events };
    fs.writeFileSync(path.join(__dirname, 'failure.json'), JSON.stringify({ error: error.message, ...details }, null, 2));
    console.error(JSON.stringify({ error: error.message, ...details }, null, 2));
    throw error;
  } finally {
    await cdp.send('Browser.close').catch(() => {}); cdp.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.stack); server.closeAllConnections(); server.close(); process.exitCode = 1; });
