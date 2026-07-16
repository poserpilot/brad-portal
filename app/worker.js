/**
 * Brad's Working Portal — Cloudflare Worker
 * ------------------------------------------------------------------
 * - KV-backed task store (binding: PORTAL_KV, key: "state")
 * - Canonical + versioned in GitHub: every write commits tasks.json
 *   back to the repo (live store + git spine, same as tribal-knowledge).
 * - Serves a themed web UI at "/".
 *
 * Bindings / secrets (see wrangler.toml + DEPLOY.md):
 *   PORTAL_KV     (KV namespace)
 *   WRITE_KEY     (secret)  bearer token required for writes
 *   GITHUB_TOKEN  (secret)  fine-grained PAT, Contents R/W on the repo
 *   GITHUB_REPO   (var)     e.g. "poserpilot/brad-claude-context"
 *   GITHUB_PATH   (var)     e.g. "portal/data/tasks.json"
 *   GITHUB_BRANCH (var)     e.g. "main"
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      if (pathname === "/" || pathname === "/index.html") {
        return html(UI);
      }
      if (pathname === "/api/tasks" && request.method === "GET") {
        const state = await getState(env);
        return json(state);
      }
      if (pathname === "/api/tasks" && request.method === "POST") {
        requireAuth(request, env);
        const body = await request.json();
        const state = await getState(env);
        const id = "T-" + String(state.next_id).padStart(4, "0");
        const task = {
          id,
          title: String(body.title || "").trim(),
          status: body.status || "open",
          priority: body.priority || "med",
          project: body.project || "personal",
          due: body.due || null,
          created: today(),
          completed: null,
          source: body.source || "api",
          notes: body.notes || "",
        };
        if (!task.title) return json({ error: "title required" }, 400);
        state.tasks.push(task);
        state.next_id += 1;
        await saveState(env, state, `portal: add ${id} — ${task.title}`);
        return json({ ok: true, task });
      }
      const m = pathname.match(/^\/api\/tasks\/(T-\d+)$/);
      if (m && request.method === "PATCH") {
        requireAuth(request, env);
        const body = await request.json();
        const state = await getState(env);
        const id = m[1];
        let t = state.tasks.find((x) => x.id === id) || state.done.find((x) => x.id === id);
        if (!t) return json({ error: "not found" }, 404);
        for (const k of ["title", "priority", "project", "due", "notes", "status", "completed"]) {
          if (k in body) t[k] = body[k];
        }
        // Move between active/done lists on status change (archive over delete).
        if (t.status === "done" && !t.completed) t.completed = today();
        state.tasks = state.tasks.filter((x) => x.id !== id);
        state.done = state.done.filter((x) => x.id !== id);
        (t.status === "done" || t.status === "archived" ? state.done : state.tasks).push(t);
        await saveState(env, state, `portal: update ${id} — ${t.status}`);
        return json({ ok: true, task: t });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      const code = e.status || 500;
      return json({ error: e.message || String(e) }, code);
    }
  },
};

/* ---------- state: KV first, GitHub as source of truth ---------- */

async function getState(env) {
  const cached = await env.PORTAL_KV.get("state", "json");
  if (cached) return normalize(cached);
  const fromRepo = await readRepoFile(env);
  const state = normalize(fromRepo || { schema_version: 1, next_id: 1, tasks: [], done: [] });
  await env.PORTAL_KV.put("state", JSON.stringify(state));
  return state;
}

function normalize(s) {
  s.schema_version = s.schema_version || 1;
  s.tasks = s.tasks || [];
  s.done = s.done || [];
  s.next_id = s.next_id || (s.tasks.length + s.done.length + 1);
  return s;
}

async function saveState(env, state, message) {
  state.updated = new Date().toISOString();
  state.updated_by = "portal-worker";
  const text = JSON.stringify(state, null, 2) + "\n";
  await env.PORTAL_KV.put("state", JSON.stringify(state));
  // Write-through to git (best-effort; KV already has the truth for reads).
  if (env.GITHUB_TOKEN) {
    try { await writeRepoFile(env, text, message); }
    catch (e) { console.log("git write-through failed:", e.message); }
  }
}

/* ---------- GitHub Contents API (unblocked from the CF edge) ---------- */

function gh(env, extra = {}) {
  return {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "brad-portal-worker",
    ...extra,
  };
}

