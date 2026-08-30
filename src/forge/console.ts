/**
 * Single-page AgentForge console — GrokBot-shaped operator UI.
 * Served at GET / from the forge gateway.
 */

export function consoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AgentForge</title>
<style>
:root{
  --bg:#0f1410;--panel:#171d18;--ink:#e8efe6;--muted:#8a9a88;
  --line:#2a332b;--accent:#c4a35a;--ok:#6dbf8c;--warn:#d4a574;
  --font:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 10% -10%,#1c261c,var(--bg));
  color:var(--ink);font:15px/1.45 var(--font);min-height:100vh}
header{display:flex;align-items:center;justify-content:space-between;gap:1rem;
  padding:1rem 1.25rem;border-bottom:1px solid var(--line);backdrop-filter:blur(8px);
  position:sticky;top:0;background:#0f1410cc;z-index:5}
.brand{font-size:1.35rem;letter-spacing:.02em}
.brand span{color:var(--accent);font-weight:600}
.sub{color:var(--muted);font-size:.85rem}
nav{display:flex;gap:.4rem;flex-wrap:wrap}
nav button, .btn{background:transparent;border:1px solid var(--line);color:var(--ink);
  padding:.55rem .9rem;border-radius:6px;cursor:pointer;font:inherit;position:relative;z-index:6}
nav button.active, .btn.primary{border-color:var(--accent);color:var(--accent)}
.btn.primary{background:#c4a35a22}
main{display:grid;grid-template-columns:280px 1fr 300px;gap:0;min-height:calc(100vh - 64px)}
@media(max-width:960px){main{grid-template-columns:1fr}}
aside,section, .rail{border-right:1px solid var(--line);padding:1rem;overflow:auto}
.rail{border-right:0;border-left:1px solid var(--line)}
h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 .75rem}
.card{border:1px solid var(--line);border-radius:8px;padding:.75rem;margin-bottom:.6rem;background:var(--panel);cursor:pointer}
.card:hover,.card.sel{border-color:var(--accent)}
.card b{display:block}
.meta{color:var(--muted);font-size:.8rem}
.row{display:flex;gap:.5rem;flex-wrap:wrap;margin:.5rem 0}
input,textarea,select{width:100%;background:#0c100d;border:1px solid var(--line);color:var(--ink);
  border-radius:6px;padding:.55rem .65rem;font:inherit}
textarea{min-height:88px;resize:vertical}
#log{font-family:var(--mono);font-size:.8rem;white-space:pre-wrap;background:#0c100d;
  border:1px solid var(--line);border-radius:8px;padding:.75rem;max-height:42vh;overflow:auto}
