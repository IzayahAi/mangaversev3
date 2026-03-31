import { useState, useRef, useEffect, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════
// DESIGN TOKENS
// ═══════════════════════════════════════════════════════════════
const C = {
  bg:"#09090f", surf:"#111118", card:"#16161f", border:"#22222e", border2:"#2e2e3e",
  purple:"#7c3aed", purpleL:"#a78bfa", pink:"#e84393", gold:"#f59e0b",
  teal:"#1d9e75", blue:"#3b82f6", text:"#ede9f8", muted:"#7b7899", dim:"#2d2b3e",
};

// ═══════════════════════════════════════════════════════════════
// SUPABASE CLIENT  — reads from .env.local in dev, Vercel env vars in prod
// ═══════════════════════════════════════════════════════════════
const SB_URL = import.meta.env.VITE_SUPABASE_URL || "https://your-project.supabase.co";
const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "your-anon-key";
const DEMO   = SB_URL.includes("your-project");

const sb = {
  h: (tok) => ({ "apikey":SB_KEY, "Authorization":`Bearer ${tok||SB_KEY}`, "Content-Type":"application/json", "Prefer":"return=representation" }),
  async rpc(path, body, tok) {
    const r = await fetch(`${SB_URL}${path}`, { method:"POST", headers:this.h(tok), body:JSON.stringify(body) });
    return r.json();
  },
  async get(table, qs, tok) {
    const r = await fetch(`${SB_URL}/rest/v1/${table}${qs||""}`, { headers:this.h(tok) });
    if (!r.ok) throw new Error((await r.json()).message);
    return r.json();
  },
  async post(table, body, tok) {
    const r = await fetch(`${SB_URL}/rest/v1/${table}`, { method:"POST", headers:this.h(tok), body:JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).message);
    return r.json();
  },
  async patch(table, id, body, tok) {
    const r = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, { method:"PATCH", headers:this.h(tok), body:JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).message);
    return r.json();
  },
  async del(table, id, tok) {
    await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, { method:"DELETE", headers:this.h(tok) });
  },
};

async function signUp(email, password, username) {
  if (DEMO) return { user:{ id:`demo_${Date.now()}`, email, username }, token:"demo" };
  const r = await sb.rpc("/auth/v1/signup", { email, password, data:{ username } });
  if (r.error) throw new Error(r.error.message);
  try { await sb.post("profiles", { id:r.user.id, username, email, role:"creator", credits:840 }, r.access_token); } catch{}
  return { user:{ id:r.user.id, email, username, role:"creator", credits:840 }, token:r.access_token };
}

async function signIn(email, password) {
  if (DEMO) return { user:{ id:`demo_${email.replace(/\W/g,"")}`, email, username:email.split("@")[0], role:"creator", credits:840 }, token:"demo" };
  const r = await sb.rpc("/auth/v1/token?grant_type=password", { email, password });
  if (r.error) throw new Error(r.error.message);
  let profile = {};
  try { const rows = await sb.get("profiles", `?id=eq.${r.user.id}`, r.access_token); profile = rows[0] || {}; } catch{}
  return { user:{ id:r.user.id, email, username:profile.username||email.split("@")[0], role:profile.role||"creator", credits:profile.credits||840 }, token:r.access_token };
}

// ═══════════════════════════════════════════════════════════════
// LOCAL-STORAGE DB  (used in demo mode + as offline cache)
// ═══════════════════════════════════════════════════════════════
const lsKey = (uid) => `mv2_stories_${uid}`;
const lsGet = (uid) => { try { return JSON.parse(localStorage.getItem(lsKey(uid))||"[]"); } catch { return []; }};
const lsSet = (uid, data) => { try { localStorage.setItem(lsKey(uid), JSON.stringify(data)); } catch{} };

