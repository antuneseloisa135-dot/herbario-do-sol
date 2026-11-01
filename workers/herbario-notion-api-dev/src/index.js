const SOURCES = {
  tasks: "77838d25-f0a0-4186-816c-c42a2cc8db46",
  adventures: "d8cc22d8-14ca-47aa-8cd9-8e4468b59663",
  rituals: "e0136886-667e-4ff1-ade1-2a013b659624",
  xp: "a66ec5a7-5475-4bba-ab4f-a185f94826fa",
  recipes: "65b7cffb-e2ee-4fa7-be45-f94132ecd273",
  achievements: "bf7b4e1b-dcbc-4589-8cae-975d84743233",
  rewards: "c18976a8-043a-4bbc-a3ea-4c9ff7e00765"
};
const SITE_ORIGIN = "https://herbario-do-sol.pages.dev";
const NOTION_VERSION = "2025-09-03";
const CORS = {
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Credentials": "true",
  "Vary": "Origin"
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
const notionHeaders = token => ({
  Authorization: "Bearer " + token,
  "Notion-Version": NOTION_VERSION,
  "Content-Type": "application/json"
});
const normId = value => String(value || "").replace(/-/g, "").toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);
const getTitle = (page, key) => (page.properties?.[key]?.title || []).map(x => x.plain_text || x.text?.content || "").join("");
const getSelect = (page, key) => page.properties?.[key]?.select?.name || page.properties?.[key]?.status?.name || "";
const getNumber = (page, key) => {
  const p = page.properties?.[key];
  return p?.number ?? p?.formula?.number ?? p?.rollup?.number ?? 0;
};
const getDate = (page, key) => page.properties?.[key]?.date?.start || "";
const getText = (page, key) => {
  const p = page.properties?.[key];
  return (p?.rich_text || []).map(x => x.plain_text || x.text?.content || "").join("");
};
const getPages = async (env, sourceId) => {
  const all = [];
  let cursor;
  do {
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const r = await fetch("https://api.notion.com/v1/data_sources/" + sourceId + "/query", {
      method: "POST", headers: notionHeaders(env.NOTION_TOKEN), body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || "Falha ao consultar base do Notion");
    all.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return all;
};
const notionWrite = async (env, path, method, body) => {
  const r = await fetch("https://api.notion.com/v1/" + path, {
    method, headers: notionHeaders(env.NOTION_TOKEN), body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) {
    const error = new Error(data.message || "Falha ao gravar no Notion");
    error.status = r.status;
    error.code = data.code;
    throw error;
  }
  return data;
};

// Valida cada gravação no servidor. O segredo permanece apenas no Worker.
async function requireWriteAccess(request, env, expectedAction, token) {
  if (request.headers.get("Origin") !== SITE_ORIGIN) return false;
  if (!env.TURNSTILE_SECRET || typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  const params = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) params.set("remoteip", remoteIp);
  let result;
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return false;
    result = await response.json();
  } catch {
    return false;
  }
  return result?.success === true
    && result.action === expectedAction
    && result.hostname === "herbario-do-sol.pages.dev";
}
const difficultyXP = { "Leve": 5, "Média": 10, "Difícil": 15 };

async function syncTaskXP(env) {
  const [tasks, ledger] = await Promise.all([
    getPages(env, SOURCES.tasks),
    getPages(env, SOURCES.xp)
  ]);
  const byOrigin = new Map();
  for (const entry of ledger) {
    if (getSelect(entry, "Tipo") !== "Tarefa") continue;
    const origin = normId(getText(entry, "ID da origem"));
    if (!origin) continue;
    const operation = getSelect(entry, "Operação");
    const amount = Math.abs(getNumber(entry, "XP"));
    const signed = operation === "Entrada" ? amount : operation === "Estorno" ? -amount : getNumber(entry, "XP");
    byOrigin.set(origin, (byOrigin.get(origin) || 0) + signed);
  }
  const created = [];
  for (const task of tasks) {
    const originId = normId(task.id);
    const status = getSelect(task, "Status");
    const difficulty = getSelect(task, "Dificuldade");
    const desired = status === "Colhido" ? (difficultyXP[difficulty] || 0) : 0;
    const current = byOrigin.get(originId) || 0;
    const delta = desired - current;
    if (Math.abs(delta) < 0.000001) continue;
    const operation = desired === 0 && current > 0 ? "Estorno" : current === 0 && desired > 0 ? "Entrada" : "Ajuste";
    const amount = operation === "Ajuste" ? delta : Math.abs(delta);
    const name = getTitle(task, "Tarefa") || "Tarefa";
    const data = await notionWrite(env, "pages", "POST", {
      parent: { type: "data_source_id", data_source_id: SOURCES.xp },
      properties: {
        "Movimento": { title: [{ text: { content: (operation + " · " + name).slice(0, 2000) } }] },
        "Origem": { rich_text: [{ text: { content: name.slice(0, 2000) } }] },
        "ID da origem": { rich_text: [{ text: { content: task.id } }] },
        "Operação": { select: { name: operation } },
        "Tipo": { select: { name: "Tarefa" } },
        "XP": { number: amount },
        "Data": { date: { start: (getDate(task, "Date") || today()).slice(0, 10) } }
      }
    });
    created.push({ id: data.id, taskId: task.id, operation, xp: amount });
    byOrigin.set(originId, current + delta);
  }
  return { scannedTasks: tasks.length, scannedLedgerEntries: ledger.length, created };
}

const signedLedgerValue = entry => {
  const operation = getSelect(entry, "Operação"), amount = getNumber(entry, "XP");
  if (operation === "Entrada") return Math.abs(amount);
  if (operation === "Estorno") return -Math.abs(amount);
  return amount;
};
const notionRead = async (env, path) => {
  const r = await fetch("https://api.notion.com/v1/" + path, { headers: notionHeaders(env.NOTION_TOKEN) });
  const data = await r.json();
  if (!r.ok) { const error = new Error(data.message || "Falha ao consultar o Notion"); error.status = r.status; error.code = data.code; throw error; }
  return data;
};
async function syncAchievementUnlocks(env) {
  const [tasks, adventures, recipes, ledger, achievements] = await Promise.all([
    getPages(env, SOURCES.tasks), getPages(env, SOURCES.adventures), getPages(env, SOURCES.recipes),
    getPages(env, SOURCES.xp), getPages(env, SOURCES.achievements)
  ]);
  const done = tasks.filter(p => ["Colhido", "Done"].includes(getSelect(p, "Status")));
  const earned = ledger.reduce((sum, entry) => getSelect(entry, "Tipo") === "Resgate" ? sum : sum + signedLedgerValue(entry), 0);
  const criteria = {
    "Primeiro broto": done.length >= 1,
    "Mãos à obra": done.length >= 10,
    "Passo de gigante": done.some(p => getSelect(p, "Dificuldade") === "Difícil"),
    "Jardim florescendo": earned >= 100,
    "Uma etapa vencida": recipes.some(p => getSelect(p, "Status") === "Done"),
    "Grande aventura": adventures.some(p => getSelect(p, "Status") === "Done")
  };
  const unlocked=[];
  for (const item of achievements) {
    const name=getTitle(item,"Conquista");
    if (!criteria[name] || item.properties?.Desbloqueada?.checkbox === true) continue;
    await notionWrite(env,"pages/"+item.id,"PATCH",{properties:{"Desbloqueada":{checkbox:true},"Data":{date:{start:today()}}}});
    unlocked.push(name);
  }
  return {checked:achievements.length,unlocked,completedTasks:done.length,earnedXP:earned};
}
async function redeemReward(env,rewardId) {
  if (!/^[a-f0-9-]{32,36}$/i.test(rewardId)) { const e=new Error("ID da recompensa inválido.");e.status=400;throw e; }
  const reward=await notionRead(env,"pages/"+rewardId);
  const parent=reward.parent?.data_source_id||reward.parent?.database_id||"";
  if (![SOURCES.rewards,"96ef2e58-c084-45e3-941b-1bad9922f538"].map(normId).includes(normId(parent))) { const e=new Error("Esta página não pertence à Feira do Sol.");e.status=404;throw e; }
  const name=getTitle(reward,"Recompensa")||"Recompensa", cost=getNumber(reward,"Custo em XP"), status=getSelect(reward,"Status");
  if (!(cost>0)) { const e=new Error("Esta recompensa ainda não possui um custo válido em XP.");e.status=400;throw e; }
  const ledger=await getPages(env,SOURCES.xp);
  const existing=ledger.find(entry=>getSelect(entry,"Tipo")==="Resgate"&&normId(getText(entry,"ID da origem"))===normId(rewardId));
  if (existing) {
    if (status!=="Resgatada") await notionWrite(env,"pages/"+rewardId,"PATCH",{properties:{"Status":{select:{name:"Resgatada"}},"Data do resgate":{date:{start:today()}}}});
    return {reward:name,cost,alreadyProcessed:true};
  }
  if(status!=="Disponível"){const e=new Error(status==="Resgatada"?"Esta recompensa já foi resgatada.":"Esta recompensa não está disponível para resgate.");e.status=409;throw e;}
  const balance=ledger.reduce((sum,entry)=>sum+signedLedgerValue(entry),0);
  if(balance<cost){const e=new Error("Saldo insuficiente. Faltam "+(cost-balance)+" XP para este resgate.");e.status=409;throw e;}
  await notionWrite(env,"pages","POST",{parent:{type:"data_source_id",data_source_id:SOURCES.xp},properties:{
    "Movimento":{title:[{text:{content:("Resgate · "+name).slice(0,2000)}}]},
    "Origem":{rich_text:[{text:{content:name.slice(0,2000)}}]},
    "ID da origem":{rich_text:[{text:{content:rewardId}}]},
    "Operação":{select:{name:"Estorno"}},"Tipo":{select:{name:"Resgate"}},
    "XP":{number:cost},"Data":{date:{start:today()}}
  }});
  await notionWrite(env,"pages/"+rewardId,"PATCH",{properties:{"Status":{select:{name:"Resgatada"}},"Data do resgate":{date:{start:today()}}}});
  return {reward:name,cost,balance:balance-cost,alreadyProcessed:false};
}

let syncPromise;
let achievementSyncPromise;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const routePath = url.pathname.startsWith("/write/") ? url.pathname.slice(6) : url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!env.NOTION_TOKEN) return json({ ok: false, error: "NOTION_TOKEN não configurado" }, 500);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "herbario-notion-api-dev", writeProtection: "Cloudflare Turnstile" });
      }
      if (request.method === "GET" && url.pathname === "/notion/status") {
        const r = await fetch("https://api.notion.com/v1/users/me", { headers: notionHeaders(env.NOTION_TOKEN) });
        const data = await r.json();
        return json({ ok: r.ok, notion: r.ok ? { type: data.type, name: data.name } : null, error: r.ok ? null : data.message }, r.ok ? 200 : r.status);
      }
      if (request.method === "GET" && url.pathname === "/notion/check-databases") {
        const checks = await Promise.all(Object.entries(SOURCES).map(async ([key, id]) => {
          const r = await fetch("https://api.notion.com/v1/data_sources/" + id, { headers: notionHeaders(env.NOTION_TOKEN) });
          const d = await r.json();
          return { key, id, accessible: r.ok, title: r.ok ? (d.title || []).map(x => x.plain_text).join("") : null, error: r.ok ? null : d.message };
        }));
        return json({ ok: checks.every(x => x.accessible), databases: checks });
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/")) {
        const resource = url.pathname.split("/")[2];
        if (!Object.prototype.hasOwnProperty.call(SOURCES, resource)) return json({ ok: false, error: "Recurso não encontrado" }, 404);
        const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size")) || 100));
        const body = { page_size: pageSize };
        const cursor = url.searchParams.get("start_cursor");
        if (cursor) body.start_cursor = cursor;
        const r = await fetch("https://api.notion.com/v1/data_sources/" + SOURCES[resource] + "/query", {
          method: "POST", headers: notionHeaders(env.NOTION_TOKEN), body: JSON.stringify(body)
        });
        const data = await r.json();
        if (!r.ok) return json({ ok: false, resource, error: data.message || "Falha ao consultar Notion" }, r.status);
        return json({ ok: true, resource, results: data.results || [], has_more: !!data.has_more, next_cursor: data.next_cursor || null });
      }
      if ((request.method === "POST" || request.method === "PATCH") && url.pathname.startsWith("/write/")) {
        let payload;
        try {
          payload = await request.json();
        } catch {
          return json({ ok: false, error: "Envie um JSON válido." }, 400);
        }
        let expectedAction = "notion_write";
        if (request.method === "POST" && routePath === "/api/tasks") expectedAction = "create_task";
        else if (request.method === "PATCH" && routePath.startsWith("/api/tasks/")) expectedAction = "toggle_task";
        else if (request.method === "POST" && routePath === "/api/sync-xp") expectedAction = "sync_xp";
        else if (request.method === "POST" && routePath === "/api/sync-achievements") expectedAction = "sync_achievements";
        else if (request.method === "POST" && routePath.startsWith("/api/redeem-reward/")) expectedAction = "redeem_reward";
        if (!await requireWriteAccess(request, env, expectedAction, payload?.turnstileToken)) {
          return json({ ok: false, error: "Verificação de segurança não autorizada. Tente novamente." }, 403);
        }
        if (payload && typeof payload === "object") delete payload.turnstileToken;
        if (routePath === "/api/sync-xp" && request.method === "POST") {
          if (!syncPromise) {
            syncPromise = (async () => {
              const xp = await syncTaskXP(env);
              let achievements = null;
              try {
                achievements = await syncAchievementUnlocks(env);
              } catch (achievementError) {
                console.warn("XP sincronizado; a verificação de conquistas ficou pendente:", achievementError);
                achievements = { checked: false, unlocked: [], warning: "Não foi possível consultar a base de conquistas nesta sincronização." };
              }
              return { ...xp, achievements };
            })().finally(() => { syncPromise = null; });
          }
          return json({ ok: true, result: await syncPromise });
        }
        if (routePath === "/api/sync-achievements" && request.method === "POST") {
          if (!achievementSyncPromise) achievementSyncPromise = syncAchievementUnlocks(env).finally(() => { achievementSyncPromise = null; });
          return json({ ok: true, result: await achievementSyncPromise });
        }
        if (routePath.startsWith("/api/redeem-reward/") && request.method === "POST") {
          const rewardId = routePath.slice("/api/redeem-reward/".length);
          return json({ ok: true, result: await redeemReward(env, rewardId) });
        }
        const parts = routePath.split("/").filter(Boolean);
        if (parts[0] !== "api" || !Object.prototype.hasOwnProperty.call(SOURCES, parts[1])) return json({ ok: false, error: "Recurso não encontrado" }, 404);
        if (!payload || !payload.properties || typeof payload.properties !== "object" || Array.isArray(payload.properties)) return json({ ok: false, error: "Envie um objeto properties válido" }, 400);
        if (request.method === "POST" && parts.length === 2) {
          const page = await notionWrite(env, "pages", "POST", {
            parent: { type: "data_source_id", data_source_id: SOURCES[parts[1]] },
            properties: payload.properties
          });
          return json({ ok: true, page }, 201);
        }
        if (request.method === "PATCH" && parts.length === 3) {
          const pageId = parts[2];
          if (!/^[a-f0-9-]{32,36}$/i.test(pageId)) return json({ ok: false, error: "ID de página inválido" }, 400);
          const page = await notionWrite(env, "pages/" + pageId, "PATCH", { properties: payload.properties });
          return json({ ok: true, page });
        }
        return json({ ok: false, error: "Rota de gravação inválida" }, 404);
      }
      return json({ ok: false, error: "Rota ou método não permitido" }, 404);
    } catch (error) {
      return json({ ok: false, error: error.message || "Erro interno", code: error.code || null }, error.status || 500);
    }
  }
};