import readline from 'node:readline';
import { Controller, Store, settingProperties } from './core.mjs';
import { native } from './native.mjs';
import { artworkInfo } from './artwork.mjs';

const controller = new Controller(new Store(), native);
const readSchema = { type: 'object', properties: { schema: { type: 'object' }, values: { type: 'object' }, layout: { type: 'array', items: { type: 'object' } } }, required: ['schema', 'values'] };
const valueSchema = { type: 'object', properties: { values: { type: 'object' }, message: { type: 'string' } }, required: ['values'] };
const tools = [
  { name: 'settings.read', title: '读取背景设置', description: '读取原生背景设置；普通启动时开关显示为关闭。', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: readSchema, annotations: { readOnlyHint: true } },
  { name: 'settings.update', title: '修改背景设置', description: '保存背景开关、图片和显示选项。普通启动下开启可能关闭并重启当前 Codex；会先显示本机确认框，拒绝则不重启。', inputSchema: { type: 'object', properties: { set: { type: 'object', properties: Object.fromEntries(Object.entries(settingProperties).map(([k,v]) => [k, { ...v, title: undefined, description: undefined }])), minProperties: 1, additionalProperties: false } }, required: ['set'], additionalProperties: false }, outputSchema: valueSchema, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'choose_image', title: '选择本地图片…', description: '打开本机文件选择框，支持 PNG、JPEG 和静态 WebP；文件不上传。', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: valueSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'background_status', title: '查看背景运行状态', description: '检查是否为调试启动以及保存的开关记录。', inputSchema: { type: 'object', additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'artwork_info', title: 'Artwork credits & license', description: '查看原作者 ZipZipPipe、参考来源、AI 改编记录，以及署名和非商业使用要求。Read artwork attribution, sources, and non-commercial terms.', inputSchema: { type: 'object', additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } }
];
const settingsCapability = { readTool: 'settings.read', updateTool: 'settings.update' };
const capabilities = { tools: {}, experimental: { 'openai/settings': settingsCapability } };
const serverInfo = { name: 'dragon-background', title: 'DragonGirlBackground', version: '0.3.2' };
const send = result => process.stdout.write(JSON.stringify(result) + '\n');
const toolResult = data => ({ content: [{ type: 'text', text: data.message || JSON.stringify(data) }], structuredContent: data });
let queue = Promise.resolve();

async function handle(message) {
  const { id, method, params = {} } = message;
  if (id === undefined) {
    if (method === 'notifications/initialized') {
      // Restoring an already-confirmed preference never launches or restarts Codex.
      const state = await controller.status();
      if (state.debugReady && state.preferredEnabled) await native.startAgent(state);
    }
    return;
  }
  let result;
  if (method === 'initialize') result = { protocolVersion: params.protocolVersion || '2025-11-25', serverInfo, capabilities };
  else if (method === 'server/discover') result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, extensions: { 'openai/settings': settingsCapability } }, _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo }, ttlMs: 0, cacheScope: 'private' };
  else if (method === 'ping') result = {};
  else if (method === 'tools/list') result = { tools };
  else if (method === 'resources/list' || method === 'prompts/list') result = { [method.startsWith('resources') ? 'resources' : 'prompts']: [] };
  else if (method === 'tools/call') {
    try {
      if (params.name === 'settings.read') result = toolResult(await controller.read());
      else if (params.name === 'settings.update') result = toolResult(await controller.update(params.arguments?.set));
      else if (params.name === 'choose_image') result = toolResult(await controller.chooseImage());
      else if (params.name === 'background_status') result = toolResult(await controller.status());
      else if (params.name === 'artwork_info') result = toolResult(await artworkInfo());
      else throw new Error('未知工具。');
    } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
  } else return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  send({ jsonrpc: '2.0', id, result });
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  queue = queue.then(() => handle(message)).catch(error => {
    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } });
    else process.stderr.write(error.message + '\n');
  });
});
input.on('close', () => { queue.finally(() => process.exit(0)); });