// ═══════════════════════════════════════════════════════════════
// DATABASE HOOK
// ═══════════════════════════════════════════════════════════════
function useDB(token, userId) {
  const [stories, setStories] = useState([]);
  const [busy, setBusy]       = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    setBusy(true);
    try {
      if (DEMO) { setStories(lsGet(userId)); return; }
      const rows = await sb.get("stories", `?author_id=eq.${userId}&order=updated_at.desc`, token);
      setStories(rows || []);
      lsSet(userId, rows || []);
    } catch { setStories(lsGet(userId)); }
    finally { setBusy(false); }
  }, [token, userId]);

  useEffect(() => { load(); }, [load]);

  const upsert = useCallback(async (raw) => {
    const now  = new Date().toISOString();
    const story = { ...raw, author_id:userId, updated_at:now };
    if (!story.id) story.id = `story_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    if (!story.created_at) story.created_at = now;

    // Optimistic local update
    setStories(prev => {
      const idx = prev.findIndex(s => s.id === story.id);
      return idx >= 0 ? prev.map(s => s.id === story.id ? story : s) : [story, ...prev];
    });
    lsSet(userId, lsGet(userId).map(s => s.id === story.id ? story : s).concat(
      lsGet(userId).find(s => s.id === story.id) ? [] : [story]
    ));

    // Persist to Supabase
    if (!DEMO && token) {
      try {
        const exists = lsGet(userId).find(s => s.id === raw.id);
        if (exists && raw.id) await sb.patch("stories", story.id, story, token);
        else await sb.post("stories", story, token);
      } catch (e) { console.warn("Supabase sync failed, kept local:", e.message); }
    }
    return story;
  }, [token, userId]);

  const remove = useCallback(async (id) => {
    setStories(prev => prev.filter(s => s.id !== id));
    lsSet(userId, lsGet(userId).filter(s => s.id !== id));
    if (!DEMO && token) await sb.del("stories", id, token).catch(() => {});
  }, [token, userId]);

  return { stories, busy, upsert, remove, reload: load };
}

// ═══════════════════════════════════════════════════════════════
// CLAUDE API
// ═══════════════════════════════════════════════════════════════
const CLAUDE_SYSTEM = `You are a world-class manga/manhwa story creator. You produce vivid, specific, publish-ready creative content. Always respond in valid JSON matching the exact schema. No markdown fences or explanations outside the JSON.`;

async function askClaude(prompt, onChunk) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ model:"claude-sonnet-4-6", max_tokens:4000, system:CLAUDE_SYSTEM, messages:[{role:"user",content:prompt}], stream:true }),
  });
  let full = "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value).split("\n").filter(l => l.startsWith("data: "))) {
      try { const j = JSON.parse(line.slice(6)); if (j.type==="content_block_delta") { full += j.delta?.text||""; onChunk(full); } } catch {}
    }
  }
  try { return JSON.parse(full); } catch { return null; }
}

const P_STORY = (seed, genre, tone) =>
  `Generate a complete manga story concept from: "${seed}". Genre: ${genre}. Tone: ${tone}.
Return JSON: {"title":"","tagline":"","logline":"","genre_tags":[],"setting":{"world":"","description":"","unique_element":""},"protagonist":{"name":"","age":0,"appearance":"","personality":"","wound":"","goal":"","need":""},"antagonist":{"name":"","role":"","motivation":"","mirror":""},"support_characters":[{"name":"","role":"","hook":""}],"central_conflict":"","themes":[],"chapter_one_hook":"","story_arc":[{"act":"","beats":""}],"visual_style_notes":"","comparable_works":[]}`;

const P_SCRIPT = (s) =>
  `Write Chapter 1 script (8 panels) for "${s.title}". Protagonist: ${s.protagonist?.name}. Setting: ${s.setting?.world}. Hook: ${s.chapter_one_hook}.
Return JSON: {"chapter_title":"","chapter_summary":"","panels":[{"number":1,"panel_type":"full_page|half_page|quarter","composition":"","scene_description":"","mood":"","dialogue":[{"character":"","type":"speech|thought|narration|sfx","text":""}],"visual_notes":""}],"chapter_end_hook":""}`;

const P_CHAR = (s) =>
  `Create character design brief for ${s.protagonist?.name} from "${s.title}". Appearance: ${s.protagonist?.appearance}.
Return JSON: {"design_brief":{"body_type":"","face":"","eyes":"","hair":"","default_outfit":"","battle_outfit":"","signature_accessory":"","color_palette":["#hex — usage"],"expression_range":{"happy":"","angry":"","sad":"","determined":""},"consistency_rules":[],"do_not":[],"how_they_move":""},"visual_arc":""}`;

// ═══════════════════════════════════════════════════════════════
// STATIC DATA
// ═══════════════════════════════════════════════════════════════
const SEED_LIB = [
  {id:"s1",emoji:"⚔️",title:"Crimson Chronicle",author:"Han Seojun",origin:"KR",genre_tags:["Dark fantasy","Action"],chapters:142,rating:4.8,views:"2.4M",langs:38,status:"ongoing",cover_color:"#3d0d2e"},
  {id:"s2",emoji:"🌸",title:"Sakura Protocol",author:"Tanaka Ren",origin:"JP",genre_tags:["Sci-fi","Romance"],chapters:65,rating:4.9,views:"5.1M",langs:51,status:"ongoing",cover_color:"#0a2a1a"},
  {id:"s3",emoji:"🔮",title:"Void Monarch",author:"Kim Daehyun",origin:"KR",genre_tags:["Fantasy","Action"],chapters:28,rating:4.6,views:"980K",langs:22,status:"ongoing",cover_color:"#1a0d3e"},
  {id:"s4",emoji:"🐉",title:"Dragon Empire",author:"Liu Wei",origin:"CN",genre_tags:["Historical","Epic"],chapters:201,rating:4.5,views:"8.2M",langs:61,status:"completed",cover_color:"#0a2a0a"},
  {id:"s5",emoji:"🏙️",title:"Neon Solitude",author:"Maria O.",origin:"GL",genre_tags:["Sci-fi","Drama"],chapters:12,rating:4.7,views:"340K",langs:17,status:"ongoing",cover_color:"#0a0a2e"},
  {id:"s6",emoji:"⚡",title:"Storm Ascension",author:"Park Ji-Ho",origin:"KR",genre_tags:["Action","Sports"],chapters:89,rating:4.7,views:"3.3M",langs:44,status:"ongoing",cover_color:"#2a1e00"},
];
const GENRES  = ["All","Action","Fantasy","Romance","Sci-fi","Drama","Mystery","Historical","Sports","Thriller"];
const ORIGINS = ["All","JP","KR","CN","GL"];
const LANGS   = ["English","Korean","Japanese","Spanish","French","Arabic","Portuguese","German","Hindi","Chinese"];
const SEEDS   = ["A disgraced knight whose sword is haunted by its victims","Two rival healers compete to save a dying kingdom","A girl who sees 10 seconds into the future enters a death game","The last demon hunter falls in love with their target","A failed chef reincarnated as a food critic in a fantasy world","A street artist whose graffiti comes to life at midnight"];
const EMOJIS  = ["⚔️","🌸","🔮","🐉","🏙️","🌙","⚡","🌊","🔥","🌺","👁️","🗡️"];
const COVERS  = ["#3d0d2e","#1a0d3e","#0a2a1a","#2a1e00","#002040","#2a0a1a"];
const rndEmoji = () => EMOJIS[Math.floor(Math.random()*EMOJIS.length)];
const rndCover = () => COVERS[Math.floor(Math.random()*COVERS.length)];

// ═══════════════════════════════════════════════════════════════
// SHARED UI COMPONENTS
// ═══════════════════════════════════════════════════════════════
const Tag = ({c=C.purple, children, sx={}}) => <span style={{fontSize:10,padding:"2px 8px",borderRadius:99,background:c+"22",color:c,border:`0.5px solid ${c}44`,fontWeight:500,whiteSpace:"nowrap",...sx}}>{children}</span>;

const Btn = ({children,onClick,v="ghost",disabled,type="button",sx={}}) => {
  const vs = { ghost:{bg:"transparent",bd:`0.5px solid ${C.border2}`,cl:C.muted}, pri:{bg:`linear-gradient(135deg,${C.purple},${C.pink})`,bd:"none",cl:"#fff"}, soft:{bg:C.purple+"22",bd:`0.5px solid ${C.purple}44`,cl:C.purpleL}, teal:{bg:C.teal+"18",bd:`0.5px solid ${C.teal}44`,cl:C.teal} };
  const s = vs[v]||vs.ghost;
  return <button type={type} onClick={onClick} disabled={disabled} style={{padding:"7px 16px",borderRadius:8,fontSize:12,cursor:disabled?"default":"pointer",fontFamily:"inherit",fontWeight:500,transition:"all .15s",opacity:disabled?.5:1,background:s.bg,border:s.bd,color:s.cl,...sx}}>{children}</button>;
};

const Field = ({label,value}) => value ? <div style={{marginBottom:9}}><div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:2}}>{label}</div><div style={{fontSize:12,color:C.text,lineHeight:1.65}}>{value}</div></div> : null;

const Sec = ({title,accent=C.purple,children}) => <div style={{marginBottom:16}}><div style={{display:"flex",alignItems:"center",gap:7,marginBottom:8}}><div style={{width:3,height:14,borderRadius:99,background:accent}}/><span style={{fontSize:12,fontWeight:500,color:C.text}}>{title}</span></div>{children}</div>;

const Spinner = ({size=16}) => <svg width={size} height={size} viewBox="0 0 16 16" style={{animation:"spin .8s linear infinite",flexShrink:0}}><circle cx="8" cy="8" r="6" fill="none" stroke={C.purple} strokeWidth="2" strokeDasharray="20 8" strokeLinecap="round"/><style>{`@keyframes spin{to{transform:rotate(360deg)}}@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style></svg>;

const Toast = ({msg,type="ok",onDone}) => {
  useEffect(()=>{ const t=setTimeout(onDone,3200); return ()=>clearTimeout(t); },[]);
  const col = type==="err"?"#e24b4a":type==="warn"?C.gold:C.teal;
  return <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:C.card,border:`0.5px solid ${col}`,borderRadius:10,padding:"10px 20px",fontSize:13,color:C.text,zIndex:999,animation:"fadeUp .2s ease",display:"flex",alignItems:"center",gap:9,maxWidth:440,boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}><span style={{color:col,fontSize:14}}>{type==="err"?"✕":"✓"}</span>{msg}</div>;
};

const CoverCard = ({item,onClick,aiMade}) => (
  <div onClick={onClick} style={{cursor:"pointer",borderRadius:10,overflow:"hidden",border:`0.5px solid ${C.border}`,background:C.card,transition:"transform .15s,border-color .15s"}}
    onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-3px)";e.currentTarget.style.borderColor=C.border2;}}
    onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.borderColor=C.border;}}>
    <div style={{height:130,background:item.cover_color||rndCover(),display:"flex",alignItems:"center",justifyContent:"center",fontSize:44,position:"relative"}}>
      {item.emoji||"📖"}
      {aiMade && <div style={{position:"absolute",top:7,left:7}}><Tag c={C.purple}>✦ AI</Tag></div>}
      <div style={{position:"absolute",top:7,right:7}}><Tag c={item.status==="completed"||item.status==="published"?C.teal:C.gold}>{item.status||"ongoing"}</Tag></div>
    </div>
    <div style={{padding:"10px 12px"}}>
      <div style={{fontSize:13,fontWeight:500,color:C.text,marginBottom:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{item.title}</div>
      <div style={{fontSize:11,color:C.muted,marginBottom:6}}>{item.author_name||item.author||"—"}</div>
      <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:7}}>{(item.genre_tags||[]).slice(0,2).map(g=><Tag key={g} c={C.dim} sx={{color:C.muted}}>{g}</Tag>)}</div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:C.muted}}><span>⭐ {item.rating||"—"}</span><span>{item.chapters||0} ch</span><span>🌐 {item.langs||1}</span></div>
    </div>
  </div>
);

