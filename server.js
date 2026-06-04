'use strict';

require('dotenv').config();

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const cors    = require('cors');
const path    = require('path');

const {
    parsePnL,
    parsePnLByClass,
    parseCustomerSales,
    parseExpenseBreakdown
} = require('./qbo-transformer');

const { db } = require('./firebase');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);

const BASE_URL =
    process.env.RENDER_EXTERNAL_URL ||
    process.env.BASE_URL ||
    `http://localhost:${PORT}`;

const CLIENT_ID     = process.env.QBO_CLIENT_ID;
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;
const REDIRECT_URI  = process.env.QBO_REDIRECT_URI || `${BASE_URL}/auth/callback`;
const SANDBOX       = process.env.QBO_SANDBOX === 'true';

const QBO_BASE  = SANDBOX
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL  = 'https://appcenter.intuit.com/connect/oauth2';

let stateCache = new Set();

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('[ERROR] Missing QBO_CLIENT_ID or QBO_CLIENT_SECRET in environment');
    process.exit(1);
}

// ─────────────────────────────────────────────
// FIRESTORE HELPERS
// ─────────────────────────────────────────────

async function getQboDoc(realmId) {
    const doc = await db.collection('qbo_tokens').doc(realmId).get();
    return doc.exists ? doc.data() : null;
}

async function saveQboDoc(realmId, data) {
    await db.collection('qbo_tokens').doc(realmId).set(data, { merge: true });
}

// ─────────────────────────────────────────────
// OAUTH
// ─────────────────────────────────────────────