async function readRepoFile(env) {
  if (!env.GITHUB_TOKEN) return null;
  const u = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${env.GITHUB_PATH}?ref=${env.GITHUB_BRANCH}`;
  const r = await fetch(u, { headers: gh(env) });
  if (r.status === 404) return null;
  if (!r.ok) throw httpErr(502, `github read ${r.status}`);
  const j = await r.json();
  return JSON.parse(b64decodeUtf8(j.content));
}

async function writeRepoFile(env, text, message) {
  const base = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${env.GITHUB_PATH}`;
  // Need current sha to update in place.
  let sha = null;
  const head = await fetch(`${base}?ref=${env.GITHUB_BRANCH}`, { headers: gh(env) });
  if (head.ok) sha = (await head.json()).sha;
  const put = await fetch(base, {
    method: "PUT",
    headers: gh(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      message,
      content: b64encodeUtf8(text),
      branch: env.GITHUB_BRANCH,
      sha: sha || undefined,
      committer: { name: "portal-bot", email: "actions@github.com" },
    }),
  });
  if (!put.ok) throw httpErr(502, `github write ${put.status}: ${await put.text()}`);
}

/* ---------- helpers ---------- */

function requireAuth(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.replace(/^Bearer\s+/i, "");
  if (!env.WRITE_KEY || token !== env.WRITE_KEY) throw httpErr(401, "unauthorized");
}
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }
function today() { return new Date().toISOString().slice(0, 10); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });
}
function html(body) {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
}
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(String(b64).replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/* ---------- Web UI ("Cleared to Climb" house style) ---------- */

const UI = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brad — Working Portal</title>
<style>
  :root{ --navy:#0B1F38; --panel:#15304C; --panel2:#1E4063; --ice:#B7CCE4;
         --sky:#46A5E6; --gold:#F2B13B; --green:#5FB98E; --red:#E0654F; }
  *{box-sizing:border-box} body{margin:0;font-family:Arial,Helvetica,sans-serif;
    background:var(--navy);color:var(--ice);-webkit-font-smoothing:antialiased}
  header{padding:22px 26px 14px;border-bottom:1px solid var(--panel2)}
  .kick{letter-spacing:.22em;font-size:11px;color:var(--sky);text-transform:uppercase}
  h1{margin:4px 0 2px;color:#fff;font-size:26px}
  .thesis{font-style:italic;color:#8fb0d6;font-size:13px;margin:0}
  .wrap{max-width:920px;margin:0 auto;padding:20px 22px 60px}
  .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0 22px}
  input,select,textarea{background:var(--panel);color:#fff;border:1px solid var(--panel2);
    border-radius:8px;padding:9px 11px;font-size:14px;font-family:inherit}
  input::placeholder{color:#7f9dbd} .grow{flex:1;min-width:180px}
  button{background:var(--gold);color:#1a1200;border:0;border-radius:8px;padding:9px 15px;
    font-weight:700;cursor:pointer;font-size:14px} button.ghost{background:var(--panel2);color:#fff}
  .col-h{letter-spacing:.14em;font-size:12px;text-transform:uppercase;color:var(--sky);
    margin:26px 0 8px;border-bottom:1px solid var(--panel2);padding-bottom:5px}
  .card{background:var(--panel);border:1px solid var(--panel2);border-left:4px solid var(--panel2);
    border-radius:10px;padding:12px 14px;margin:9px 0;display:flex;gap:12px;align-items:flex-start}
  .card.high{border-left-color:var(--red)} .card.med{border-left-color:var(--gold)}
  .card.low{border-left-color:var(--sky)} .card.blocked{opacity:.75}
  .title{color:#fff;font-size:15px;margin:0 0 3px} .meta{font-size:12px;color:#8fb0d6}
  .notes{font-size:12.5px;color:#a9c3e0;margin-top:5px}
  .due{font-weight:700} .due.soon{color:var(--gold)} .due.over{color:var(--red)}
  .chk{margin-top:1px;cursor:pointer;background:var(--panel2);border:1px solid #34597e;color:#fff;
    width:24px;height:24px;border-radius:6px;font-size:15px;flex:0 0 auto;padding:0;line-height:1;
    display:inline-flex;align-items:center;justify-content:center}
  .chk:hover{border-color:var(--sky)}
  .chk.done{background:var(--green);border-color:var(--green);color:#0B1F38}
  .pill{display:inline-block;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;
    background:var(--panel2);color:var(--ice);border-radius:20px;padding:2px 9px;margin-left:6px}
  .empty{color:#7f9dbd;font-style:italic;padding:8px 0}
  #key{max-width:150px} .muted{color:#7f9dbd;font-size:12px;margin-top:30px}
  a{color:var(--sky)}
</style></head>
<body>
<header>
  <div class="kick">Halo · Personal Ops</div>
  <h1>Working Portal</h1>
  <p class="thesis">Everything on my plate — one source of truth. Cleared to climb.</p>
</header>
<div class="wrap">
  <div class="bar">
    <input id="title" class="grow" placeholder="Add a to-do…" />
    <select id="priority"><option value="high">High</option><option value="med" selected>Med</option><option value="low">Low</option></select>
    <input id="due" type="date" />
    <input id="project" placeholder="project" value="personal" style="max-width:120px"/>
    <input id="key" type="password" placeholder="write key" />
    <button onclick="add()">Add</button>
    <button class="ghost" onclick="load()">↻</button>
  </div>
  <div id="board"></div>
  <p class="muted">Canonical store: <code>data/tasks.json</code> · versioned in GitHub · brad@halo.one</p>
</div>
<script>
const API = location.origin + "/api/tasks";
let KEY = "";
try{ KEY = localStorage.getItem("portal_write_key") || ""; }catch(e){}
function getKey(){ const f=document.getElementById("key").value.trim(); if(f){ KEY=f; try{localStorage.setItem("portal_write_key",f)}catch(e){} } return KEY; }
function ensureKey(){ const k=getKey(); if(!k){ alert("Enter your write key in the box at the top first — it'll be remembered after that."); document.getElementById("key").focus(); } return k; }
async function apiErr(r){ try{const j=await r.json(); return (r.status===401?"Write key rejected — check it matches the WRITE_KEY you set. ":"")+(j.error||r.status);}catch(e){return String(r.status);} }
function h(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function dueClass(d){ if(!d) return ""; const days=(new Date(d)-new Date())/864e5;
  if(days<0) return "over"; if(days<=3) return "soon"; return ""; }
function dueLabel(d){ if(!d) return ""; const days=Math.ceil((new Date(d)-new Date())/864e5);
  if(days<0) return "overdue "+(-days)+"d"; if(days===0) return "due today";
  return "due in "+days+"d ("+d+")"; }
async function load(){
  const r = await fetch(API); const s = await r.json();
  const order={high:0,med:1,low:2};
  const active=(s.tasks||[]).sort((a,b)=>(order[a.priority]-order[b.priority])||((a.due||"9")>(b.due||"9")?1:-1));
  const done=(s.done||[]).slice(-8).reverse();
  let out="";
  const groups={high:"🔴 High priority",med:"🟡 Medium",low:"⚪ Low"};
  for(const p of ["high","med","low"]){
    const items=active.filter(t=>t.priority===p);
    out+='<div class="col-h">'+groups[p]+'</div>';
    if(!items.length){ out+='<div class="empty">nothing here</div>'; continue; }
    for(const t of items) out+=card(t);
  }
  out+='<div class="col-h">✅ Recently done</div>';
  out+= done.length? done.map(t=>'<div class="card low"><button class="chk done" title="click to reopen" onclick="reopen(\\''+t.id+'\\')">✓</button><div style="flex:1"><p class="title">'+h(t.title)+'</p><div class="meta">'+h(t.project)+' · '+h(t.completed||"")+'</div></div></div>').join("") : '<div class="empty">none yet</div>';
  document.getElementById("board").innerHTML=out;
}
function card(t){
  const dc=dueClass(t.due), dl=dueLabel(t.due);
  return '<div class="card '+t.priority+(t.status==="blocked"?" blocked":"")+'">'
    +'<button class="chk" title="mark done" onclick="done(\\''+t.id+'\\')"></button>'
    +'<div style="flex:1"><p class="title">'+h(t.title)
    +(t.status==="blocked"?'<span class="pill">blocked</span>':'')
    +'<span class="pill">'+h(t.project)+'</span></p>'
    +'<div class="meta">'+h(t.id)+(dl?' · <span class="due '+dc+'">'+dl+'</span>':'')+'</div>'
    +(t.notes?'<div class="notes">'+h(t.notes)+'</div>':'')+'</div></div>';
}
async function add(){
  const title=document.getElementById("title").value.trim(); if(!title) return;
  const key=ensureKey(); if(!key) return;
  const body={title, priority:document.getElementById("priority").value,
    due:document.getElementById("due").value||null, project:document.getElementById("project").value||"personal", source:"portal-ui"};
  const r=await fetch(API,{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+key},body:JSON.stringify(body)});
  if(!r.ok){ alert("Add failed: "+await apiErr(r)); return; }
  document.getElementById("title").value=""; document.getElementById("due").value=""; load();
}
async function done(id){
  const key=ensureKey(); if(!key) return;
  const r=await fetch(API+"/"+id,{method:"PATCH",headers:{"Content-Type":"application/json","Authorization":"Bearer "+key},body:JSON.stringify({status:"done"})});
  if(!r.ok){ alert("Update failed: "+await apiErr(r)); return; } load();
}
async function reopen(id){
  const key=ensureKey(); if(!key) return;
  const r=await fetch(API+"/"+id,{method:"PATCH",headers:{"Content-Type":"application/json","Authorization":"Bearer "+key},body:JSON.stringify({status:"open",completed:null})});
  if(!r.ok){ alert("Reopen failed: "+await apiErr(r)); return; } load();
}
try{ const sk=localStorage.getItem("portal_write_key"); if(sk) document.getElementById("key").value=sk; }catch(e){}
load();
</script>
</body></html>`;
