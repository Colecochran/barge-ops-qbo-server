'use strict';
require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const crypto   = require('crypto');
const cors     = require('cors');
const path     = require('path');
const { parsePnL, parsePnLByClass, parseCustomerSales, parseExpenseBreakdown } = require('./qbo-transformer');

console.log("ENV CHECK:", {
  CLIENT_ID: process.env.QBO_CLIENT_ID,
  CLIENT_SECRET: process.env.QBO_CLIENT_SECRET,
  REDIRECT_URI: process.env.QBO_REDIRECT_URI,
  DASHBOARD_URL: process.env.DASHBOARD_URL
});

const PORT          = parseInt(process.env.PORT || '3000', 10);
const CLIENT_ID     = process.env.QBO_CLIENT_ID;
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;
const REDIRECT_URI  = process.env.QBO_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const DASHBOARD_URL = process.env.DASHBOARD_URL    || `http://localhost:${PORT}/dashboard`;
const SANDBOX       = process.env.QBO_SANDBOX === 'true';
const QBO_BASE      = SANDBOX ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';
const TOKEN_URL     = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL      = 'https://appcenter.intuit.com/connect/oauth2';

if (!CLIENT_ID || !CLIENT_SECRET) { console.error('[ERROR] QBO credentials missing in .env'); process.exit(1); }

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let tokenStore = {}, stateCache = new Set();
const isConnected = () => !!tokenStore.access_token;

