// feishu-bridge: appends transcription rows to a Feishu sheet on behalf of the
// AheadFour Toolbox frontend. Holds the Feishu app credentials so they never
// reach the browser. Only exposes append (no read/delete).

const FEISHU = 'https://open.feishu.cn/open-apis';
const MAX_ROWS = 500;

let cachedToken = null; // { token, expiresAt }

function corsHeaders(origin) {
  const allowed =
    origin === 'https://tools.aheadfour.io' ||
    origin === 'https://aheadfour-tools.pages.dev' ||
    /^https:\/\/[a-z0-9-]+\.aheadfour-tools\.pages\.dev$/.test(origin) ||
    /^http:\/\/localhost(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://tools.aheadfour.io',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Team-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function tenantToken(env) {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  const res = await fetch(`${FEISHU}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`feishu auth ${d.code}: ${d.msg}`);
  cachedToken = { token: d.tenant_access_token, expiresAt: Date.now() + (d.expire - 300) * 1000 };
  return cachedToken.token;
}

async function feishuGet(path, token) {
  const res = await fetch(`${FEISHU}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`feishu ${d.code}: ${d.msg}`);
  return d.data;
}

// Accepts wiki URLs (…/wiki/<token>?sheet=<id>) and sheet URLs
// (…/sheets/<token>?sheet=<id>); resolves to { sheetToken, sheetId }.
async function resolveTarget(rawUrl, token) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('invalid url');
  }
  if (!/\.(feishu\.cn|larksuite\.com|feishu-pre\.cn|larkoffice\.com)$/.test(u.hostname)) {
    throw new Error('not a feishu url');
  }
  const wikiMatch = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
  const sheetMatch = u.pathname.match(/\/sheets\/([A-Za-z0-9]+)/);
  let sheetToken;
  if (wikiMatch) {
    const node = await feishuGet(`/wiki/v2/spaces/get_node?token=${wikiMatch[1]}`, token);
    if (node.node.obj_type !== 'sheet') throw new Error(`target is ${node.node.obj_type}, not a sheet`);
    sheetToken = node.node.obj_token;
  } else if (sheetMatch) {
    sheetToken = sheetMatch[1];
  } else {
    throw new Error('url is not a wiki or sheet link');
  }
  let sheetId = u.searchParams.get('sheet');
  if (!sheetId) {
    const meta = await feishuGet(`/sheets/v3/spreadsheets/${sheetToken}/sheets/query`, token);
    if (!meta.sheets || !meta.sheets.length) throw new Error('spreadsheet has no sheets');
    sheetId = meta.sheets[0].sheet_id;
  }
  return { sheetToken, sheetId };
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req.headers.get('Origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const path = new URL(req.url).pathname;
    if (path !== '/api/feishu-append') return json({ ok: false, error: 'not found' }, 404, cors);
    if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405, cors);
    if ((req.headers.get('X-Team-Key') || '') !== env.TEAM_KEY) {
      return json({ ok: false, error: 'unauthorized' }, 401, cors);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: 'invalid json' }, 400, cors);
    }
    const { url, rows } = body || {};
    if (typeof url !== 'string' || !Array.isArray(rows) || rows.length === 0) {
      return json({ ok: false, error: 'missing url or rows' }, 400, cors);
    }
    if (rows.length > MAX_ROWS) {
      return json({ ok: false, error: `too many rows (max ${MAX_ROWS})` }, 400, cors);
    }
    const clean = rows.map(r => [
      String((r && r[0]) ?? '').slice(0, 64),
      String((r && r[1]) ?? '').slice(0, 5000),
    ]);

    try {
      const token = await tenantToken(env);
      const { sheetToken, sheetId } = await resolveTarget(url, token);
      const res = await fetch(`${FEISHU}/sheets/v2/spreadsheets/${sheetToken}/values_append`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueRange: { range: `${sheetId}!A:B`, values: clean } }),
      });
      const d = await res.json();
      if (d.code !== 0) {
        const hint = d.code === 91403 || d.code === 1310213 || /permission|forbidden/i.test(d.msg || '')
          ? ' (请把应用添加为该文档的协作者)'
          : '';
        return json({ ok: false, error: `feishu ${d.code}: ${d.msg}${hint}` }, 502, cors);
      }
      return json({
        ok: true,
        updatedRows: d.data?.updates?.updatedRows ?? clean.length,
        range: d.data?.updates?.updatedRange || '',
      }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500, cors);
    }
  },
};
