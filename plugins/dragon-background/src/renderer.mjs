import crypto from 'node:crypto';
import { Cdp } from './cdp.mjs';
import { installWallpaper } from './wallpaper-runtime.mjs';

export async function nativePages(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  if (!response.ok) throw new Error('本机调试连接不可用。');
  const targets = await response.json();
  return targets.filter(t => t.type === 'page' && /^app:\/\/-\/index\.html(?:[?#]|$)/.test(t.url || '') && t.webSocketDebuggerUrl);
}

export async function removeBackgrounds(port) {
  for (const page of await nativePages(port)) {
    const client = await Cdp.connect(page.webSocketDebuggerUrl);
    try { await client.evaluate('window.__codexDragonBackgroundV2?.remove()'); }
    finally { client.close(); }
  }
}

export async function applyBackgrounds(port, values, image) {
  const signature = crypto.createHash('sha256').update(JSON.stringify([image.stamp, values.transparency, values.fit, values.position, values.scale ?? 100])).digest('hex');
  const options = {
    image: image.dataUrl, opacity: 1 - values.transparency / 100, scale: values.scale ?? 100,
    fit: { '铺满': 'cover', '完整显示': 'contain', '拉伸': '100% 100%' }[values.fit],
    position: { '居中': 'center center', '靠上': 'center top', '靠下': 'center bottom', '靠左': 'left center', '靠右': 'right center' }[values.position]
  };
  const expression = `(${installWallpaper.toString()})(${JSON.stringify(options)}).then(state=>{window.__codexDragonBackgroundV2.signature=${JSON.stringify(signature)};return state;})`;
  const results = [];
  for (const page of await nativePages(port)) {
    const client = await Cdp.connect(page.webSocketDebuggerUrl);
    try {
      const previous = await client.evaluate(`({visible:document.visibilityState==='visible',signature:window.__codexDragonBackgroundV2?.signature,installed:window.__codexDragonBackgroundV2?.status().installed})`);
      // A decoded runtime waiting on a chat route already observes DOM changes.
      // Do not resend and decode the image every poll while settings is open.
      if (!previous.visible || previous.signature === signature) continue;
      results.push(await client.evaluate(expression));
    } finally { client.close(); }
  }
  return results;
}
