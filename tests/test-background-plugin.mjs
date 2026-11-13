import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { Controller, Store, DEFAULT_IMAGE, loadImage } from '../plugins/dragon-background/src/core.mjs';
const work = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(work, '../plugins/dragon-background');
const temp = await fs.mkdtemp(path.join(work,'plugin-check-'));
const host = {debugReady:false,mainCount:1,mainPid:process.pid,startTicks:'123',portAvailable:true};
async function fixture() {
 const store = new Store(path.join(temp,Math.random().toString(16).slice(2)));
 await store.write({...(await store.read()),enabled:false});
 const calls = [];
 let accepted = false, state = {...host};
 const native = {status:async()=>({...state}),confirmRestart:async()=>{calls.push('confirm');return accepted;},restart:async()=>calls.push('restart'),startAgent:async()=>calls.push('start'),remove:async()=>calls.push('remove'),pickImage:async()=>DEFAULT_IMAGE};
 return {store,native,controller:new Controller(store,native),calls,setAccepted:x=>accepted=x,setHost:x=>state={...state,...x}};
}

test('a new profile uses the current appearance defaults without restarting an ordinary host',async()=>{
 const store=new Store(path.join(temp,'fresh-defaults'));
 assert.deepEqual(await store.read(),{enabled:true,imagePath:DEFAULT_IMAGE,transparency:75,scale:100,fit:'完整显示',position:'居中'});
 const calls=[];
 const controller=new Controller(store,{status:async()=>({...host}),confirmRestart:async()=>{calls.push('confirm');return true;},restart:async()=>calls.push('restart'),startAgent:async()=>calls.push('start')});
 const read=await controller.read();assert.equal(read.values.enabled,false);assert.equal(read.values.transparency,75);assert.equal(read.values.fit,'完整显示');assert.deepEqual(calls,[]);
 assert.equal((await store.read()).enabled,true);
});

