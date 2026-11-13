import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, retrySharing, withSettingsLock } from './storage.mjs';
import defaultSettings from '../assets/default-settings.json' with { type: 'json' };

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_IMAGE = path.join(ROOT, 'assets', 'background.png');
export const DATA = process.env.DRAGON_BACKGROUND_DATA || path.join(process.env.LOCALAPPDATA || process.env.TEMP, 'CodexDragonBackground');
export const PORT = 9236;
export const defaults = () => ({ ...defaultSettings, imagePath: DEFAULT_IMAGE });
export const settingProperties = {
  enabled: { type: 'boolean', title: '开启背景', description: '普通启动时显示关闭；开启会先询问是否重启。' },
  imagePath: { type: 'string', title: '背景图片', description: '本机 PNG、JPEG 或静态 WebP；也可点击下方按钮选择。' },
  transparency: { type: 'integer', title: '图片透明度（%）', minimum: 0, maximum: 100 },
  scale: { type: 'integer', title: '图片缩放（%）', description: '100% 按填充方式显示；调小可缩小人物。', minimum: 25, maximum: 200 },
  fit: { type: 'string', title: '填充方式', enum: ['铺满', '完整显示', '拉伸'] },
  position: { type: 'string', title: '图片位置', enum: ['居中', '靠上', '靠下', '靠左', '靠右'] }
};

