const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = '/Users/carrot/Downloads/pic-expert';
const prefix = process.argv[2];
if (!/^\d{8}-\d{8}_$/.test(prefix || '')) throw new Error('必须指定本次交易日期目录前缀。');
const previous = new Set(fs.readdirSync(root));
const deadline = Date.now() + 300000;
const timer = setInterval(() => {
  try {
    const folder = fs.readdirSync(root).find(name => !previous.has(name) && name.startsWith(prefix));
    if (!folder) return;
    const dir = path.join(root, folder);
    if (fs.existsSync(path.join(dir, '下载清单.csv'))) throw new Error('任务已结束，未刷新。');
    const files = [];
    let complete = false;
    for (const ref of fs.readdirSync(dir)) {
      const sub = path.join(dir, ref);
      if (!fs.statSync(sub).isDirectory()) continue;
      const names = fs.readdirSync(sub).filter(name => /\.(jpg|png|webp|gif|bmp)$/.test(name));
      if (names.some(n => /^SN码\./.test(n)) && names.some(n => /^发票\./.test(n))) complete = true;
      for (const name of names) {
        const file = path.join(sub, name);
        files.push({ file, hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
      }
    }
    if (!complete) return;
    clearInterval(timer);
    const evidence = { folder, dir, beforeRefresh: new Date().toISOString(), files };
    fs.writeFileSync(path.join(__dirname, 'refresh-before-' + prefix.slice(0, -1) + '.json'), JSON.stringify(evidence, null, 2));
    execFileSync('osascript', ['-e', 'tell application "Google Chrome" to reload tab 1 of front window']);
    console.log(JSON.stringify({ refreshed: true, folder, savedImages: files.length }));
  } catch (error) {
    clearInterval(timer); console.error(error.message); process.exitCode = 1;
  }
}, 50);
const timeout = setTimeout(() => { clearInterval(timer); console.error('等待新任务超时，未刷新。'); process.exitCode = 1; }, deadline - Date.now());
timeout.unref();
console.log('已准备：只监测新任务，首笔图片保存完整后刷新一次。');
