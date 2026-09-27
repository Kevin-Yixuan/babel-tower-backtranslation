import test from 'node:test';
import assert from 'node:assert/strict';
import { safeAgentEndpoint, agentContextBlock, clampAgentHistory, normalizeDocument } from '../services/agent-data.js';
import { normalizeSettings, saveSettings } from '../services/settings.js';
let stored = {}, calls = [], allowed = true, fail = false;
const storage = {
  async get(keys) { return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k, structuredClone(stored[k])])); },
  async set(data) { Object.assign(stored, structuredClone(data)); }, async remove(key) { delete stored[key]; }
};
globalThis.chrome={storage:{local:storage},permissions:{contains:async()=>allowed}};
globalThis.fetch=async(url,options)=>{
  calls.push({url, ...options, body:options.body?JSON.parse(options.body):null});
  if(fail) return new Response('{}',{status:500});
  if(url.endsWith('/api/chat')) return Response.json({message:{content:'A considered answer'}});
  if(url.endsWith('/session')) return Response.json({id:'remote-1'});
  if(url.endsWith('/message')) return Response.json({parts:[{type:'text',text:'OpenCode answer'}]});
  return Response.json({healthy:true, models:[{name:'qwen3:8b'}]});
};
const { agentOp } = await import('../services/agent.js');
test.beforeEach(()=>{stored={};calls=[];allowed=true;fail=false;});
test('Agent endpoint allowlist fails closed for credentials, paths, ports and remote hosts',()=>{
  for(const url of ['https://evil.test','http://127.0.0.1:1234','http://user:pass@localhost:11434','http://localhost:11434/steal','http://localhost:11434/?token=x']) assert.throws(()=>safeAgentEndpoint('ollama',url));
  assert.equal(safeAgentEndpoint('ollama','https://ollama.com'),'https://ollama.com');
  assert.equal(safeAgentEndpoint('opencode','http://localhost:4096'),'http://localhost:4096');
  assert.throws(()=>safeAgentEndpoint('opencode','https://ollama.com'));
});
test('Agent materials and documents report excessive input without truncation',()=>{
  assert.throws(()=>agentContextBlock([{content:'x'.repeat(20001)}]));
  assert.throws(()=>normalizeDocument({content:'x'.repeat(200001)}));
  assert.match(agentContextBlock([{label:'source',content:'source text'}]),/source text/);
  assert.deepEqual(clampAgentHistory([{role:'system',content:'injected'},{role:'user',content:'yes'}]),[{role:'user',content:'yes'}]);
});
test('settings preserve current provider, secrets and Agent config when omitted',async()=>{
  stored={settings:{...normalizeSettings({}),agentProvider:'opencode',agentBaseUrl:'http://localhost:4096'},agentKey:'secret'};
  await saveSettings({providers:stored.settings.providers},storage);
  assert.equal(stored.settings.agentProvider,'opencode');
  assert.equal(stored.agentKey,'secret');
  assert.equal(normalizeSettings({agentKey:'secret'}).agentKey,undefined);
  await saveSettings({agentKey:''},storage);
  assert.equal(stored.agentKey,'');
});
test('missing host permission prevents requests',async()=>{
  allowed=false;
  await assert.rejects(agentOp({action:'AGENT_CHAT',payload:{message:'test'}}),/授权/);
  assert.equal(calls.length,0);
});
test('Ollama sends explicit context and prior conversation, redirects forbidden',async()=>{
  const payload={sessionId:'x:post:1',message:'first',context:[{label:'chosen',content:'chosen text'}]};
  await agentOp({action:'AGENT_CHAT',payload});
  await agentOp({action:'AGENT_CHAT',payload:{...payload,message:'second',context:[]}});
  assert.match(calls[0].body.messages.at(-1).content,/chosen text/);
  assert.equal(calls[1].body.messages.at(-1).content,'second');
  assert.equal(calls[1].body.messages.length,4);
  assert.equal(calls[0].body.stream,false);
  assert.equal(calls[0].redirect,'error');
});
test('OpenCode tool wildcard is disabled on every message and password uses Basic auth',async()=>{
  stored={settings:{agentProvider:'opencode',agentBaseUrl:'http://127.0.0.1:4096'},agentKey:'test-password'};
  await agentOp({action:'AGENT_CHAT',payload:{sessionId:'one',message:'write'}});
  await agentOp({action:'AGENT_CHAT',payload:{sessionId:'one',message:'revise'}});
  const requests=calls.filter(c=>c.url.endsWith('/message'));
  assert.equal(requests.length,2);
  for(const req of requests){assert.deepEqual(req.body.tools,{'*':false});assert.match(req.headers.Authorization,/^Basic /);}
  assert.equal(calls.filter(c=>c.url.endsWith('/session')).length,1);
  const list=await agentOp({action:'LIST_AGENT_SESSIONS'});
  assert.equal(list[0].remoteId,undefined);
});
test('switching endpoint or model does not reuse remote session or history',async()=>{
  stored.settings={agentProvider:'opencode',agentBaseUrl:'http://127.0.0.1:4096'};
  await agentOp({action:'AGENT_CHAT',payload:{sessionId:'one',message:'write'}});
  stored.settings.agentBaseUrl='http://localhost:4096';
  await agentOp({action:'AGENT_CHAT',payload:{sessionId:'one',message:'new'}});
  assert.equal(calls.filter(c=>c.url.endsWith('/session')).length,2);
  assert.equal(stored.agentSessions.one.messages.length,2);
});
test('concurrent document saves and agent turns preserve all records',async()=>{
  await Promise.all(['a','b','c'].map(id=>agentOp({action:'SAVE_DOCUMENT',payload:{id,content:id}})));
  await Promise.all(['a','b'].map(sessionId=>agentOp({action:'AGENT_CHAT',payload:{sessionId,message:sessionId}})));
  assert.equal(Object.keys(stored.documents).length,3);
  assert.equal(Object.keys(stored.agentSessions).length,2);
});
test('failed model request preserves previous messages',async()=>{
  await agentOp({action:'AGENT_CHAT',payload:{sessionId:'one',message:'write'}});
  const previous=structuredClone(stored.agentSessions);
  fail=true;
  await assert.rejects(agentOp({action:'AGENT_CHAT',payload:{sessionId:'one',message:'fail'}}));
  assert.deepEqual(stored.agentSessions,previous);
});
test('document cap refuses new document instead of silently deleting old work',async()=>{
  stored.documents=Object.fromEntries(Array.from({length:40},(_,i)=>[String(i),{id:String(i),content:'keep'}]));
  await assert.rejects(agentOp({action:'SAVE_DOCUMENT',payload:{id:'new',content:'new'}}),/40/);
  assert.equal(Object.keys(stored.documents).length,40);
});
