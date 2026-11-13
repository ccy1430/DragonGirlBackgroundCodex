import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, DATA, PORT, loadImage } from './core.mjs';
import { applyBackgrounds, removeBackgrounds } from './renderer.mjs';

const args = process.argv.slice(2);
let mainPid, directory = DATA, port = PORT;
while (args.length) {
  const key = args.shift(), value = args.shift();
  if (key === '--main-pid') mainPid = Number(value);
  else if (key === '--data') directory = path.resolve(value);
  else if (key === '--port') port = Number(value);
  else throw new Error('未知后台参数。');
}
if (!Number.isInteger(mainPid) || mainPid <= 0) throw new Error('需要明确的 Codex 进程身份。');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('无效的本机端口。');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
await fs.mkdir(directory, { recursive: true });
const lockPath = path.join(directory, 'agent.lock');
const token = crypto.randomUUID();
let owned = false;
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    const file = await fs.open(lockPath, 'wx');
    await file.writeFile(JSON.stringify({ pid: process.pid, mainPid, token }));
    await file.close(); owned = true; break;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let old;
    try { old = JSON.parse(await fs.readFile(lockPath, 'utf8')); } catch { process.exit(0); }
    if (alive(old.pid)) process.exit(0);
    // Only this fixed plugin lock file is eligible for stale-lock cleanup.
    await fs.unlink(lockPath);
  }
}
if (!owned) process.exit(0);
const store = new Store(directory);
let stopping = false, wake;
let cachedImage = null;
const watcher = (await import('node:fs')).watch(directory, (_event, file) => { if (file === 'settings.json' || file === 'display.json') wake?.(); });
const wait = () => new Promise(resolve => {
  let done = false;
  const finish = () => { if (done) return; done = true; clearTimeout(timer); wake = undefined; resolve(); };
  const timer = setTimeout(finish, 2500);
  wake = finish;
});
process.on('SIGTERM', () => { stopping = true; wake?.(); });
process.on('SIGINT', () => { stopping = true; wake?.(); });
try {
  while (!stopping && alive(mainPid)) {
    const values = await store.read();
    if (!values.enabled) { await removeBackgrounds(port).catch(() => {}); break; }
    try {
      const stat = await fs.stat(values.imagePath);
      const stamp = `${path.resolve(values.imagePath)}:${stat.size}:${stat.mtimeMs}`;
      if (cachedImage?.stamp !== stamp) cachedImage = await loadImage(values.imagePath);
      await applyBackgrounds(port, values, cachedImage);
    } catch (error) {
      await fs.writeFile(path.join(directory, 'last-error.txt'), error.message);
    }
    await wait();
  }
} finally {
  watcher.close();
  if (stopping && alive(mainPid)) await removeBackgrounds(port).catch(() => {});
  try { const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')); if (lock.token === token) await fs.unlink(lockPath); } catch {}
}