app.get('/auth/connect', (_req, res) => {
    const state = crypto.randomBytes(20).toString('hex');
    stateCache.add(state);
    setTimeout(() => stateCache.delete(state), 600000);

    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id',     CLIENT_ID);
    url.searchParams.set('redirect_uri',  REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope',         'com.intuit.quickbooks.accounting');
    url.searchParams.set('state',         state);

    res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
    const { code, realmId, state, error } = req.query;

    if (error)                  return res.status(400).send(error);
    if (!stateCache.has(state)) return res.status(400).send('Invalid state');

    stateCache.delete(state);

    try {
        const r = await axios.post(
            TOKEN_URL,
            new URLSearchParams({
                grant_type:   'authorization_code',
                code,
                redirect_uri: REDIRECT_URI
            }),
            {
                auth:    { username: CLIENT_ID, password: CLIENT_SECRET },
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }
        );

        const tokenData = {
            realmId,
            access_token:        r.data.access_token,
            refresh_token:       r.data.refresh_token,
            expires_at:          Date.now() + r.data.expires_in * 1000,
            refresh_expires_at:  Date.now() + (r.data.x_refresh_token_expires_in || 8726400) * 1000,
            updatedAt:           new Date().toISOString()
        };

        await saveQboDoc(realmId, tokenData);
        console.log('[Auth] Connected realm:', realmId);

        res.redirect(`${BASE_URL}/dashboard?qbo_connected=true`);
    } catch (e) {
        console.error('[Auth] OAuth failed:', e.response?.data || e.message);
        res.status(500).send('OAuth failed: ' + (e.response?.data?.error_description || e.message));
    }
});

app.get('/auth/disconnect', async (req, res) => {
    const { realmId } = req.query;
    if (realmId) await db.collection('qbo_tokens').doc(realmId).delete();
    res.json({ disconnected: true });
});

// ─────────────────────────────────────────────
// TOKEN REFRESH
// ─────────────────────────────────────────────

async function getToken(realmId) {
    const tokenDoc = await getQboDoc(realmId);
    if (!tokenDoc) throw new Error('Not connected to QuickBooks');

    // Still valid (with 2-min buffer)
    if (Date.now() < tokenDoc.expires_at - 120_000) {
        return tokenDoc;
    }

    // Check if refresh token itself has expired
    if (tokenDoc.refresh_expires_at && Date.now() > tokenDoc.refresh_expires_at) {
        throw new Error('Refresh token expired — please reconnect QuickBooks');
    }

    console.log('[Token] Refreshing access token for realm:', realmId);

    const r = await axios.post(
        TOKEN_URL,
        new URLSearchParams({
            grant_type:    'refresh_token',
            refresh_token: tokenDoc.refresh_token
        }),
        {
            auth:    { username: CLIENT_ID, password: CLIENT_SECRET },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
    );

    const updated = {
        ...tokenDoc,
        access_token:  r.data.access_token,
        refresh_token: r.data.refresh_token,
        expires_at:    Date.now() + r.data.expires_in * 1000,
        updatedAt:     new Date().toISOString()
    };

    await saveQboDoc(realmId, updated);
    console.log('[Token] Refreshed OK for realm:', realmId);
    return updated;
}

// ─────────────────────────────────────────────
// QBO REQUEST WRAPPER
// ─────────────────────────────────────────────

async function qboGet(realmId, endpoint, params = {}) {
    const token = await getToken(realmId);

    try {
        const res = await axios.get(
            `${QBO_BASE}/v3/company/${realmId}${endpoint}`,
            {
                headers: {
                    Authorization: `Bearer ${token.access_token}`,
                    Accept:        'application/json'
                },
                params: { minorversion: 70, ...params }
            }
        );
        return res.data;
    } catch (e) {
        const detail = e.response?.data || e.message;
        console.error(`[QBO] GET ${endpoint} failed:`, JSON.stringify(detail));
        throw new Error(`QBO ${endpoint}: ${e.response?.status || ''} ${JSON.stringify(detail)}`);
    }
}

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

const requireAuth = async (req, res, next) => {
    try {
        const snap = await db.collection('qbo_tokens').limit(1).get();
        if (snap.empty) {
            return res.status(401).json({
                error:      'Not authenticated with QuickBooks',
                connectUrl: `${BASE_URL}/auth/connect`
            });
        }
        req.realmId = snap.docs[0].id;
        next();
    } catch (e) {
        res.status(500).json({ error: 'Firestore error: ' + e.message });
    }
};

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

app.get('/api/status', requireAuth, async (req, res) => {
    const data = await getQboDoc(req.realmId);
    res.json({
        connected:    !!data,
        companyId:    req.realmId,
        tokenExpiry:  data?.expires_at ? new Date(data.expires_at).toISOString() : null,
        syncedAt:     data?.syncedAt   || null,
        refreshExpiry: data?.refresh_expires_at ? new Date(data.refresh_expires_at).toISOString() : null
    });
});

// ─── Main data endpoint (dashboard calls this) ───────────────────────────────
app.get('/api/all', requireAuth, async (req, res) => {
    const now      = new Date();
    const ytdStart = now.getFullYear() + '-01-01';
    const ytdEnd   = now.toISOString().slice(0, 10);
    const { start = ytdStart, end = ytdEnd } = req.query;

    console.log(`[/api/all] Fetching QBO data for realm ${req.realmId}  ${start} → ${end}`);

    // Fire all QBO calls in parallel; non-critical ones fail silently
    const [pnlRaw, byClassRaw, customerRaw, accountsRaw] = await Promise.all([

        // P&L by month — required
        qboGet(req.realmId, '/reports/ProfitAndLoss', {
            start_date: start,
            end_date:   end,
            summarize_column_by: 'Month'
        }),

        // P&L by class — optional (only works if Classes are enabled in QBO)
        qboGet(req.realmId, '/reports/ProfitAndLoss', {
            start_date: start,
            end_date:   end,
            summarize_column_by: 'Class'
        }).catch(e => { console.warn('[/api/all] PnL-by-class skipped:', e.message); return null; }),

        // Customer sales — optional
        qboGet(req.realmId, '/reports/CustomerSales', {
            start_date: start,
            end_date:   end
        }).catch(e => { console.warn('[/api/all] CustomerSales skipped:', e.message); return null; }),

        // Customer list (for projects tab) — optional
        qboGet(req.realmId, '/query', {
            query: 'SELECT * FROM Customer MAXRESULTS 200'
        }).catch(e => { console.warn('[/api/all] Customer query skipped:', e.message); return null; })

    ]).catch(e => {
        // If the required P&L call fails, surface the error
        console.error('[/api/all] Fatal QBO error:', e.message);
        throw e;
    });

    // Parse
    const pnl             = parsePnL(pnlRaw);
    const byClass         = byClassRaw  ? parsePnLByClass(byClassRaw)    : [];
    const customers       = customerRaw ? parseCustomerSales(customerRaw) : [];
    const expenseBreakdown = pnl        ? parseExpenseBreakdown(pnl)      : [];

    // revenueByStream: prefer class breakdown, fall back to income line items
    let revenueByStream = [];
    if (byClass.length > 0) {
        revenueByStream = byClass.map(c => ({
            name:    c.className,
            revenue: c.revenue,
            monthly: null
        }));
    } else if (pnl?.incomeItems?.length > 0) {
        revenueByStream = pnl.incomeItems.map(item => ({
            name:    item.name,
            revenue: item.total,
            monthly: item.monthly
        }));
    }

    // Projects: sub-customers (IsProject or IsSubCustomer) from the customer query
    const allCustomers = accountsRaw?.QueryResponse?.Customer || [];
    const projects = allCustomers
        .filter(c => c.IsProject || c.ParentRef) // sub-customers / projects
        .map(c => ({
            id:           c.Id,
            name:         c.DisplayName || c.FullyQualifiedName,
            customerName: c.ParentRef?.name || null,
            status:       c.Active === false ? 'Inactive' : 'Active',
            balance:      c.Balance || 0
        }));

    // Stamp last sync time
    await saveQboDoc(req.realmId, { syncedAt: new Date().toISOString() });

    console.log(`[/api/all] Done — pnl months: ${pnl?.months?.length}, customers: ${customers.length}, projects: ${projects.length}`);

    res.json({ pnl, revenueByStream, customers, expenseBreakdown, byClass, projects });
});

// Error wrapper for /api/all
app.use((err, _req, res, _next) => {
    console.error('[Unhandled]', err.message);
    res.status(500).json({ error: err.message });
});

// ─── Legacy individual endpoint ──────────────────────────────────────────────
app.get('/api/pnl', requireAuth, async (req, res) => {
    try {
        const now      = new Date();
        const ytdStart = now.getFullYear() + '-01-01';
        const ytdEnd   = now.toISOString().slice(0, 10);
        const { start = ytdStart, end = ytdEnd } = req.query;
        const raw = await qboGet(req.realmId, '/reports/ProfitAndLoss', {
            start_date: start,
            end_date:   end,
            summarize_column_by: 'Month'
        });
        res.json({ raw, parsed: parsePnL(raw) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Debug: test a raw QBO call ───────────────────────────────────────────────
app.get('/api/debug/pnl-raw', requireAuth, async (req, res) => {
    try {
        const data = await qboGet(req.realmId, '/reports/ProfitAndLoss', {
            start_date: '2024-01-01',
            end_date:   '2026-12-31',
            summarize_column_by: 'Month'
        });
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────
// PAGES
// ─────────────────────────────────────────────

app.get('/dashboard', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/', (_req, res) => {
    res.redirect('/auth/connect');
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`⚓  QBO Server running at ${BASE_URL}`);
    console.log(`    Mode:        ${SANDBOX ? 'SANDBOX' : 'PRODUCTION'}`);
    console.log(`    Redirect:    ${REDIRECT_URI}`);
});