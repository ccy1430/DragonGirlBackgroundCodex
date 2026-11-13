import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = process.env.DRAGON_RELEASE_ROOT || fileURLToPath(new URL('../plugins/dragon-background/', import.meta.url));
const json = async name => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));

test('release manifests contain consistent English identity, review cases, icons, and license scope', async () => {
  const manifest = await json('plugin.json'), legacy = await json('.codex-plugin/plugin.json');
  assert.equal(manifest.name, 'dragon-background');
  assert.equal(manifest.version, '0.3.2');
  assert.equal(legacy.version, manifest.version);
  const overlay = manifest.extensions['com.openai'];
  assert.equal(overlay.requires_local_executor, true);
  assert.equal(overlay.interface.displayName, 'DragonGirlBackground');
  assert.deepEqual(overlay.interface, legacy.interface);
  assert.ok(overlay.interface.displayName.length <= 30);
  assert.ok(overlay.interface.shortDescription.length <= 30);
  assert.ok(overlay.interface.longDescription.length <= 4000);
  assert.match(overlay.interface.longDescription, /ZipZipPipe.*non-commercial/s);
  assert.equal(overlay.review.test_cases.positive.length, 5);
  assert.equal(overlay.review.test_cases.negative.length, 3);
  assert.equal(overlay.review.demo_recording_url, undefined, 'Do not invent a reviewer video URL.');
  assert.match(manifest.license, /LicenseRef-Dragon-Artwork-NonCommercial/);
  for (const field of ['logo', 'composerIcon']) {
    const icon = overlay.interface[field];
    assert.match(icon, /^\.\/assets\//);
    const svg = await fs.readFile(path.join(root, icon), 'utf8');
    assert.match(svg, /viewBox="0 0 512 512"/);
    assert.doesNotMatch(svg, /\b(?:href|src)=["']https?:\/\//);
  }
});

test('credits identify the bundled asset, artist, source URLs, and separate non-commercial terms', async () => {
  const credits = await json('assets/credits.json');
  assert.equal(credits.originalArtist, 'ZipZipPipe');
  assert.equal(credits.standardUpstreamLicense, null);
  assert.ok(credits.sources.some(source => source.url === 'https://www.pixiv.net/artworks/148186519'));
  const image = await fs.readFile(path.join(root, credits.asset));
  assert.equal(image.readUInt32BE(16), 930); assert.equal(image.readUInt32BE(20), 1691); assert.equal(image[25], 6);
  const hash = crypto.createHash('sha256').update(image).digest('hex');
  assert.equal(credits.assetSha256, hash);
  assert.match(credits.usage, /Non-commercial use only/);
  assert.match(credits.noticeURL, /\/README\.md$/);
  assert.equal(credits.softwareLicense.identifier, 'MIT');
  assert.match(credits.softwareLicense.text, /Permission is hereby granted, free of charge/);
  assert.ok(credits.softwareLicense.excludes.includes('character artwork'));
});

test('the runtime package has no personal paths, private runtime dependency, or bundled profiles', async () => {
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      assert.doesNotMatch(entry.name, /^(?:settings\.json|display\.json|profile|node_modules|\.env|agent\.lock)$/i);
      if (entry.isDirectory()) await visit(file);
      else if (/\.(?:json|mjs|ps1|cmd|txt|md)$/.test(entry.name)) {
        const text = await fs.readFile(file, 'utf8');
        assert.doesNotMatch(text, /[A-Z]:[\\/]+Users[\\/]+(?!TestUser[\\/])[^\\/\r\n"']+[\\/]/i, file);
        assert.doesNotMatch(text, /\.easy-ai/i, file);
      }
    }
  }
  await visit(root);
});

async function launch(env, requests) {
  const definition = (await json('.mcp.json')).mcpServers.dragon_background;
  const cmd = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/cmd.exe');
  const child = spawn(cmd, definition.args, { cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  const timeout = setTimeout(() => child.kill(), 15000);
  child.stdin.end(requests.map(request => JSON.stringify(request)).join('\n') + '\n');
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timeout); }
}

test('a clean declared launcher exposes credits over MCP with an explicit Node runtime and empty PATH', { skip: process.platform !== 'win32' }, async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'dragon-release-'));
  const result = await launch({ PATH: '', DRAGON_BACKGROUND_NODE: process.execPath, DRAGON_BACKGROUND_DATA: data }, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'artwork_info', arguments: {} } }
  ]);
  assert.equal(result.code, 0, result.stderr);
  const messages = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(messages[0].result.serverInfo.title, 'DragonGirlBackground');
  assert.equal(messages[0].result.serverInfo.version, '0.3.2');
  const creditsTool = messages[1].result.tools.find(tool => tool.name === 'artwork_info');
  assert.equal(creditsTool.annotations.readOnlyHint, true);
  assert.equal(messages[1].result.tools.find(tool => tool.name === 'settings.update').annotations.destructiveHint, true);
  assert.equal(messages[2].result.structuredContent.originalArtist, 'ZipZipPipe');
  assert.match(messages[2].result.content[0].text, /Non-commercial use only/);
  assert.deepEqual(await fs.readdir(data), [], 'Reading credits must not save settings or start a background worker.');
});

test('missing Node returns a clear prerequisite error and no protocol garbage', { skip: process.platform !== 'win32' }, async () => {
  const result = await launch({ PATH: '', DRAGON_BACKGROUND_NODE: '' }, []);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /requires Node\.js 24 or newer/);
});
