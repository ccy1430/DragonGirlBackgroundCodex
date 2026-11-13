import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const sharingErrors = new Set(['EPERM', 'EACCES', 'EBUSY']);

// Windows readers and security scanners can briefly prevent replacement.
// Keep the original file intact and retry; never unlink it as a workaround.
export async function retrySharing(action, timeout = 4000) {
  const deadline = Date.now() + timeout;
  let backoff = 20;
  for (;;) {
    try { return await action(); }
    catch (error) {
      if (!sharingErrors.has(error.code) || Date.now() >= deadline) throw error;
      await delay(Math.min(backoff, Math.max(1, deadline - Date.now())));
      backoff = Math.min(200, backoff * 2);
    }
  }
}

export async function atomicJson(file, value) {
  const contents = JSON.stringify(value, null, 2);
  try { if (await retrySharing(() => fs.readFile(file, 'utf8')) === contents) return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    await retrySharing(() => fs.writeFile(temporary, contents, { mode: 0o600 }));
    await retrySharing(() => fs.rename(temporary, file));
  } finally {
    await retrySharing(() => fs.unlink(temporary)).catch(error => {
      if (error.code !== 'ENOENT') process.stderr.write('背景临时文件清理失败：' + error.message + '\n');
    });
  }
}

const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};

async function clearDeadLock(directory) {
  let entries;
  try { entries = await fs.readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!entries.length) {
    // A process may have just made the directory but not written its owner yet.
    const stat = await fs.stat(directory).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > 30000) await fs.rmdir(directory).catch(() => {});
    return;
  }
  if (entries.length !== 1) return;
  const owner = entries[0], match = /^(\d+)-[a-f0-9-]+\.owner$/.exec(owner);
  if (!match || alive(Number(match[1]))) return;
  try {
    // Remove this exact dead owner's marker, then the empty directory.
    // Competing cleaners cannot remove a new owner's nonempty lock.
    await fs.unlink(path.join(directory, owner));
    await fs.rmdir(directory);
  } catch (error) { if (!['ENOENT', 'ENOTEMPTY', ...sharingErrors].includes(error.code)) throw error; }
}

export async function withSettingsLock(directory, action) {
  await fs.mkdir(directory, { recursive: true });
  const lock = path.join(directory, '.settings-write.lock');
  const owner = path.join(lock, `${process.pid}-${crypto.randomUUID()}.owner`);
  const deadline = Date.now() + 12000;
  for (;;) {
    try { await fs.mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST' && !sharingErrors.has(error.code)) throw error;
      if (Date.now() >= deadline) throw new Error('背景设置正被另一连接保存，请稍后重试。');
      await clearDeadLock(lock);
      await delay(25 + Math.floor(Math.random() * 25));
    }
  }
  try {
    await retrySharing(() => fs.writeFile(owner, '', { flag: 'wx', mode: 0o600 }));
    return await action();
  } finally {
    await retrySharing(() => fs.unlink(owner)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await retrySharing(() => fs.rmdir(lock));
  }
}
