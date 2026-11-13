import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { ROOT, DATA, PORT } from './core.mjs';
import { removeBackgrounds } from './renderer.mjs';

export const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const run = (action, extra = []) => new Promise((resolve, reject) => {
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-STA', '-File', path.join(ROOT, 'scripts/native.ps1'), '-Action', action, '-Port', String(PORT), ...extra], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', x => { out += x; });
  child.stderr.on('data', x => { err += x; });
  child.on('error', reject);
  child.on('exit', code => {
    if (code !== 0) return reject(new Error(err.trim() || `本机操作失败：${action}`));
    try { resolve(JSON.parse(out.replace(/^\uFEFF/, '').trim())); } catch { reject(new Error('本机操作没有返回有效结果。')); }
  });
});

export const native = {
  async status() {
    const host = await run('Status');
    try { host.restart = JSON.parse(await fs.readFile(path.join(DATA, 'restart-state.json'), 'utf8')); } catch {}
    return host;
  },
  confirmRestart: async () => (await run('Confirm')).accepted,
  pickImage: async () => (await run('Pick')).path || null,
  async restart(host, { probe = false } = {}) {
    const directory = path.join(DATA, 'requests');
    await fs.mkdir(directory, { recursive: true });
    const id = crypto.randomUUID();
    const requestPath = path.join(directory, id + '.json');
    const statusPath = path.join(directory, id + '.status.json');
    const commitPath = path.join(directory, id + '.commit');
    const request = { id, statusPath, commitPath, mainPid: host.mainPid, startTicks: String(host.startTicks), nodePath: process.execPath, pluginRoot: ROOT, dataDirectory: DATA, port: PORT, mode: probe ? 'probe' : 'restart' };
    await fs.writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
    // WinPS 5.1 silently exits without running a script under detached:true.
    // Local WMI starts a hidden helper outside Codex's kill-on-close Job Object.
    const child = spawn(powershell, ['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(ROOT,'scripts/launch-restart.ps1'),'-RequestPath',requestPath], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    if (code !== 0) throw new Error(stderr.trim() || '重启助手启动失败，应用未关闭。');
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      let state;
      try { state = JSON.parse(await fs.readFile(statusPath, 'utf8')); } catch {}
      if (state?.phase === 'failed') throw new Error(state.message);
      if (probe && state?.phase === 'probe-ok') return state;
      if (!probe && state?.phase === 'ready') {
        await fs.writeFile(commitPath, id, { flag: 'wx', mode: 0o600 });
        return state;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('未收到重启助手就绪回执，应用未关闭；请查看背景运行状态。');
  },
  async startAgent(host) {
    if (!host.debugReady || host.mainCount !== 1) return;
    await fs.mkdir(DATA, { recursive: true });
    try {
      const lock = JSON.parse(await fs.readFile(path.join(DATA, 'agent.lock'), 'utf8'));
      if (lock.mainPid === host.mainPid) {
        try { process.kill(lock.pid, 0); return; } catch (error) { if (error.code === 'EPERM') return; }
      }
    } catch {}
    const log = await fs.open(path.join(DATA, 'agent.log'), 'a');
    try {
      const child = spawn(process.execPath, [path.join(ROOT, 'src/agent.mjs'), '--main-pid', String(host.mainPid), '--data', DATA], { windowsHide: true, detached: true, stdio: ['ignore', log.fd, log.fd] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } finally { await log.close(); }
  },
  async remove(host) { if (host.debugReady) await removeBackgrounds(PORT); }
};