export class Store {
  constructor(directory = DATA) { this.directory = directory; this.file = path.join(directory, 'settings.json'); this.displayFile = path.join(directory, 'display.json'); }
  async read() {
    try {
      const value = JSON.parse(await retrySharing(() => fs.readFile(this.file, 'utf8')));
      let display = {};
      try { display = JSON.parse(await retrySharing(() => fs.readFile(this.displayFile, 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // A version update moves the packaged asset; preserve custom image paths.
      if (typeof value.imagePath === 'string' && /[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/]dragon-background[\\/][^\\/]+[\\/]assets[\\/]background\.png$/i.test(path.normalize(value.imagePath))) value.imagePath = DEFAULT_IMAGE;
      return validatePatch({ ...defaults(), ...value, ...display });
    } catch (error) {
      if (error.code === 'ENOENT') return defaults();
      throw new Error('背景设置文件无法读取：' + error.message);
    }
  }
  async write(values) {
    const validated = validatePatch(values);
    return withSettingsLock(this.directory, () => this.writeUnlocked(validated));
  }
  async mutate(change) {
    return withSettingsLock(this.directory, async () => {
      const before = await this.read();
      const values = validatePatch(await change(before));
      await this.writeUnlocked(values);
      return { before, values };
    });
  }
  async patch(patch) {
    const validated = validatePatch(patch);
    return this.mutate(current => ({ ...current, ...validated }));
  }
  async writeUnlocked(validated) {
    // Older live plugin connections continue reading only the original fields.
    // Keep display additions separate so their strict parser remains compatible.
    const { scale = 100, ...legacy } = validated;
    let previousDisplay;
    try { previousDisplay = JSON.parse(await retrySharing(() => fs.readFile(this.displayFile, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await atomicJson(this.displayFile, { scale });
    try { await atomicJson(this.file, legacy); }
    catch (error) {
      if (previousDisplay === undefined) await retrySharing(() => fs.unlink(this.displayFile));
      else await atomicJson(this.displayFile, previousDisplay);
      throw error;
    }
  }
}

export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置必须为对象。');
  const copy = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(settingProperties, key)) throw new Error('未知设置：' + key);
    if (key === 'enabled' && typeof value !== 'boolean') throw new Error('开启状态必须为布尔值。');
    if (key === 'imagePath' && (typeof value !== 'string' || !value.trim())) throw new Error('请选择本地图片。');
    if (key === 'transparency' && (!Number.isInteger(value) || value < 0 || value > 100)) throw new Error('透明度范围为 0–100。');
    if (key === 'scale' && (!Number.isInteger(value) || value < 25 || value > 200)) throw new Error('缩放范围为 25–200。');
    if (settingProperties[key].enum && !settingProperties[key].enum.includes(value)) throw new Error('设置值不受支持：' + key);
    copy[key] = value;
  }
  return copy;
}

export async function loadImage(imagePath) {
  if (/^(?:https?:|data:|file:|\\\\)/i.test(imagePath)) throw new Error('只接受本地文件，不读取网络图片。');
  const actual = path.resolve(imagePath);
  const stat = await fs.stat(actual);
  if (!stat.isFile() || stat.size > 10 * 1024 * 1024 || stat.size < 12) throw new Error('图片必须是 10 MiB 以内的本地文件。');
  const bytes = await fs.readFile(actual);
  let mime;
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.toString('ascii', 12, 16) === 'VP8X' && (bytes[20] & 2)) throw new Error('请使用静态 WebP 图片。');
    mime = 'image/webp';
  } else throw new Error('请选择 PNG、JPEG 或静态 WebP 图片。');
  let width, height;
  if (mime === 'image/png' && bytes.length >= 24) {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) continue;
      let marker = bytes[offset++];
      while (marker === 255 && offset < bytes.length) marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else if (mime === 'image/webp' && bytes.length >= 30) {
    const format = bytes.toString('ascii', 12, 16);
    if (format === 'VP8X') { width = 1 + bytes.readUIntLE(24,3); height = 1 + bytes.readUIntLE(27,3); }
    else if (format === 'VP8 ' && bytes.subarray(23,26).toString('hex') === '9d012a') { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383; }
    else if (format === 'VP8L' && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = 1 + (bits & 16383); height = 1 + ((bits >>> 14) & 16383); }
  }
  if (!width || !height || width > 16384 || height > 16384 || width * height > 50000000) throw new Error('图片尺寸无效或过大（最长边 16384，总像素 5000 万以内）。');
  return { path: actual, bytes, mime, width, height, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, stamp: `${actual}:${stat.size}:${stat.mtimeMs}` };
}

export class Controller {
  constructor(store, native) { this.store = store; this.native = native; }
  values(saved, host) { return { ...saved, enabled: Boolean(host.debugReady && saved.enabled) }; }
  async read() {
    const [saved, host] = await Promise.all([this.store.read(), this.native.status()]);
    return {
      schema: { type: 'object', properties: settingProperties, required: Object.keys(settingProperties) },
      values: this.values(saved, host),
      layout: [{ kind: 'group', title: '背景图片', items: [
        { kind: 'property', property: 'enabled' },
        { kind: 'tool', tool: 'choose_image', description: '从本机选择一张图片，不上传。' },
        { kind: 'property', property: 'imagePath' },
        { kind: 'property', property: 'transparency' },
        { kind: 'property', property: 'scale' },
        { kind: 'property', property: 'fit' },
        { kind: 'property', property: 'position' },
        { kind: 'tool', tool: 'background_status' }
      ] }, { kind: 'group', title: 'Artwork / 署名与许可', items: [
        { kind: 'tool', tool: 'artwork_info', description: 'Original character: ZipZipPipe. Non-commercial use only. 原作者署名、来源及非商用说明。' }
      ] }]
    };
  }
  async update(patch) {
    patch = validatePatch(patch);
    const saved = await this.store.read();
    let next = { ...saved, ...patch };
    if (patch.imagePath !== undefined || patch.enabled === true) await loadImage(next.imagePath);
    const host = await this.native.status();
    if (patch.enabled === true && !host.debugReady) {
      if (host.mainCount !== 1) throw new Error('需要且只允许一个已打开的 Codex 实例。请先关闭其他实例。');
      if (!host.portAvailable) throw new Error('本机背景端口被其他程序占用；未重启或另开应用。');
      if (!await this.native.confirmRestart()) return { values: this.values(saved, host), message: '已取消重启，背景保持关闭，上次保存的选择未改变。' };
      const commit = await this.store.patch(patch);
      next = commit.values;
      try { await this.native.restart(host); }
      catch (error) {
        // Undo our fields without erasing another connection's later edits.
        await this.store.mutate(current => {
          const restored = { ...current };
          for (const key of Object.keys(patch)) if (current[key] === next[key]) restored[key] = commit.before[key];
          return restored;
        });
        throw error;
      }
      return { values: { ...next, enabled: false }, message: '已确认重启，将关闭原实例后启动一个带背景的实例。' };
    }
    next = (await this.store.patch(patch)).values;
    if (!next.enabled) await this.native.remove(host);
    else if (host.debugReady) await this.native.startAgent(host);
    return { values: this.values(next, host), message: next.enabled && !host.debugReady ? '选择已保存；当前普通启动，背景仍为关闭。' : '背景设置已保存。' };
  }
  async chooseImage() {
    const selected = await this.native.pickImage();
    if (!selected) return { values: (await this.read()).values, message: '未更换图片。' };
    return this.update({ imagePath: selected });
  }
  async status() {
    const [saved, host] = await Promise.all([this.store.read(), this.native.status()]);
    return { ...host, preferredEnabled: saved.enabled, effectiveEnabled: Boolean(host.debugReady && saved.enabled), imagePath: saved.imagePath };
  }
}
