import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, Controller } from '../plugins/dragon-background/src/core.mjs';
const work = path.dirname(fileURLToPath(import.meta.url));
const temporary = await fs.mkdtemp(path.join(work, 'settings-storage-'));
const fixture = async () => {
  const store = new Store(await fs.mkdtemp(path.join(temporary, 'data-')));
  await store.write({ ...(await store.read()), enabled: false, transparency: 0, scale: 50 });
  return store;
};
const exit = child => new Promise((resolve, reject) => {
  let errors = '';
  child.stderr?.on('data', bytes => errors += bytes);
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error('Child exit ' + code + ': ' + errors)));
});
async function holdWithoutDeleteShare(file) {
  const command = "$f=[System.IO.File]::Open($env:DRAGON_LOCK_TEST_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite);try{[Console]::WriteLine('LOCKED');[Console]::ReadLine()|Out-Null}finally{$f.Dispose()}";
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, env: { ...process.env, DRAGON_LOCK_TEST_FILE: file }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const done = exit(child);
  await Promise.race([
    new Promise(resolve => child.stdout.once('data', bytes => { assert.match(String(bytes), /LOCKED/); resolve(); })),
    done.then(() => { throw new Error('Lock holder exited early.'); })
  ]);
  return async () => { child.stdin.end('\n'); await done; };
}

test('separate processes serialize read/modify/write without losing either setting', async () => {
  const store = await fixture();
  const children = ['transparency', 'scale', 'transparency', 'scale'].map(field => spawn(process.execPath,
    [path.join(work, 'settings-writer-fixture.mjs'), store.directory, field, '18'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }));
  await Promise.all(children.map(exit));
  const saved = await store.read();
  assert.equal(saved.transparency, 36);
  assert.equal(saved.scale, 86);
  assert.equal((await fs.readdir(store.directory)).some(file => file.endsWith('.tmp') || file.endsWith('.lock')), false);
});

test('controllers waiting on host status merge against the latest committed settings', async () => {
  const store = await fixture();
  const native = { status: async () => { await delay(60); return { debugReady: true }; }, remove: async () => {}, startAgent: async () => {} };
  await Promise.all([
    new Controller(new Store(store.directory), native).update({ transparency: 62 }),
    new Controller(new Store(store.directory), native).update({ scale: 71 })
  ]);
  assert.equal((await store.read()).transparency, 62);
  assert.equal((await store.read()).scale, 71);
});

test('a dead writer lock is reclaimed without deleting unrelated files', async () => {
  const store = await fixture(), lock = path.join(store.directory, '.settings-write.lock');
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, '2147483646-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.owner'), '');
  await store.patch({ transparency: 23 });
  assert.equal((await store.read()).transparency, 23);
});

test('Windows sharing violation is reproduced, retried, and saved after the reader releases', { skip: process.platform !== 'win32' }, async () => {
  const store = await fixture();
  const release = await holdWithoutDeleteShare(store.file);
  const probe = path.join(store.directory, 'probe.tmp');
  try {
    await fs.writeFile(probe, '{}');
    await assert.rejects(() => fs.rename(probe, store.file), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    const started = Date.now();
    const saving = store.patch({ transparency: 54, scale: 73 });
    await delay(650);
    await release();
    await saving;
    assert.ok(Date.now() - started >= 650);
    assert.equal((await store.read()).transparency, 54);
    assert.equal((await store.read()).scale, 73);
  } finally { await release(); await fs.unlink(probe).catch(() => {}); }
});

test('persistent Windows lock keeps the original configuration and cleans up temporary writes', { skip: process.platform !== 'win32' }, async () => {
  const store = await fixture(), before = await store.read();
  const release = await holdWithoutDeleteShare(store.file);
  try {
    await assert.rejects(() => store.patch({ transparency: 45, scale: 74 }), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    assert.deepEqual(await store.read(), before);
    assert.equal((await fs.readdir(store.directory)).some(file => file.endsWith('.tmp') || file.endsWith('.lock')), false);
  } finally { await release(); }
});

test('restart failure rolls back its own change while preserving a concurrent display edit', async () => {
  const store = await fixture();
  const controller = new Controller(store, {
    status: async () => ({ debugReady: false, mainCount: 1, portAvailable: true }),
    confirmRestart: async () => true,
    restart: async () => { await new Store(store.directory).patch({ transparency: 67 }); throw new Error('Restart fixture refused.'); }
  });
  await assert.rejects(() => controller.update({ enabled: true }), /fixture refused/);
  assert.equal((await store.read()).enabled, false);
  assert.equal((await store.read()).transparency, 67);
});