// ═══════════════════════════════════════════════════════════════
// AUTH MODAL
// ═══════════════════════════════════════════════════════════════
const AuthModal = ({onAuth, onClose}) => {
  const [mode,setMode] = useState("login");
  const [email,setEmail]=useState(""); const [pw,setPw]=useState(""); const [uname,setUname]=useState("");
  const [loading,setLoading]=useState(false); const [err,setErr]=useState("");

  const submit = async e => {
    e.preventDefault(); setErr(""); setLoading(true);
    try {
      const session = mode==="signup" ? await signUp(email,pw,uname) : await signIn(email,pw);
      onAuth(session);
    } catch(e){ setErr(e.message); } finally { setLoading(false); }
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:C.surf,border:`0.5px solid ${C.border2}`,borderRadius:16,padding:"28px 32px",width:380,animation:"fadeUp .2s ease"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:22}}>
          <div style={{width:32,height:32,borderRadius:8,background:`linear-gradient(135deg,${C.purple},${C.pink})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>✦</div>
          <div style={{fontFamily:"'Cinzel',serif",fontSize:16,fontWeight:700}}>Manga<span style={{color:C.purple}}>Verse</span></div>
        </div>
        <div style={{display:"flex",gap:0,marginBottom:20,background:C.card,borderRadius:9,padding:3}}>
          {["login","signup"].map(m=><button key={m} onClick={()=>{setMode(m);setErr("");}} style={{flex:1,padding:"7px 0",borderRadius:7,fontSize:12,border:"none",background:mode===m?C.purple:"transparent",color:mode===m?"#fff":C.muted,cursor:"pointer",fontFamily:"inherit",fontWeight:mode===m?500:400}}>{m==="login"?"Sign in":"Create account"}</button>)}
        </div>
        {DEMO && <div style={{padding:"8px 12px",borderRadius:7,background:C.gold+"18",border:`0.5px solid ${C.gold}44`,marginBottom:14,fontSize:11,color:C.gold}}>⚡ Demo mode — any email & password works</div>}
        <form onSubmit={submit}>
          {mode==="signup" && <div style={{marginBottom:12}}><div style={{fontSize:11,color:C.muted,marginBottom:4,textTransform:"uppercase",letterSpacing:"0.06em"}}>Username</div><input value={uname} onChange={e=>setUname(e.target.value)} placeholder="your_username" required style={{width:"100%",padding:"9px 12px",borderRadius:8,border:`0.5px solid ${C.border2}`,background:C.card,color:C.text,fontSize:13,fontFamily:"inherit",outline:"none"}}/></div>}
          <div style={{marginBottom:12}}><div style={{fontSize:11,color:C.muted,marginBottom:4,textTransform:"uppercase",letterSpacing:"0.06em"}}>Email</div><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" required autoComplete="email" style={{width:"100%",padding:"9px 12px",borderRadius:8,border:`0.5px solid ${C.border2}`,background:C.card,color:C.text,fontSize:13,fontFamily:"inherit",outline:"none"}}/></div>
          <div style={{marginBottom:14}}><div style={{fontSize:11,color:C.muted,marginBottom:4,textTransform:"uppercase",letterSpacing:"0.06em"}}>Password</div><input type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="••••••••" required autoComplete={mode==="signup"?"new-password":"current-password"} style={{width:"100%",padding:"9px 12px",borderRadius:8,border:`0.5px solid ${C.border2}`,background:C.card,color:C.text,fontSize:13,fontFamily:"inherit",outline:"none"}}/></div>
          {err && <div style={{fontSize:12,color:"#e24b4a",padding:"7px 10px",background:"#e24b4a18",borderRadius:7,marginBottom:12}}>{err}</div>}
          <Btn type="submit" v="pri" disabled={loading} sx={{width:"100%",padding:"10px 0",fontSize:13}}>{loading?<Spinner size={14}/>:mode==="login"?"Sign in →":"Create account →"}</Btn>
        </form>
        <button onClick={onClose} style={{display:"block",width:"100%",marginTop:12,padding:"7px 0",background:"transparent",border:"none",color:C.muted,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Continue as guest</button>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// PUBLISH MODAL
// ═══════════════════════════════════════════════════════════════
const PublishModal = ({story, onPublish, onClose, saving}) => {
  const [autoLangs,setAuto] = useState(["Spanish","French","German","Portuguese"]);
  const tog = l => setAuto(p => p.includes(l)?p.filter(x=>x!==l):[...p,l]);
  const checks = [[true,"Story concept generated"],[!!story.script,"Chapter 1 script written"],[!!story.character_brief,"Character design brief created"],[true,"Original language set (English)"]];
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:C.surf,border:`0.5px solid ${C.border2}`,borderRadius:16,padding:"24px 28px",width:"100%",maxWidth:540,animation:"fadeUp .2s ease",maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
          <div style={{fontSize:15,fontWeight:500}}>✦ Publish to MangaVerse</div>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:C.muted,cursor:"pointer",fontSize:20,lineHeight:1}}>×</button>
        </div>
        {/* Preview */}
        <div style={{display:"flex",gap:14,padding:14,background:C.card,borderRadius:10,border:`0.5px solid ${C.border}`,marginBottom:18}}>
          <div style={{width:66,height:90,borderRadius:8,background:story.cover_color||rndCover(),display:"flex",alignItems:"center",justifyContent:"center",fontSize:30,flexShrink:0}}>{story.emoji||"📖"}</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:14,fontWeight:500,color:C.text,marginBottom:3}}>{story.title}</div>
            <div style={{fontSize:11,color:C.muted,fontStyle:"italic",marginBottom:8,lineHeight:1.5}}>{story.tagline}</div>
            <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>{(story.genre_tags||[]).map(g=><Tag key={g} c={C.purple}>{g}</Tag>)}</div>
          </div>
        </div>
        {/* Checklist */}
        <div style={{marginBottom:18}}>
          <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:10}}>Checklist</div>
          {checks.map(([done,label],i)=><div key={i} style={{display:"flex",alignItems:"center",gap:9,padding:"7px 0",borderBottom:`0.5px solid ${C.border}`,fontSize:12}}><span style={{fontSize:14,color:done?C.teal:C.muted}}>{done?"✓":"○"}</span><span style={{color:done?C.text:C.muted,flex:1}}>{label}</span>{!done&&<Tag c={C.gold}>Optional</Tag>}</div>)}
        </div>
        {/* Language picker */}
        <div style={{marginBottom:20}}>
          <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:8}}>Auto-translate to (AI handles these on publish)</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {LANGS.filter(l=>l!=="English").map(l=><button key={l} onClick={()=>tog(l)} style={{fontSize:11,padding:"4px 10px",borderRadius:7,border:`0.5px solid ${autoLangs.includes(l)?C.purple:C.border}`,background:autoLangs.includes(l)?C.purple+"22":"transparent",color:autoLangs.includes(l)?C.purpleL:C.muted,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>)}
          </div>
          <div style={{fontSize:11,color:C.muted,marginTop:7}}>+ {autoLangs.length} language{autoLangs.length!==1?"s":""} selected — story will be live in all of them</div>
        </div>
        <div style={{display:"flex",gap:10}}>
          <Btn onClick={onClose} sx={{flex:1}}>Cancel</Btn>
          <Btn v="pri" onClick={()=>onPublish(autoLangs)} disabled={saving} sx={{flex:2,justifyContent:"center"}}>{saving?<><Spinner size={13}/>Publishing…</>:"✦ Publish to library →"}</Btn>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// AI STUDIO
// ═══════════════════════════════════════════════════════════════
const Studio = ({user, drafts, onSave, onRequestAuth}) => {
  const [step,setStep]     = useState("seed");
  const [seed,setSeed]     = useState("");
  const [genre,setGenre]   = useState("Dark fantasy");
  const [tone,setTone]     = useState("Gritty & intense");
  const [stream,setStream] = useState("");
  const [story,setStory]   = useState(null);
  const [script,setScript] = useState(null);
  const [cb,setCb]         = useState(null); // character brief
  const [loading,setLoad]  = useState(false);
  const [tab,setTab]       = useState("concept");
  const [showPub,setShowPub]= useState(false);
  const [publishing,setPub] = useState(false);
  const [toast,setToast]   = useState(null);
  const [tool,setTool]     = useState("story");
  const ref                = useRef(null);

  useEffect(()=>{ if(stream) ref.current?.scrollIntoView({behavior:"smooth"}); },[stream]);

  const gen = async (prompt, done) => { setLoad(true); setStream(""); const r = await askClaude(prompt,setStream); setLoad(false); if(r) done(r); };
  const genStory  = () => { if(!seed.trim()) return; setStep("gen"); setStory(null); setScript(null); setCb(null); gen(P_STORY(seed,genre,tone), r=>{setStory({...r,emoji:rndEmoji(),cover_color:rndCover()}); setStep("story"); setTab("concept");}); };
  const genScript = () => { setTab("script"); gen(P_SCRIPT(story), r=>setScript(r)); };
  const genChar   = () => { setTab("char");   gen(P_CHAR(story),   r=>setCb(r)); };
  const reset     = () => { setStep("seed"); setSeed(""); setStory(null); setScript(null); setCb(null); setStream(""); };

  const save = async () => {
    if (!user) { onRequestAuth(); return; }
    const s = await onSave({...story, script, character_brief:cb, status:"draft", author_name:user.username});
    setStory(prev => ({...prev, id:s.id}));
    setToast({msg:"Draft saved ✓",type:"ok"});
  };

  const publish = async (langs) => {
    setPub(true);
    try {
      await onSave({...story, script, character_brief:cb, status:"published", author_name:user?.username||"Anonymous", langs:1+langs.length, published_at:new Date().toISOString()});
      setShowPub(false);
      setToast({msg:`"${story.title}" is live in the library 🎉`,type:"ok"});
    } catch(e){ setToast({msg:"Publish failed: "+e.message,type:"err"}); }
    finally{ setPub(false); }
  };

  const TOOLS=[{id:"story",icon:"✦",name:"Story generator",desc:"Full concept from one sentence"},{id:"scene",icon:"◎",name:"Scene writer",desc:"Panel-ready scripts"},{id:"dialogue",icon:"❝",name:"Dialogue coach",desc:"Sharpen voices"},{id:"char",icon:"◈",name:"Character forge",desc:"Design & rules"},{id:"world",icon:"⬡",name:"World builder",desc:"Lore, magic, factions"},{id:"plot",icon:"≋",name:"Plot planner",desc:"Arcs & breakdowns"}];

  if(step==="seed") return (
    <div style={{maxWidth:700,margin:"0 auto"}}>
      {toast&&<Toast msg={toast.msg} type={toast.type} onDone={()=>setToast(null)}/>}
      <div style={{textAlign:"center",marginBottom:22}}><div style={{fontSize:20,fontWeight:700,fontFamily:"'Cinzel',serif",marginBottom:5}}>AI story studio</div><div style={{fontSize:13,color:C.muted}}>One sentence → full concept, panel script, character brief.</div></div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:18}}>
        {TOOLS.map(t=><div key={t.id} onClick={()=>setTool(t.id)} style={{padding:"10px 12px",borderRadius:9,border:`0.5px solid ${tool===t.id?C.purple:C.border}`,background:tool===t.id?C.purple+"18":C.card,cursor:"pointer",transition:"all .12s"}}><div style={{fontSize:15,marginBottom:3}}>{t.icon}</div><div style={{fontSize:12,fontWeight:500,color:tool===t.id?C.purpleL:C.text}}>{t.name}</div><div style={{fontSize:10,color:C.muted}}>{t.desc}</div></div>)}
      </div>
      <div style={{background:C.card,border:`0.5px solid ${C.border2}`,borderRadius:12,padding:18,marginBottom:14}}>
        <textarea value={seed} onChange={e=>setSeed(e.target.value)} placeholder="A disgraced knight whose sword is haunted by its victims..." rows={3} style={{width:"100%",background:"transparent",border:"none",outline:"none",color:C.text,fontSize:14,lineHeight:1.7,resize:"none",fontFamily:"'DM Sans',sans-serif"}}/>
        <div style={{display:"flex",gap:6,marginTop:10,flexWrap:"wrap"}}>
          {SEEDS.map(ex=><button key={ex} onClick={()=>setSeed(ex)} style={{fontSize:10,padding:"3px 9px",borderRadius:99,background:"transparent",border:`0.5px solid ${C.dim}`,color:C.muted,cursor:"pointer",fontFamily:"inherit"}}>{ex.slice(0,42)}…</button>)}
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        {[{label:"Genre",opts:["Dark fantasy","Shonen action","Romantic comedy","Psychological thriller","Isekai","Slice of life","Sci-fi","Historical"],val:genre,set:setGenre},{label:"Tone",opts:["Gritty & intense","Light & fun","Emotional & bittersweet","Epic & grand","Mysterious","Hopeful","Dark & complex"],val:tone,set:setTone}].map(({label,opts,val,set})=>(
          <div key={label}><div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:7}}>{label}</div><div style={{display:"flex",flexWrap:"wrap",gap:5}}>{opts.map(o=><button key={o} onClick={()=>set(o)} style={{fontSize:11,padding:"4px 10px",borderRadius:7,border:`0.5px solid ${val===o?C.purple:C.border}`,background:val===o?C.purple+"22":"transparent",color:val===o?C.purpleL:C.muted,cursor:"pointer",fontFamily:"inherit"}}>{o}</button>)}</div></div>
        ))}
      </div>
      <button onClick={genStory} disabled={!seed.trim()} style={{width:"100%",padding:"13px 0",borderRadius:10,border:"none",background:seed.trim()?`linear-gradient(135deg,${C.purple},${C.pink})`:C.dim,color:"#fff",fontSize:14,fontWeight:500,cursor:seed.trim()?"pointer":"default",fontFamily:"'Cinzel',serif",letterSpacing:"0.04em"}}>✦ Generate story concept</button>
      {drafts.length>0&&<div style={{marginTop:22}}><div style={{fontSize:11,color:C.muted,marginBottom:8}}>Your drafts</div>{drafts.map(s=><div key={s.id} onClick={()=>{setStory(s);setScript(s.script||null);setCb(s.character_brief||null);setStep("story");setTab("concept");}} style={{padding:"10px 14px",border:`0.5px solid ${C.border}`,borderRadius:9,cursor:"pointer",background:C.card,marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}} onMouseEnter={e=>e.currentTarget.style.borderColor=C.purple} onMouseLeave={e=>e.currentTarget.style.borderColor=C.border}><div><div style={{fontSize:13,fontWeight:500,color:C.text}}>{s.title}</div><div style={{fontSize:11,color:C.muted}}>{s.tagline}</div></div><Tag c={C.gold}>Draft</Tag></div>)}</div>}
    </div>
  );

  if(step==="gen") return (
    <div style={{maxWidth:640,margin:"0 auto",paddingTop:20}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,justifyContent:"center"}}><Spinner size={18}/><span style={{fontSize:13,color:C.muted}}>Crafting your story…</span></div>
      <div style={{background:C.card,border:`0.5px solid ${C.border}`,borderRadius:12,padding:16,fontFamily:"monospace",fontSize:11,color:C.muted,lineHeight:1.8,maxHeight:380,overflow:"auto",whiteSpace:"pre-wrap"}}>{stream||"Waiting…"}<div ref={ref}/></div>
    </div>
  );

  const tabs = [{id:"concept",label:"Story"},...(script?[{id:"script",label:"Script"}]:[]),...(!script&&!loading?[{id:"gs",label:"✦ Write script",fn:genScript}]:[]),...(cb?[{id:"char",label:"Characters"}]:[]),...(!cb&&!loading?[{id:"gc",label:"✦ Design character",fn:genChar}]:[])];

  return (
    <div style={{animation:"fadeUp .2s ease"}}>
      {toast&&<Toast msg={toast.msg} type={toast.type} onDone={()=>setToast(null)}/>}
      {showPub&&<PublishModal story={story} onPublish={publish} onClose={()=>setShowPub(false)} saving={publishing}/>}
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:16,gap:12}}>
        <div style={{minWidth:0}}><div style={{fontSize:20,fontWeight:700,fontFamily:"'Cinzel',serif",marginBottom:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{story?.title}</div><div style={{fontSize:13,color:C.muted,fontStyle:"italic"}}>{story?.tagline}</div><div style={{display:"flex",gap:5,marginTop:7,flexWrap:"wrap"}}>{story?.genre_tags?.map(t=><Tag key={t} c={C.purple}>{t}</Tag>)}</div></div>
        <div style={{display:"flex",gap:7,flexShrink:0,flexWrap:"wrap",justifyContent:"flex-end"}}>
          <Btn v="teal" onClick={save}>✓ Save</Btn>
          {user&&<Btn v="pri" onClick={()=>setShowPub(true)}>✦ Publish →</Btn>}
          <Btn onClick={reset}>← New</Btn>
        </div>
      </div>
      <div style={{display:"flex",borderBottom:`0.5px solid ${C.border}`,marginBottom:18}}>
        {tabs.map(t=><button key={t.id} onClick={()=>{if(t.fn)t.fn();else setTab(t.id);}} style={{padding:"8px 14px",fontSize:12,border:"none",borderBottom:tab===t.id?`2px solid ${C.purple}`:"2px solid transparent",background:"transparent",color:tab===t.id?C.purple:t.label.startsWith("✦")?C.pink:C.muted,cursor:"pointer",fontFamily:"inherit",fontWeight:tab===t.id?500:400}}>{t.label}</button>)}
      </div>
      {loading&&<div style={{display:"flex",alignItems:"center",gap:10,padding:"20px 0"}}><Spinner/><span style={{color:C.muted,fontSize:13}}>Generating…</span></div>}

      {tab==="concept"&&story&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          <div>
            <Sec title="Premise" accent={C.purple}><div style={{background:C.card,borderRadius:9,padding:12,border:`0.5px solid ${C.border}`}}><Field label="Logline" value={story.logline}/><Field label="Central conflict" value={story.central_conflict}/>{story.themes&&<div style={{display:"flex",gap:5,marginTop:6}}>{story.themes.map(t=><Tag key={t} c={C.teal}>{t}</Tag>)}</div>}</div></Sec>
            <Sec title="World" accent={C.gold}><div style={{background:C.card,borderRadius:9,padding:12,border:`0.5px solid ${C.border}`}}><Field label={story.setting?.world} value={story.setting?.description}/><Field label="Unique element" value={story.setting?.unique_element}/></div></Sec>
            <Sec title="3-act arc" accent={C.pink}>{story.story_arc?.map(a=><div key={a.act} style={{marginBottom:7,padding:"8px 10px",background:C.card,borderRadius:8,border:`0.5px solid ${C.border}`}}><div style={{fontSize:10,color:C.pink,fontWeight:500,marginBottom:3}}>{a.act}</div><div style={{fontSize:11,color:C.muted,lineHeight:1.6}}>{a.beats}</div></div>)}</Sec>
            <Sec title="Chapter 1 hook" accent={C.gold}><div style={{fontSize:12,color:C.text,lineHeight:1.7,padding:"9px 12px",background:C.card,borderRadius:8,borderLeft:`3px solid ${C.gold}`}}>{story.chapter_one_hook}</div></Sec>
          </div>
          <div>
            <Sec title="Protagonist" accent={C.purple}><div style={{background:C.card,borderRadius:9,padding:12,border:`0.5px solid ${C.border}`}}><div style={{fontSize:14,fontWeight:500,marginBottom:8,color:C.text}}>{story.protagonist?.name}<span style={{fontSize:11,color:C.muted,fontWeight:400}}> · {story.protagonist?.age}</span></div><Field label="Appearance" value={story.protagonist?.appearance}/><Field label="Personality" value={story.protagonist?.personality}/><Field label="Inner wound" value={story.protagonist?.wound}/><Field label="Wants" value={story.protagonist?.goal}/><Field label="Actually needs" value={story.protagonist?.need}/></div></Sec>
            <Sec title="Antagonist" accent={C.pink}><div style={{background:C.card,borderRadius:9,padding:12,border:`0.5px solid ${C.border}`}}><div style={{fontSize:14,fontWeight:500,marginBottom:8,color:C.text}}>{story.antagonist?.name}</div><Field label="Role" value={story.antagonist?.role}/><Field label="Motivation" value={story.antagonist?.motivation}/><Field label="Mirrors protagonist" value={story.antagonist?.mirror}/></div></Sec>
            {story.support_characters?.map(c=><div key={c.name} style={{marginBottom:6,padding:"8px 10px",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8}}><span style={{fontSize:12,fontWeight:500,color:C.text}}>{c.name}</span><span style={{fontSize:11,color:C.muted}}> · {c.role}</span><div style={{fontSize:11,color:C.muted,marginTop:2}}>{c.hook}</div></div>)}
            <Sec title="Visual style" accent={C.muted}><div style={{fontSize:12,color:C.muted,lineHeight:1.7,fontStyle:"italic"}}>{story.visual_style_notes}</div></Sec>
          </div>
        </div>
      )}

      {tab==="script"&&script&&(
        <div>
          <div style={{marginBottom:14}}><div style={{fontSize:15,fontWeight:500,color:C.text}}>{script.chapter_title}</div><div style={{fontSize:12,color:C.muted,marginTop:3}}>{script.chapter_summary}</div></div>
          {script.panels?.map(p=>{
            const tc={speech:C.purple,thought:C.teal,narration:C.gold,sfx:C.pink};
            return <div key={p.number} style={{border:`0.5px solid ${C.border}`,borderRadius:10,overflow:"hidden",marginBottom:8}}>
              <div style={{padding:"7px 12px",background:C.surf,borderBottom:`0.5px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}><div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:11,fontWeight:500,color:C.purple}}>Panel {p.number}</span><Tag c={C.dim}>{p.panel_type}</Tag></div><span style={{fontSize:11,color:C.muted}}>{p.mood}</span></div>
              <div style={{padding:12}}><div style={{fontSize:12,color:C.muted,fontStyle:"italic",marginBottom:9,lineHeight:1.6}}>{p.composition} — {p.scene_description}</div>{p.dialogue?.map((d,i)=>{const dc=tc[d.type]||C.muted;return <div key={i} style={{display:"flex",gap:8,marginBottom:5,padding:"5px 8px",borderRadius:6,background:dc+"11",borderLeft:`2px solid ${dc}`}}><span style={{fontSize:10,fontWeight:500,color:dc,minWidth:60,flexShrink:0}}>{d.character}</span><span style={{fontSize:12,color:C.text,lineHeight:1.5}}>"{d.text}"</span></div>;})} {p.visual_notes&&<div style={{fontSize:11,color:C.muted,marginTop:6,padding:"4px 8px",background:C.surf,borderRadius:5}}>✦ {p.visual_notes}</div>}</div>
            </div>;
          })}
          {script.chapter_end_hook&&<div style={{padding:"10px 14px",background:C.card,borderRadius:9,borderLeft:`3px solid ${C.pink}`,marginTop:8}}><div style={{fontSize:10,color:C.pink,fontWeight:500,marginBottom:3}}>End hook</div><div style={{fontSize:12,color:C.text,lineHeight:1.65}}>{script.chapter_end_hook}</div></div>}
        </div>
      )}

      {tab==="char"&&cb?.design_brief&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          <div>
            <Sec title="Physical design" accent={C.purple}><div style={{background:C.card,borderRadius:9,padding:12,border:`0.5px solid ${C.border}`}}>{["body_type","face","eyes","hair","signature_accessory"].map(k=><Field key={k} label={k.replace(/_/g," ")} value={cb.design_brief[k]}/>)}</div></Sec>
            <Sec title="Outfits" accent={C.gold}><Field label="Default" value={cb.design_brief.default_outfit}/><Field label="Battle" value={cb.design_brief.battle_outfit}/></Sec>
            <Sec title="Color palette" accent={C.pink}>{cb.design_brief.color_palette?.map((c,i)=>{const[hex,...r]=c.split(" — ");return <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}><div style={{width:18,height:18,borderRadius:4,background:hex,border:`0.5px solid ${C.border}`,flexShrink:0}}/><span style={{fontSize:11,color:C.muted}}>{hex} — {r.join(" — ")}</span></div>;})}</Sec>
          </div>
          <div>
            <Sec title="Expressions" accent={C.teal}>{cb.design_brief.expression_range&&Object.entries(cb.design_brief.expression_range).map(([k,v])=><div key={k} style={{marginBottom:6,padding:"6px 10px",background:C.card,borderRadius:7,border:`0.5px solid ${C.border}`}}><div style={{fontSize:10,fontWeight:500,color:C.teal,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>{k}</div><div style={{fontSize:11,color:C.muted}}>{v}</div></div>)}</Sec>
            <Sec title="Consistency rules" accent={C.gold}>{cb.design_brief.consistency_rules?.map((r,i)=><div key={i} style={{display:"flex",gap:6,marginBottom:5,fontSize:11,color:C.muted,lineHeight:1.5}}><span style={{color:C.gold}}>✓</span>{r}</div>)}</Sec>
            <Sec title="Do not" accent={C.pink}>{cb.design_brief.do_not?.map((r,i)=><div key={i} style={{display:"flex",gap:6,marginBottom:5,fontSize:11,color:C.muted,lineHeight:1.5}}><span style={{color:C.pink}}>✗</span>{r}</div>)}</Sec>
            <Field label="Movement" value={cb.design_brief.how_they_move}/><Field label="Visual arc" value={cb.visual_arc}/>
          </div>
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════════
export default function MangaVerse() {
  const [page,setPage]       = useState("home");
  const [auth,setAuth]       = useState(null);
  const [showAuth,setShowAuth] = useState(false);
  const [fG,setFG]           = useState("All");
  const [fO,setFO]           = useState("All");
  const [q,setQ]             = useState("");
  const [sel,setSel]         = useState(null);
  const [reading,setReading] = useState(null);
  const [toast,setToast]     = useState(null);

  const db = useDB(auth?.token, auth?.user?.id);

  const published = db.stories.filter(s=>s.status==="published");
  const all = [...SEED_LIB, ...published];
  const filtered = all.filter(s=>{
    if(fG!=="All"&&!(s.genre_tags||[]).includes(fG)) return false;
    if(fO!=="All"&&s.origin!==fO) return false;
    if(q&&!s.title.toLowerCase().includes(q.toLowerCase())&&!(s.author||s.author_name||"").toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const onAuth = s => { setAuth(s); setShowAuth(false); setToast({msg:`Welcome, ${s.user.username||s.user.email}! 👋`,type:"ok"}); };
  const onSignOut = () => { setAuth(null); setToast({msg:"Signed out",type:"ok"}); };
  const onSaveStory = async story => { if(!auth){ setShowAuth(true); throw new Error("Not signed in"); } return db.upsert({...story,author_name:auth.user.username}); };

  const NAV = [{id:"home",label:"Discover"},{id:"library",label:"Library"},{id:"studio",label:"✦ AI Studio"},{id:"creator",label:"Creator"}];

  const go = id => { setPage(id); setSel(null); setReading(null); };

  return (
    <div style={{background:C.bg,minHeight:"100vh",color:C.text,fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:14}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&family=Cinzel:wght@500;700&display=swap" rel="stylesheet"/>
      {toast&&<Toast msg={toast.msg} type={toast.type} onDone={()=>setToast(null)}/>}
      {showAuth&&<AuthModal onAuth={onAuth} onClose={()=>setShowAuth(false)}/>}

      {/* NAV */}
      <div style={{borderBottom:`0.5px solid ${C.border}`,background:C.surf,position:"sticky",top:0,zIndex:40}}>
        <div style={{maxWidth:1100,margin:"0 auto",padding:"0 20px",display:"flex",alignItems:"center"}}>
          <div style={{display:"flex",alignItems:"center",gap:9,marginRight:24,padding:"12px 0",cursor:"pointer"}} onClick={()=>go("home")}>
            <div style={{width:30,height:30,borderRadius:8,background:`linear-gradient(135deg,${C.purple},${C.pink})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>✦</div>
            <span style={{fontFamily:"'Cinzel',serif",fontSize:15,fontWeight:700,letterSpacing:"0.03em"}}>Manga<span style={{color:C.purple}}>Verse</span></span>
          </div>
          <div style={{display:"flex",flex:1}}>
            {NAV.map(n=><button key={n.id} onClick={()=>go(n.id)} style={{padding:"14px 15px",fontSize:13,border:"none",borderBottom:`2px solid ${page===n.id?C.purple:"transparent"}`,background:"transparent",color:page===n.id?C.purple:n.id==="studio"?C.pink:C.muted,cursor:"pointer",fontFamily:"inherit",fontWeight:page===n.id?500:400,transition:"all .12s"}}>{n.label}</button>)}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {auth?(
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:C.purple,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:500,color:"#fff"}}>{String(auth.user.username||auth.user.email)[0].toUpperCase()}</div>
                <span style={{fontSize:12,color:C.muted}}>{auth.user.username}</span>
                <Btn onClick={onSignOut} sx={{fontSize:11,padding:"4px 10px"}}>Sign out</Btn>
              </div>
            ):<Btn v="soft" onClick={()=>setShowAuth(true)} sx={{fontSize:12}}>Sign in</Btn>}
          </div>
        </div>
      </div>

      <div style={{maxWidth:1100,margin:"0 auto",padding:"24px 20px"}}>

        {/* HOME */}
        {page==="home"&&!sel&&!reading&&(
          <div>
            <div style={{marginBottom:36,paddingTop:8}}>
              <div style={{fontSize:34,fontWeight:700,fontFamily:"'Cinzel',serif",letterSpacing:"0.03em",marginBottom:10,lineHeight:1.2}}>Read. Create. <span style={{color:C.purple}}>Translate.</span></div>
              <div style={{fontSize:15,color:C.muted,maxWidth:500,lineHeight:1.7,marginBottom:20}}>The global platform for manga, manhwa & manhua — with built-in AI tools to take you from blank page to published story.</div>
              <div style={{display:"flex",gap:10}}><Btn v="pri" onClick={()=>go("library")} sx={{padding:"10px 24px",fontSize:14}}>Browse library →</Btn><Btn v="soft" onClick={()=>go("studio")} sx={{padding:"10px 24px",fontSize:14}}>✦ Start creating</Btn></div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:32}}>
              {[["2,441+","Stories published"],["186K","Active readers"],["30","Languages"],["4.1M","Translations done"]].map(([v,l])=><div key={l} style={{background:C.card,borderRadius:10,padding:"14px 16px",border:`0.5px solid ${C.border}`}}><div style={{fontSize:22,fontWeight:500}}>{v}</div><div style={{fontSize:11,color:C.muted,marginTop:2}}>{l}</div></div>)}
            </div>
            <div style={{marginBottom:28}}><div style={{fontSize:13,fontWeight:500,marginBottom:12}}>Trending now</div><div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>{SEED_LIB.slice(0,4).map(item=><CoverCard key={item.id} item={item} onClick={()=>{setSel(item);setPage("library");}}/>)}</div></div>
            {published.length>0&&<div style={{marginBottom:28}}><div style={{fontSize:13,fontWeight:500,marginBottom:12}}>New from creators ✦ AI-assisted</div><div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>{published.slice(0,4).map(item=><CoverCard key={item.id} item={item} aiMade onClick={()=>{setSel(item);setPage("library");}}/>)}</div></div>}
            <div style={{padding:"20px 24px",borderRadius:12,border:`0.5px solid ${C.purple}44`,background:C.purple+"0a",display:"flex",alignItems:"center",justifyContent:"space-between",gap:20}}><div><div style={{fontSize:14,fontWeight:500,marginBottom:4}}>✦ AI story studio — private beta</div><div style={{fontSize:12,color:C.muted}}>Go from blank page to full story concept, panel script & character design in minutes.</div></div><Btn v="pri" onClick={()=>go("studio")} sx={{flexShrink:0}}>Try it free →</Btn></div>
          </div>
        )}

        {/* LIBRARY */}
        {page==="library"&&!reading&&(
          <div>
            {sel?(
              <div style={{animation:"fadeUp .2s ease"}}>
                <button onClick={()=>setSel(null)} style={{background:"transparent",border:"none",color:C.muted,cursor:"pointer",fontSize:12,padding:"0 0 16px",fontFamily:"inherit"}}>← Back to library</button>
                <div style={{display:"grid",gridTemplateColumns:"160px 1fr",gap:20,marginBottom:22}}>
                  <div style={{height:220,borderRadius:12,background:sel.cover_color||rndCover(),display:"flex",alignItems:"center",justifyContent:"center",fontSize:64,border:`0.5px solid ${C.border}`}}>{sel.emoji||"📖"}</div>
                  <div>
                    <div style={{fontSize:20,fontWeight:700,fontFamily:"'Cinzel',serif",color:C.text,marginBottom:4}}>{sel.title}</div>
                    <div style={{fontSize:13,color:C.muted,marginBottom:8}}>by {sel.author_name||sel.author}</div>
                    {sel.tagline&&<div style={{fontSize:13,color:C.muted,fontStyle:"italic",marginBottom:10}}>{sel.tagline}</div>}
                    {sel.logline&&<div style={{fontSize:12,color:C.muted,lineHeight:1.7,marginBottom:12,padding:"9px 12px",background:C.card,borderRadius:8,borderLeft:`3px solid ${C.purple}`}}>{sel.logline}</div>}
                    <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>{(sel.genre_tags||[]).map(g=><Tag key={g} c={C.purple}>{g}</Tag>)}<Tag c={sel.status==="completed"||sel.status==="published"?C.teal:C.gold}>{sel.status}</Tag></div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:14}}>{[["Chapters",sel.chapters||0],["Rating",`⭐ ${sel.rating||"New"}`],["Reads",sel.views||"0"],["Languages",`🌐 ${sel.langs||1}`]].map(([l,v])=><div key={l} style={{background:C.surf,borderRadius:8,padding:"8px 10px",border:`0.5px solid ${C.border}`}}><div style={{fontSize:10,color:C.muted,marginBottom:2}}>{l}</div><div style={{fontSize:13,fontWeight:500,color:C.text}}>{v}</div></div>)}</div>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}><select style={{fontSize:12,padding:"6px 10px",borderRadius:7,border:`0.5px solid ${C.border}`,background:C.surf,color:C.text,fontFamily:"inherit"}}>{LANGS.slice(0,6).map(l=><option key={l}>{l}</option>)}</select><Btn v="pri" onClick={()=>setReading(sel)}>Read now →</Btn><Btn v="soft">+ Bookmark</Btn></div>
                  </div>
                </div>
                <div style={{fontSize:12,fontWeight:500,marginBottom:10}}>Chapters</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>{[1,2,3,4].map(n=><div key={n} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",border:`0.5px solid ${C.border}`,borderRadius:8,cursor:"pointer",background:C.card}} onMouseEnter={e=>e.currentTarget.style.borderColor=C.purple} onMouseLeave={e=>e.currentTarget.style.borderColor=C.border}><div style={{width:32,height:32,borderRadius:6,background:C.surf,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:C.muted,fontWeight:500}}>{n}</div><div style={{flex:1}}><div style={{fontSize:12,fontWeight:500,color:C.text}}>Chapter {n}</div><div style={{fontSize:10,color:C.muted}}>Available</div></div><Tag c={C.teal}>Read</Tag></div>)}</div>
              </div>
            ):(
              <div>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,flexWrap:"wrap"}}>
                  <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search series or author…" style={{flex:1,minWidth:180,padding:"8px 14px",borderRadius:8,border:`0.5px solid ${C.border2}`,background:C.card,color:C.text,fontSize:13,fontFamily:"inherit",outline:"none"}}/>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>{GENRES.map(g=><button key={g} onClick={()=>setFG(g)} style={{fontSize:11,padding:"5px 10px",borderRadius:7,border:`0.5px solid ${fG===g?C.purple:C.border}`,background:fG===g?C.purple+"22":"transparent",color:fG===g?C.purpleL:C.muted,cursor:"pointer",fontFamily:"inherit"}}>{g}</button>)}</div>
                  <div style={{display:"flex",gap:5}}>{ORIGINS.map(o=><button key={o} onClick={()=>setFO(o)} style={{fontSize:11,padding:"5px 10px",borderRadius:7,border:`0.5px solid ${fO===o?C.pink:C.border}`,background:fO===o?C.pink+"22":"transparent",color:fO===o?C.pink:C.muted,cursor:"pointer",fontFamily:"inherit"}}>{o}</button>)}</div>
                </div>
                <div style={{fontSize:11,color:C.muted,marginBottom:14}}>{filtered.length} series · {published.length} creator-published</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>{filtered.map(item=><CoverCard key={item.id} item={item} aiMade={!!item.author_name&&!item.author} onClick={()=>setSel(item)}/>)}</div>
              </div>
            )}
          </div>
        )}

        {/* READER */}
        {reading&&(
          <div style={{animation:"fadeUp .2s ease"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <button onClick={()=>{setReading(null);setSel(reading);}} style={{background:"transparent",border:"none",color:C.muted,cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>← Back</button>
              <div style={{fontSize:13,fontWeight:500,color:C.text}}>{reading.title} · Ch. 1</div>
              <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:11,color:C.muted}}>Language:</span><select style={{fontSize:12,padding:"4px 8px",borderRadius:6,border:`0.5px solid ${C.border}`,background:C.surf,color:C.text,fontFamily:"inherit"}}>{LANGS.slice(0,8).map(l=><option key={l}>{l}</option>)}</select></div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:3,maxWidth:440,margin:"0 auto"}}>
              {[{bg:"#1a0a1e",narr:"Three days after the burning. No one came.",speech:"So this is what remains of us."},{bg:"#2d1b4e",speech:"Why does my blade glow now?",sfx:"KRAK"},{bg:"#0f1a2e",narr:"300 years ago...",speech:"Our blood binds the realm."}].map((p,i)=>(
                <div key={i} style={{background:p.bg,borderRadius:i===0?"10px 10px 0 0":i===2?"0 0 10px 10px":"0",padding:"28px 24px",minHeight:150}}>
                  <div style={{fontSize:9,color:"rgba(255,255,255,0.3)",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:10}}>Panel {i+1}</div>
                  {p.narr&&<div style={{fontSize:12,color:"rgba(255,255,255,0.7)",fontStyle:"italic",marginBottom:8,lineHeight:1.6,padding:"6px 10px",borderLeft:`2px solid ${C.gold}`,background:"rgba(0,0,0,0.3)"}}>{p.narr}</div>}
                  {p.speech&&<div style={{fontSize:13,color:"#fff",lineHeight:1.6,padding:"8px 14px",background:"rgba(0,0,0,0.5)",borderRadius:6,borderLeft:`2px solid ${C.purple}`,marginBottom:6}}>"{p.speech}"</div>}
                  {p.sfx&&<div style={{fontSize:24,fontWeight:700,color:C.pink,letterSpacing:"0.1em",textAlign:"center",marginTop:8}}>{p.sfx}</div>}
                </div>
              ))}
            </div>
            <div style={{display:"flex",justifyContent:"center",gap:12,marginTop:16}}><Btn>← Prev</Btn><span style={{fontSize:12,color:C.muted,padding:"7px 0"}}>1 / {reading.chapters||1}</span><Btn>Next →</Btn></div>
          </div>
        )}

        {/* STUDIO */}
        {page==="studio"&&<Studio user={auth?.user} drafts={db.stories.filter(s=>s.status==="draft")} onSave={onSaveStory} onRequestAuth={()=>setShowAuth(true)}/>}

        {/* CREATOR */}
        {page==="creator"&&(
          <div>
            {!auth?(
              <div style={{textAlign:"center",padding:"60px 20px"}}>
                <div style={{fontSize:16,fontWeight:500,marginBottom:8}}>Creator dashboard</div>
                <div style={{fontSize:13,color:C.muted,marginBottom:20}}>Sign in or create a free account to access your creator workspace.</div>
                <Btn v="pri" onClick={()=>setShowAuth(true)} sx={{padding:"10px 28px",fontSize:14}}>Sign in to continue →</Btn>
              </div>
            ):(
              <div>
                <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:18}}>
                  <div><div style={{fontSize:16,fontWeight:500,marginBottom:2}}>Welcome back, {auth.user.username} 👋</div><div style={{fontSize:12,color:C.muted}}>{auth.user.credits||840} AI credits · {db.stories.length} total stories</div></div>
                  <Btn v="pri" onClick={()=>go("studio")}>✦ Open AI studio</Btn>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:22}}>
                  {[["Total stories",db.stories.length],["Published",published.length],["Drafts",db.stories.filter(s=>s.status==="draft").length],["AI credits",auth.user.credits||840]].map(([l,v])=><div key={l} style={{background:C.surf,borderRadius:9,padding:"11px 13px",border:`0.5px solid ${C.border}`}}><div style={{fontSize:11,color:C.muted,marginBottom:3}}>{l}</div><div style={{fontSize:20,fontWeight:500}}>{v}</div></div>)}
                </div>
                {db.busy&&<div style={{display:"flex",alignItems:"center",gap:8,padding:"12px 0",color:C.muted,fontSize:13}}><Spinner size={14}/>Loading stories…</div>}
                {!db.busy&&db.stories.length===0&&(
                  <div style={{textAlign:"center",padding:"40px 0",color:C.muted}}><div style={{fontSize:32,marginBottom:12}}>✦</div><div style={{fontSize:14,fontWeight:500,marginBottom:6}}>No stories yet</div><div style={{fontSize:12,marginBottom:20}}>Head to the AI Studio to create your first story.</div><Btn v="pri" onClick={()=>go("studio")}>✦ Create first story →</Btn></div>
                )}
                {db.stories.length>0&&(
                  <div>
                    <div style={{fontSize:12,fontWeight:500,marginBottom:10}}>Your stories</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
                      {db.stories.map(s=>(
                        <div key={s.id} style={{position:"relative"}}>
                          <CoverCard item={s} aiMade onClick={()=>{setSel(s);setPage("library");}}/>
                          <button onClick={e=>{e.stopPropagation();db.remove(s.id);}} title="Delete" style={{position:"absolute",top:42,right:8,width:20,height:20,borderRadius:"50%",background:"rgba(0,0,0,0.6)",border:"none",color:C.muted,cursor:"pointer",fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>×</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{padding:18,border:`1.5px dashed ${C.border2}`,borderRadius:10,textAlign:"center",cursor:"pointer"}} onClick={()=>go("studio")} onMouseEnter={e=>e.currentTarget.style.borderColor=C.purple} onMouseLeave={e=>e.currentTarget.style.borderColor=C.border2}>
                  <div style={{fontSize:14,fontWeight:500,marginBottom:4}}>+ New story</div>
                  <div style={{fontSize:12,color:C.muted}}>AI Studio → write script → publish to library</div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{borderTop:`0.5px solid ${C.border}`,marginTop:48,padding:"14px 20px",textAlign:"center",fontSize:11,color:C.muted}}>
        MangaVerse · Read, create, and share stories in every language · Private beta
      </div>
    </div>
  );
}