.msg{margin:.5rem 0;padding:.55rem .7rem;border-radius:8px;background:#121812;border:1px solid var(--line)}
.msg.assistant{border-color:#3a4a3c}
.msg .who{font-size:.72rem;color:var(--accent);margin-bottom:.25rem}
.pill{display:inline-block;padding:.1rem .4rem;border-radius:999px;border:1px solid var(--line);font-size:.7rem;color:var(--muted)}
.err{color:#e08787}
</style>
</head>
<body>
<header>
  <div>
    <div class="brand"><span>AgentForge</span></div>
    <div class="sub">GrokBot-shaped · one shared VM · command chain · multi-provider</div>
  </div>
  <nav id="tabs">
    <button data-tab="agents" class="active">Agents</button>
    <button data-tab="groups">Groups</button>
    <button data-tab="vm">Shared VM</button>
    <button data-tab="providers">Providers</button>
  </nav>
  <div class="row">
    <button class="btn primary" id="seedBtn">Seed demo team</button>
  </div>
</header>
<main>
  <aside>
    <h2 id="listTitle">Agents</h2>
    <div id="list"></div>
    <div class="row" id="createRow"></div>
  </aside>
  <section>
    <h2 id="mainTitle">Chat</h2>
    <div id="chat"></div>
    <div class="row">
      <textarea id="prompt" placeholder="Message… e.g. triage my unread email"></textarea>
    </div>
    <div class="row">
      <button class="btn primary" id="sendBtn">Send</button>
      <span class="pill" id="routePill"></span>
    </div>
    <h2 style="margin-top:1.25rem">Screen / trace</h2>
    <div id="log"></div>
  </section>
  <div class="rail">
    <h2>Context</h2>
    <div id="ctx" class="meta">Select an agent or group.</div>
  </div>
</main>
<script>
const state = { tab:'agents', agents:[], groups:[], providers:[], sel:null, selKind:null, conv:null };
const $ = (id)=>document.getElementById(id);
async function api(method, path, body){
  const r = await fetch(path,{method,headers:body?{'content-type':'application/json'}:{},
    body:body?JSON.stringify(body):undefined});
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||r.statusText);
  return j;
}
function setTab(t){
  state.tab=t; state.sel=null; state.selKind=null; state.conv=null;
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('active',b.dataset.tab===t));
  $('listTitle').textContent = t==='agents'?'Agents':t==='groups'?'Groups':t==='vm'?'VM files':'Providers';
  render();
}
document.querySelectorAll('#tabs button').forEach(b=>{
  b.addEventListener('click', (e)=>{ e.preventDefault(); setTab(b.dataset.tab); });
});
window.addEventListener('hashchange', ()=>{
  const t=(location.hash||'#agents').slice(1);
  if(['agents','groups','vm','providers'].includes(t)) setTab(t);
});
if(location.hash){ const t=location.hash.slice(1); if(['agents','groups','vm','providers'].includes(t)) state.tab=t; }

$('seedBtn').onclick=async()=>{
  try{ const j=await api('POST','/setup/seed'); alert(j.created?'Demo team seeded':'Already seeded'); await refresh(); }
  catch(e){ alert(e.message); }
};
async function refresh(){
  const [a,g,p]=await Promise.all([
    api('GET','/agents'), api('GET','/groups'), api('GET','/providers')
  ]);
  state.agents=a.agents||[]; state.groups=g.groups||[]; state.providers=p.providers||[];
  render();
}
function render(){
  const list=$('list'); list.innerHTML='';
  $('createRow').innerHTML='';
  if(state.tab==='agents'){
    state.agents.forEach(a=>{
      const d=document.createElement('div'); d.className='card'+(state.sel===a.id?' sel':'');
      d.innerHTML=\`<b>\${esc(a.name)}</b><div class="meta">\${esc(a.title)} · \${esc(a.role)} · \${esc(a.providerId||'no provider')}</div>\`;
      d.onclick=()=>{state.sel=a.id;state.selKind='agent';state.conv=null;render();loadScreen(a.id);};
      list.appendChild(d);
    });
    $('createRow').innerHTML=\`<button class="btn" id="newAgent">+ Agent</button>\`;
    $('newAgent').onclick=createAgent;
    $('mainTitle').textContent = state.sel ? 'Agent chat' : 'Select an agent';
  } else if(state.tab==='groups'){
    state.groups.forEach(g=>{
      const d=document.createElement('div'); d.className='card'+(state.sel===g.id?' sel':'');
      d.innerHTML=\`<b>\${esc(g.name)}</b><div class="meta">\${g.memberIds.length} members · owner \${esc(g.ownerId.slice(0,12))}…</div>\`;
      d.onclick=()=>{state.sel=g.id;state.selKind='group';state.conv=null;render();};
      list.appendChild(d);
    });
    $('mainTitle').textContent = state.sel ? 'Group command chain' : 'Select a group';
  } else if(state.tab==='providers'){
    state.providers.forEach(p=>{
      const d=document.createElement('div'); d.className='card';
      d.innerHTML=\`<b>\${esc(p.name)}</b><div class="meta">\${esc(p.kind)} · model \${esc(p.defaultModel)} · key \${p.hasKey?'yes':'no'} · \${p.enabled?'on':'off'}</div>\`;
      list.appendChild(d);
    });
    $('createRow').innerHTML=\`<button class="btn" id="cfgProv">Configure key</button>\`;
    $('cfgProv').onclick=cfgProvider;
    $('mainTitle').textContent='Providers';
  } else {
    loadVm();
    $('mainTitle').textContent='Shared VM';
  }
  renderCtx();
  renderChat();
}
function renderCtx(){
  const ctx=$('ctx');
  if(state.selKind==='agent'){
    const a=state.agents.find(x=>x.id===state.sel);
    if(!a){ctx.textContent='';return;}
    const c=a.contract;
    ctx.innerHTML=\`<b>\${esc(a.name)}</b><div class="meta">\${esc(a.screenId)}</div>
      \${c?\`<p><b>Job</b><br>\${esc(c.job)}</p><p><b>No-data</b><br>\${esc(c.noDataRule)}</p>\`:'<p class="meta">No contract yet</p>'}\`;
  } else if(state.selKind==='group'){
    const g=state.groups.find(x=>x.id===state.sel);
    if(!g){ctx.textContent='';return;}
    const members=g.memberIds.map(id=>state.agents.find(a=>a.id===id)).filter(Boolean);
    ctx.innerHTML=\`<b>\${esc(g.name)}</b><ul>\${members.map(m=>\`<li>\${esc(m.name)} <span class="pill">\${esc(m.role)}</span></li>\`).join('')}</ul>
      <p class="meta">Command chain: Chief routes to specialists on the shared VM.</p>\`;
  } else ctx.textContent='Select an agent or group.';
}
function renderChat(){
  const box=$('chat');
  if(!state.conv){ box.innerHTML='<div class="meta">No messages yet.</div>'; return; }
  box.innerHTML = state.conv.messages.map(m=>{
    const who = m.role==='user'?'you':(state.agents.find(a=>a.id===m.agentId)?.name||'assistant');
    const route = m.meta&&m.meta.route ? \`<div class="meta">\${esc(m.meta.route)}</div>\`:'';
    return \`<div class="msg \${m.role}"><div class="who">\${esc(who)}</div>\${route}\${esc(m.content)}</div>\`;
  }).join('');
}
async function loadScreen(agentId){
  try{
    const j=await api('GET','/vm/screens/'+agentId);
    $('log').textContent=(j.lines||[]).map(l=>\`[\${new Date(l.at).toLocaleTimeString()}] \${l.kind}  \${l.text}\`).join('\\n')||'(empty)';
  }catch(e){$('log').textContent=e.message;}
}
async function loadVm(){
  const list=$('list'); list.innerHTML='';
  try{
    const [files,mem]=await Promise.all([api('GET','/vm/files'), api('GET','/vm/memory')]);
    (files.files||[]).forEach(f=>{
      const d=document.createElement('div'); d.className='card';
      d.innerHTML=\`<b>\${esc(f.path)}</b><div class="meta">\${f.bytes} bytes</div>\`;
      d.onclick=async()=>{ const r=await api('GET','/vm/files/'+encodeURIComponent(f.path));
        $('chat').innerHTML=\`<pre id="log" style="max-height:none">\${esc(r.content)}</pre>\`; };
      list.appendChild(d);
    });
    $('ctx').innerHTML='<b>Shared memory</b><pre style="white-space:pre-wrap">'+esc(JSON.stringify(mem.memory||{},null,2))+'</pre>';
  }catch(e){ list.textContent=e.message; }
}
$('sendBtn').onclick=async()=>{
  const text=$('prompt').value.trim(); if(!text) return;
  try{
    $('routePill').textContent='…';
    let j;
    if(state.selKind==='agent'){
      j=await api('POST','/agents/'+state.sel+'/chat',{message:text,conversationId:state.conv?.id});
      state.conv=j.conversation; $('routePill').textContent='direct';
      await loadScreen(state.sel);
    } else if(state.selKind==='group'){
      j=await api('POST','/groups/'+state.sel+'/chat',{message:text,conversationId:state.conv?.id});
      state.conv=j.conversation;
      const t=state.agents.find(a=>a.id===j.route?.targetAgentId);
      $('routePill').textContent=j.route?('→ '+(t?.name||j.route.targetAgentId)+' · '+j.route.reason):'';
      if(j.route?.targetAgentId) await loadScreen(j.route.targetAgentId);
    } else { alert('Select an agent or group'); return; }
    $('prompt').value=''; renderChat(); renderCtx();
  }catch(e){ $('routePill').innerHTML='<span class="err">'+esc(e.message)+'</span>'; }
};
async function createAgent(){
  const name=prompt('Agent name'); if(!name) return;
  const role=prompt('Role: chief_of_staff | specialist | worker','specialist')||'specialist';
  const title=prompt('Title', name)||name;
  await api('POST','/agents',{name,role,title,providerId:'mock'});
  await refresh();
}
async function cfgProvider(){
  const kind=prompt('Provider kind: zai | claude | openai | openrouter | opencode | mock','zai'); if(!kind) return;
  const apiKey=prompt('API key (stored in forge-state 0600; leave blank to keep)')||undefined;
  const defaultModel=prompt('Default model (optional)')||undefined;
  await api('POST','/providers',{kind,apiKey,defaultModel,actorId:'human'});
  await refresh();
}
function esc(s){ return String(s??'').replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
refresh().catch(e=>alert(e.message));
</script>
</body>
</html>`;
}
