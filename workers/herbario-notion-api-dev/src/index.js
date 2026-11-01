const SOURCES = {
  tasks: "77838d25-f0a0-4186-816c-c42a2cc8db46",
  adventures: "d8cc22d8-14ca-47aa-8cd9-8e4468b59663",
  rituals: "e0136886-667e-4ff1-ade1-2a013b659624",
  xp: "a66ec5a7-5475-4bba-ab4f-a185f94826fa",
  recipes: "65b7cffb-e2ee-4fa7-be45-f94132ecd273"
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

// Cloudflare Access is the identity gate. Configure an Access application for this
// Worker hostname and set ACCESS_TEAM_DOMAIN + ACCESS_AUD as Worker variables.
let accessKeysCache;
let accessKeysAt = 0;
async function verifyAccess(request, env) {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  const parts = assertion.split(".");
  if (parts.length !== 3) return false;
  let header, claims;
  try {
    header = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
    claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return false; }
  const issuer = "https://" + env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== issuer || !(Array.isArray(claims.aud) ? claims.aud.includes(env.ACCESS_AUD) : claims.aud === env.ACCESS_AUD)) return false;
  if (!claims.exp || claims.exp < now || (claims.nbf && claims.nbf > now + 60)) return false;
  if (header.alg !== "RS256" || !header.kid) return false;
  if (!accessKeysCache || Date.now() - accessKeysAt > 10 * 60 * 1000) {
    const r = await fetch(issuer + "/cdn-cgi/access/certs");
    if (!r.ok) return false;
    accessKeysCache = await r.json();
    accessKeysAt = Date.now();
  }
  const jwk = accessKeysCache.keys?.find(k => k.kid === header.kid);
  if (!jwk) return false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const decode = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  } catch { return false; }
}
async function requireWriteAccess(request, env) {
  if (request.headers.get("Origin") !== SITE_ORIGIN) return false;
  return verifyAccess(request, env);
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

let syncPromise;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const routePath = url.pathname.startsWith("/write/") ? url.pathname.slice(6) : url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!env.NOTION_TOKEN) return json({ ok: false, error: "NOTION_TOKEN não configurado" }, 500);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "herbario-notion-api-dev", writeProtection: "Cloudflare Access JWT" });
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
        if (!await requireWriteAccess(request, env)) return json({ ok: false, error: "Acesso de gravação não autorizado. Entre pelo acesso protegido do Herbário." }, 401);
        const payload = await request.json();
        if (routePath === "/api/sync-xp" && request.method === "POST") {
          if (!syncPromise) syncPromise = syncTaskXP(env).finally(() => { syncPromise = null; });
          return json({ ok: true, result: await syncPromise });
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