test('ordinary launch displays off while preserving remembered on',async()=>{
 const f=await fixture();await f.store.write({...(await f.store.read()),enabled:true});
 const result=await f.controller.read();assert.equal(result.values.enabled,false);assert.equal((await f.store.read()).enabled,true);assert.deepEqual(f.calls,[]);
});
test('declining restart changes neither stored preference nor display settings',async()=>{
 const f=await fixture();const before=await f.store.read();const result=await f.controller.update({enabled:true,transparency:50});
 assert.equal(result.values.enabled,false);assert.deepEqual(await f.store.read(),before);assert.deepEqual(f.calls,['confirm']);
});
test('confirmed enable schedules exactly one restart and persists preference',async()=>{
 const f=await fixture();f.setAccepted(true);const result=await f.controller.update({enabled:true});
 assert.equal((await f.store.read()).enabled,true);assert.equal(result.values.enabled,false);assert.deepEqual(f.calls,['confirm','restart']);
});
test('a helper that fails before readiness rolls back the preference',async()=>{
 const f=await fixture();f.setAccepted(true);const before=await f.store.read();
 f.native.restart=async()=>{throw new Error('missing ready receipt');};
 await assert.rejects(()=>f.controller.update({enabled:true}),/missing ready receipt/);
 assert.deepEqual(await f.store.read(),before);
});
test('upgrades migrate the bundled image while keeping custom image choices',async()=>{
 const f=await fixture();const before=await f.store.read();
 await f.store.write({...before,imagePath:'C:/Users/TestUser/.codex/plugins/cache/ccy1430-background-local/dragon-background/0.2.1/assets/background.png'});
 assert.equal((await f.store.read()).imagePath,DEFAULT_IMAGE);
 const custom='D:/My Images/dragon.png';await f.store.write({...before,imagePath:custom});
 assert.equal((await f.store.read()).imagePath,custom);
});
test('scale is persisted without breaking older settings connections',async()=>{
 const f=await fixture();const values=await f.store.read();await f.store.write({...values,scale:70});
 const legacy=JSON.parse(await fs.readFile(f.store.file,'utf8'));assert.equal(Object.hasOwn(legacy,'scale'),false);
 assert.equal((await f.store.read()).scale,70);
 await fs.writeFile(f.store.file,JSON.stringify({...legacy,transparency:80}));
 assert.equal((await f.store.read()).scale,70);assert.equal((await f.store.read()).transparency,80);
 await assert.rejects(()=>f.controller.update({scale:24}),/缩放范围/);
 assert.equal((await f.store.read()).scale,70);
});
test('debug launch restores both remembered off and remembered on; disable removes immediately',async()=>{
 const f=await fixture();f.setHost({debugReady:true});assert.equal((await f.controller.read()).values.enabled,false);
 assert.equal((await f.controller.update({enabled:true})).values.enabled,true);assert.deepEqual(f.calls,['start']);
 f.calls.length=0;assert.equal((await f.controller.update({enabled:false})).values.enabled,false);assert.deepEqual(f.calls,['remove']);
});
test('multiple app instances and occupied ports never restart or launch another app',async()=>{
 const f=await fixture();f.setAccepted(true);f.setHost({mainCount:2});await assert.rejects(()=>f.controller.update({enabled:true}),/只允许一个/);assert.deepEqual(f.calls,[]);
 f.setHost({mainCount:1,portAvailable:false});await assert.rejects(()=>f.controller.update({enabled:true}),/端口/);assert.deepEqual(f.calls,[]);
});
test('local picker saves the selected image without enabling or restarting',async()=>{
 const f=await fixture();const result=await f.controller.chooseImage();assert.equal(result.values.imagePath,DEFAULT_IMAGE);assert.equal(result.values.enabled,false);assert.deepEqual(f.calls,['remove']);
});
test('bad images and unsafe URLs are rejected without saving or prompting',async()=>{
 const f=await fixture();await assert.rejects(()=>f.controller.update({imagePath:'https://example.com/private.png'}),/本地/);
 const image=await loadImage(DEFAULT_IMAGE);assert.equal(image.width,930);assert.equal(image.height,1691);
 const huge=path.join(temp,'too-large.png');const data=Buffer.from(image.bytes);data.writeUInt32BE(60000,16);await fs.writeFile(huge,data);
 await assert.rejects(()=>loadImage(huge),/尺寸/);assert.deepEqual(f.calls,[]);
});
test('MCP transport advertises native settings and all declared action tools',async()=>{
 const child=spawn(process.execPath,[path.join(root,'src/server.mjs')],{windowsHide:true,env:{...process.env,DRAGON_BACKGROUND_DATA:path.join(temp,'protocol')},stdio:['pipe','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);
 child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}})+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n');
 await new Promise((resolve,reject)=>{child.on('exit',code=>code===0?resolve():reject(new Error(errors)));child.on('error',reject);});
 const responses=output.trim().split('\n').map(JSON.parse);assert.equal(responses[0].result.capabilities.experimental['openai/settings'].readTool,'settings.read');assert.deepEqual(responses[1].result.tools.map(x=>x.name),['settings.read','settings.update','choose_image','background_status','artwork_info']);
});
test('background worker is single-instance and exits when disabled',async()=>{
 const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end('[]');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const dataDir=path.join(temp,'agent');const store=new Store(dataDir);await store.write({...(await store.read()),enabled:true});
 const launch=()=>spawn(process.execPath,[path.join(root,'src/agent.mjs'),'--main-pid',String(process.pid),'--data',dataDir,'--port',String(server.address().port)],{windowsHide:true,stdio:'ignore'});
 const first=launch();const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 try {
  let lock;for(let i=0;i<40;i++){try{lock=JSON.parse(await fs.readFile(path.join(dataDir,'agent.lock'),'utf8'));break;}catch{}await wait(50);}assert.equal(lock.pid,first.pid);
  const second=launch();assert.equal(await new Promise(resolve=>second.on('exit',resolve)),0);assert.equal(JSON.parse(await fs.readFile(path.join(dataDir,'agent.lock'),'utf8')).pid,first.pid);
  await store.write({...(await store.read()),enabled:false});
  const exited=await Promise.race([new Promise(resolve=>first.on('exit',()=>resolve(true))),wait(6000).then(()=>false)]);assert.equal(exited,true);
 } finally { if(first.exitCode===null)first.kill();await new Promise(resolve=>server.close(resolve)); }
});