// ── OAuth ──────────────────────────────────────────────────────────────────
app.get('/auth/connect', (_req, res) => {
  const state = crypto.randomBytes(20).toString('hex');
  stateCache.add(state);
  setTimeout(() => stateCache.delete(state), 600_000);
  const url = new URL(AUTH_URL);
  ['client_id','redirect_uri','response_type','scope','state'].forEach((k, i) =>
    url.searchParams.set(k, [CLIENT_ID, REDIRECT_URI, 'code', 'com.intuit.quickbooks.accounting', state][i]));
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code, realmId, state, error } = req.query;
  if (error) return res.status(400).send(`Authorization failed: ${error}`);
  if (!stateCache.has(state)) return res.status(400).send('Invalid state — try again.');
  stateCache.delete(state);
  try {
    const r = await axios.post(TOKEN_URL,
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      { auth: { username: CLIENT_ID, password: CLIENT_SECRET },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    tokenStore = { ...r.data, realmId, expires_at: Date.now() + r.data.expires_in * 1000,
      refresh_expires_at: Date.now() + (r.data.x_refresh_token_expires_in || 8726400) * 1000 };
    console.log(`[Auth] ✓ Connected to company ${realmId}`);
    res.redirect(`${DASHBOARD_URL}?qbo_connected=true`);
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

app.get('/auth/disconnect', (_req, res) => { tokenStore = {}; res.json({ disconnected: true }); });

// ── Token refresh ──────────────────────────────────────────────────────────
async function getToken() {
  if (!tokenStore.access_token) throw new Error('Not authenticated');
  if (Date.now() > tokenStore.expires_at - 120_000) {
    const r = await axios.post(TOKEN_URL,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenStore.refresh_token }),
      { auth: { username: CLIENT_ID, password: CLIENT_SECRET },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    tokenStore = { ...tokenStore, ...r.data,
      expires_at: Date.now() + r.data.expires_in * 1000,
      refresh_expires_at: Date.now() + (r.data.x_refresh_token_expires_in || 8726400) * 1000 };
  }
  return tokenStore.access_token;
}

async function qboGet(path, params = {}) {
  const token = await getToken();
  const res = await axios.get(`${QBO_BASE}/v3/company/${tokenStore.realmId}${path}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      params: { minorversion: 70, ...params } });
  return res.data;
}

const requireAuth = (req, res, next) =>
  isConnected() ? next() : res.status(401).json({ error: 'Not authenticated', connectUrl: `http://localhost:${PORT}/auth/connect` });

const defaultDates = req => {
  const n = new Date(), y = n.getFullYear(),
    mm = String(n.getMonth()+1).padStart(2,'0'), dd = String(n.getDate()).padStart(2,'0');
  return { start: req.query.start || `${y}-01-01`, end: req.query.end || `${y}-${mm}-${dd}` };
};

// ── API routes ─────────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => res.json({
  connected: isConnected(), sandbox: SANDBOX, companyId: tokenStore.realmId || null,
  syncedAt: new Date().toISOString(), tokenExpiry: tokenStore.expires_at ? new Date(tokenStore.expires_at).toISOString() : null
}));

app.get('/api/pnl', requireAuth, async (req, res) => {
  try {
    const { start, end } = defaultDates(req);
    const raw = await qboGet('/reports/ProfitAndLoss', { start_date: start, end_date: end, summarize_column_by: 'Month', accounting_method: 'Accrual' });
    res.json({ raw, parsed: parsePnL(raw) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pnl-by-class', requireAuth, async (req, res) => {
  try {
    const { start, end } = defaultDates(req);
    const raw = await qboGet('/reports/ProfitAndLoss', { start_date: start, end_date: end, summarize_column_by: 'Class', accounting_method: 'Accrual' });
    res.json({ raw, parsed: parsePnLByClass(raw) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/customers', requireAuth, async (req, res) => {
  try {
    const { start, end } = defaultDates(req);
    const raw = await qboGet('/reports/CustomerSales', { start_date: start, end_date: end });
    res.json({ raw, parsed: parseCustomerSales(raw) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/project-list', requireAuth, async (req, res) => {
  try {
    const raw = await qboGet('/query', { query: 'SELECT * FROM Project MAXRESULTS 100' });
    const projects = (raw.QueryResponse?.Project || []).map(p => ({
      id: p.Id, name: p.Description || p.Name, status: p.ProjectStatus,
      customerName: p.CustomerRef?.name, active: p.Active
    }));
    res.json({ raw, parsed: projects });
  } catch (e) { res.json({ parsed: [], note: 'QBO Projects may not be enabled on this plan.' }); }
});

// ── /api/all — single-payload endpoint used by dashboard on load ───────────
app.get('/api/all', requireAuth, async (req, res) => {
  const { start, end } = defaultDates(req);
  const [pnlR, classR, custR, projR] = await Promise.allSettled([
    qboGet('/reports/ProfitAndLoss', { start_date: start, end_date: end, summarize_column_by: 'Month', accounting_method: 'Accrual' }),
    qboGet('/reports/ProfitAndLoss', { start_date: start, end_date: end, summarize_column_by: 'Class',  accounting_method: 'Accrual' }),
    qboGet('/reports/CustomerSales', { start_date: start, end_date: end }),
    qboGet('/query', { query: 'SELECT * FROM Project MAXRESULTS 100' }).catch(() => ({ QueryResponse: { Project: [] } }))
  ]);
  const u = r => r.status === 'fulfilled' ? r.value : null;
  const pnlParsed = u(pnlR) ? parsePnL(u(pnlR)) : null;
  res.json({
    fetchedAt: new Date().toISOString(), period: { start, end },
    companyId: tokenStore.realmId, sandbox: SANDBOX,
    pnl:              pnlParsed,
    revenueByStream:  u(classR) ? parsePnLByClass(u(classR)) : [],
    customers:        u(custR)  ? parseCustomerSales(u(custR)) : [],
    expenses:         pnlParsed ? parseExpenseBreakdown(pnlParsed) : [],
    projects:         (u(projR)?.QueryResponse?.Project || []).map(p => ({
      id: p.Id, name: p.Description || p.Name, status: p.ProjectStatus,
      customerName: p.CustomerRef?.name
    }))
  });
});

app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/', (_req, res) => isConnected() ? res.redirect('/dashboard') : res.redirect('/auth/connect'));

app.listen(PORT, () => {
  console.log(`\n  ⚓  Barge Ops QBO Server  |  ${SANDBOX ? 'SANDBOX' : 'PRODUCTION'}`);
  console.log(`  Connect:   http://localhost:${PORT}/auth/connect`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard\n`);
});
