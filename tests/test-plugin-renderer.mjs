import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { Cdp } from '../plugins/dragon-background/src/cdp.mjs';
import { installWallpaper } from '../plugins/dragon-background/src/wallpaper-runtime.mjs';
import { applyBackgrounds } from '../plugins/dragon-background/src/renderer.mjs';
const wallpaperExpression=(image,scale=100)=>'('+installWallpaper.toString()+')('+JSON.stringify({image,opacity:0.72,fit:'contain',position:'right center',scale})+')';

const work = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const profile = path.join(work, 'background-browser-test-' + Date.now());
await fs.mkdir(profile, { recursive: true });
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--hide-scrollbars', '--window-size=1440,900', 'about:blank'
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let launchError = null;
edge.on('error', error => { launchError = error; });
let errors = '';
edge.stderr.on('data', bytes => { errors = (errors + bytes.toString()).slice(-2000); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let connection, browser, descriptorServer, stage = 'launch';
try {
  let portInfo;
  for (let i = 0; i < 60; i++) {
    if (launchError) throw launchError;
    try { portInfo = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); break; } catch {}
    await sleep(200);
  }
  if (!portInfo) throw new Error('Headless browser did not start: ' + errors);
  stage = 'connect';
  const [port, browserPath] = portInfo.trim().split(/\r?\n/);
  browser = await Cdp.connect('ws://127.0.0.1:' + port + browserPath);
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = targets.find(x => x.type === 'page');
  connection = await Cdp.connect(page.webSocketDebuggerUrl);
  stage = 'fixture';
  await connection.call('Page.enable');
  const { frameTree } = await connection.call('Page.getFrameTree');
  await connection.call('Page.setDocumentContent', { frameId: frameTree.frame.id, html: `<!doctype html>
    <html><head><style>
      * {box-sizing:border-box} html,body {margin:0;height:100%;background:#181818;color:#eee;font:16px Arial}
      .layout {display:flex;width:100vw;height:100vh} aside {width:200px;padding:25px;background:#101010}
      main {flex:1;height:100vh;display:flex} .structure {width:60%;height:100%;background:#181818;padding:35px;position:relative}
      aside.preview {width:40%;height:100%;background:#121212;padding:20px}
      .message {padding:15px;background:#252525;width:300px;border-radius:12px}
      .messaging-root,.thread-pane {height:100%;background:#181818}
      textarea {position:absolute;bottom:30px;left:35px;width:70%;height:70px;background:#242424;color:white;border:1px solid #555;border-radius:8px;caret-color:transparent;outline:none}
    </style></head><body><div class="layout"><aside>Native sidebar</aside><main><div style="display:contents"><div class="structure"><div class="messaging-root"><div class="thread-pane"><article><div class="message">Native message — unchanged</div></article></div></div><textarea aria-label="Composer"></textarea></div><aside class="preview">Native image preview</aside></div></main></div>
    <script>window.composerClicks=0;document.querySelector('textarea').addEventListener('click',()=>window.composerClicks++);</script>
    </body></html>` });
  const shot = async () => Buffer.from((await connection.call('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  const before = await shot();
  const colorsBefore = await connection.evaluate("['aside','.message','textarea'].map(s=>getComputedStyle(document.querySelector(s)).backgroundColor)");
  const picture = await fs.readFile(path.join(work, '../plugins/dragon-background/assets/background.png'));
  const expression = wallpaperExpression('data:image/png;base64,' + picture.toString('base64'));
  stage = 'apply';
  const result = await connection.evaluate(expression);
  assert.equal(result.installed, true);
  assert.equal(result.pointerEvents, 'none');
  assert(result.renderedImageWidth<=result.width+1&&result.renderedImageHeight<=result.height+1,'Contain must keep the complete image inside the chat pane.');
  assert.equal(await connection.evaluate("getComputedStyle(document.getElementById('codex-dragon-wallpaper-v2')).backgroundPosition"),'100% 50%');
  assert(result.width > 500 && result.height > 400);
  assert(result.adjustedStructuralBackgrounds > 0);
  assert.deepEqual(await connection.evaluate("[...document.querySelectorAll('.structure')].map(x=>getComputedStyle(x).backgroundColor)"),['rgba(0, 0, 0, 0)']);
  assert.deepEqual(await connection.evaluate("[...document.querySelectorAll('.messaging-root,.thread-pane')].map(x=>getComputedStyle(x).backgroundColor)"),['rgba(0, 0, 0, 0)','rgba(0, 0, 0, 0)']);
  assert.equal(await connection.evaluate("getComputedStyle(document.querySelector('aside.preview')).backgroundColor"),'rgb(18, 18, 18)');
  assert.equal(await connection.evaluate("(()=>{const h=document.querySelector('#codex-dragon-wallpaper-v2').getBoundingClientRect(),p=document.querySelector('aside.preview').getBoundingClientRect();return h.right<=p.left+1})()"),true,'Wallpaper must not extend underneath the preview pane.');
  stage='preview pane resize';
  await connection.evaluate("document.querySelector('.structure').style.width='40%';document.querySelector('aside.preview').style.width='60%'");
  await sleep(450);
  assert.equal(await connection.evaluate("(()=>{const h=document.querySelector('#codex-dragon-wallpaper-v2').getBoundingClientRect(),p=document.querySelector('aside.preview').getBoundingClientRect();return h.right<=p.left+1&&Math.abs(h.width-document.querySelector('.structure').getBoundingClientRect().width)<2})()"),true);
  const unscaled=await connection.evaluate('window.__codexDragonBackgroundV2.status()');
  await connection.evaluate(wallpaperExpression('data:image/png;base64,'+picture.toString('base64'),80));
  const scaled=await connection.evaluate('window.__codexDragonBackgroundV2.status()');
  assert.equal(scaled.scale,80);assert(Math.abs(scaled.renderedImageWidth-unscaled.renderedImageWidth*.8)<2);assert(Math.abs(scaled.renderedImageHeight-unscaled.renderedImageHeight*.8)<2);
  await connection.evaluate("document.querySelector('.structure').style.width='';document.querySelector('aside.preview').style.width=''");
  await sleep(450);
  assert.deepEqual(await connection.evaluate("['aside','.message','textarea'].map(s=>getComputedStyle(document.querySelector(s)).backgroundColor)"), colorsBefore);
  stage = 'interaction';
  const input = await connection.evaluate("(()=>{const r=document.querySelector('textarea').getBoundingClientRect();return {x:r.x+30,y:r.y+25};})()");
  await connection.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: input.x, y: input.y, button: 'left', clickCount: 1 });
  await connection.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: input.x, y: input.y, button: 'left', clickCount: 1 });
  assert.equal(await connection.evaluate('window.composerClicks'), 1);
  assert.equal(await connection.evaluate("document.activeElement === document.querySelector('textarea')"), true);
  const applied = await shot();
  assert(!applied.equals(before), 'The image must change actual rendered pixels.');
  await fs.writeFile(path.join(work, 'background-browser-preview.png'), applied);
  stage = 'restore';
  await connection.evaluate('document.activeElement.blur();window.__codexDragonBackgroundV2.remove()');
  assert.equal(await connection.evaluate("document.querySelectorAll('[data-codex-dragon-wallpaper]').length"), 0);
  assert((await shot()).equals(before), 'Removing the background must restore the original pixels exactly.');
  stage = 'reapply';
  await connection.evaluate(expression);
  await connection.evaluate(expression);
  assert.equal(await connection.evaluate("document.querySelectorAll('#codex-dragon-wallpaper-v2').length"), 1);
  await connection.evaluate("(()=>{const old=document.querySelector('main'),next=old.cloneNode(true);next.querySelector('#codex-dragon-wallpaper-v2')?.remove();next.removeAttribute('data-codex-dragon-wallpaper');next.querySelectorAll('[data-codex-dragon-wallpaper]').forEach(x=>x.removeAttribute('data-codex-dragon-wallpaper'));old.replaceWith(next);})()");
  await sleep(400);
  assert.equal(await connection.evaluate("window.__codexDragonBackgroundV2.status().installed"), true);
  await connection.evaluate('window.__codexDragonBackgroundV2.remove()');
  await assert.rejects(() => Cdp.connect('ws://example.com:9236/devtools/page/test'), /Only a local/);
  stage = 'idle settings and route restoration';
  await connection.evaluate(`document.body.innerHTML='<div>Native settings fixture</div>';window.imageDecodeCalls=0;window.originalImageDecode=Image.prototype.decode;Image.prototype.decode=function(){window.imageDecodeCalls++;return window.originalImageDecode.call(this);}`);
  descriptorServer=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{...page,url:'app://-/index.html'}]));});
  await new Promise(resolve=>descriptorServer.listen(0,'127.0.0.1',resolve));
  const descriptorPort=descriptorServer.address().port;
  const fixtureImage={stamp:'idle-settings-fixture',dataUrl:'data:image/png;base64,'+picture.toString('base64')};
  const fixtureValues={transparency:28,fit:'铺满',position:'居中'};
  await applyBackgrounds(descriptorPort,fixtureValues,fixtureImage);
  await applyBackgrounds(descriptorPort,fixtureValues,fixtureImage);
  assert.equal(await connection.evaluate('window.imageDecodeCalls'),1,'Idle settings must not repeatedly decode or recreate the wallpaper.');
  await connection.evaluate(`document.body.innerHTML='<main><div class="structure"><div class="message">Native message</div><textarea aria-label="Composer"></textarea></div></main>'`);
  await sleep(400);
  assert.equal(await connection.evaluate('window.__codexDragonBackgroundV2.status().installed'),true);
  assert.equal(await connection.evaluate('window.imageDecodeCalls'),1);
  await connection.evaluate('window.__codexDragonBackgroundV2.remove()');
  console.log(JSON.stringify({result:'PASS', checks:['split panes through display:contents','visible wallpaper pixels','native panel colors unchanged','real composer click and focus','pixel-exact removal','idempotent reapply','chat-surface replacement','remote endpoint rejected','idle settings image decoded once','chat route restores without new decode'], preview:path.join(work,'background-browser-preview.png')}, null, 2));
} catch (error) {
  console.error(JSON.stringify({stage,error:error.message,browserExitCode:edge.exitCode,browserError:errors}));
  throw error;
} finally {
  if(descriptorServer)await new Promise(resolve=>descriptorServer.close(resolve));
  connection?.close();
  if (browser) { await browser.call('Browser.close').catch(()=>{}); browser.close(); }
  else if (edge.pid) { edge.kill(); }
}
