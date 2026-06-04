'use strict';

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');

const {
    parsePnL,
    parsePnLByClass,
    parseCustomerSales,
    parseExpenseBreakdown
} = require('./qbo-transformer');

const { db } = require('./firebase');

const app = express(); // ✅ FIXED: must be before usage

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

const CLIENT_ID = process.env.QBO_CLIENT_ID;
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;
const REDIRECT_URI = process.env.QBO_REDIRECT_URI || `${BASE_URL}/auth/callback`;

const SANDBOX = process.env.QBO_SANDBOX === 'true';

const QBO_BASE = SANDBOX
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

let stateCache = new Set();

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('[ERROR] Missing QBO credentials');
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

    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'com.intuit.quickbooks.accounting');
    url.searchParams.set('state', state);

    res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
    const { code, realmId, state, error } = req.query;

    if (error) return res.status(400).send(error);
    if (!stateCache.has(state)) return res.status(400).send('Invalid state');

    stateCache.delete(state);

    try {
        const r = await axios.post(
            TOKEN_URL,
            new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI
            }),
            {
                auth: {
                    username: CLIENT_ID,
                    password: CLIENT_SECRET
                },
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const tokenData = {
            realmId,
            access_token: r.data.access_token,
            refresh_token: r.data.refresh_token,
            expires_at: Date.now() + r.data.expires_in * 1000,
            refresh_expires_at:
                Date.now() + (r.data.x_refresh_token_expires_in || 8726400) * 1000,
            updatedAt: new Date().toISOString()
        };

        await saveQboDoc(realmId, tokenData);

        console.log('[Auth] Connected realm:', realmId);

        res.redirect(`${BASE_URL}/dashboard?qbo_connected=true`);
    } catch (e) {
        console.error(e.response?.data || e.message);
        res.status(500).send('OAuth failed');
    }
});

app.get('/auth/disconnect', async (req, res) => {
    const { realmId } = req.query;

    if (realmId) {
        await db.collection('qbo_tokens').doc(realmId).delete();
    }

    res.json({ disconnected: true });
});

// ─────────────────────────────────────────────
// TOKEN HANDLING (Firestore-based)
// ─────────────────────────────────────────────

async function getToken(realmId) {
    const tokenDoc = await getQboDoc(realmId);

    if (!tokenDoc) throw new Error('Not connected');

    if (Date.now() < tokenDoc.expires_at - 120000) {
        return tokenDoc;
    }

    const r = await axios.post(
        TOKEN_URL,
        new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: tokenDoc.refresh_token
        }),
        {
            auth: {
                username: CLIENT_ID,
                password: CLIENT_SECRET
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    );

    const updated = {
        ...tokenDoc,
        access_token: r.data.access_token,
        refresh_token: r.data.refresh_token,
        expires_at: Date.now() + r.data.expires_in * 1000,
        updatedAt: new Date().toISOString()
    };

    await saveQboDoc(realmId, updated);

    return updated;
}

// ─────────────────────────────────────────────
// QBO REQUEST WRAPPER
// ─────────────────────────────────────────────

async function qboGet(realmId, path, params = {}) {
    const token = await getToken(realmId);

    const res = await axios.get(
        `${QBO_BASE}/v3/company/${realmId}${path}`,
        {
            headers: {
                Authorization: `Bearer ${token.access_token}`,
                Accept: 'application/json'
            },
            params: {
                minorversion: 70,
                ...params
            }
        }
    );

    return res.data;
}

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

const requireAuth = async (req, res, next) => {
    const doc = await db.collection('qbo_tokens').limit(1).get();

    if (doc.empty) {
        return res.status(401).json({
            error: 'Not authenticated',
            connectUrl: `${BASE_URL}/auth/connect`
        });
    }

    req.realmId = doc.docs[0].id;
    next();
};

// ─────────────────────────────────────────────
// ROUTES (UPDATED TO FIRESTORE)
// ─────────────────────────────────────────────

app.get('/api/status', requireAuth, async (req, res) => {
    const data = await getQboDoc(req.realmId);

    res.json({
        connected: !!data,
        companyId: req.realmId,
        tokenExpiry: data?.expires_at
            ? new Date(data.expires_at).toISOString()
            : null
    });
});

// Example route fix
app.get('/api/pnl', requireAuth, async (req, res) => {
    try {
        const { start = '2024-01-01', end = '2026-12-31' } = req.query;

        const raw = await qboGet(req.realmId, '/reports/ProfitAndLoss', {
            start_date: start,
            end_date: end,
            summarize_column_by: 'Month'
        });

        res.json({
            raw,
            parsed: parsePnL(raw)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Aggregate endpoint the dashboard expects
app.get('/api/all', requireAuth, async (req, res) => {
    try {
        const { start = '2024-01-01', end = '2026-12-31' } = req.query;

        // Run all QBO report calls in parallel
        const [pnlRaw, byClassRaw, customerRaw, projectsRaw] = await Promise.all([
            qboGet(req.realmId, '/reports/ProfitAndLoss', {
                start_date: start,
                end_date: end,
                summarize_column_by: 'Month'
            }),
            qboGet(req.realmId, '/reports/ProfitAndLoss', {
                start_date: start,
                end_date: end,
                summarize_column_by: 'Class'
            }).catch(() => null),
            qboGet(req.realmId, '/reports/CustomerIncome', {
                start_date: start,
                end_date: end
            }).catch(() => null),
            qboGet(req.realmId, '/query', {
                query: "SELECT * FROM Customer WHERE Job = true MAXRESULTS 100"
            }).catch(() => null)
        ]);

        const pnl = parsePnL(pnlRaw);
        const byClass = byClassRaw ? parsePnLByClass(byClassRaw) : [];
        const customers = customerRaw ? parseCustomerSales(customerRaw) : [];
        const expenseBreakdown = pnl ? parseExpenseBreakdown(pnl) : [];

        // revenueByStream: use class breakdown if available, otherwise fall back to income line items
        let revenueByStream = [];
        if (byClass && byClass.length > 0) {
            revenueByStream = byClass.map(c => ({
                name: c.className,
                revenue: c.revenue,
                monthly: null // class report is not month-summarized here
            }));
        } else if (pnl && pnl.incomeItems && pnl.incomeItems.length > 0) {
            revenueByStream = pnl.incomeItems.map(item => ({
                name: item.name,
                revenue: item.total,
                monthly: item.monthly
            }));
        }

        // Projects: QBO sub-customers (Job=true) mapped to a flat list
        const projects = (projectsRaw?.QueryResponse?.Customer || []).map(c => ({
            id: c.Id,
            name: c.DisplayName || c.FullyQualifiedName || c.PrintOnCheckName,
            customerName: c.ParentRef?.name || null,
            status: c.Active === false ? 'Inactive' : 'Active'
        }));

        res.json({ pnl, revenueByStream, customers, expenseBreakdown, byClass, projects });
    } catch (e) {
        console.error('[/api/all]', e.message);
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
    console.log(`⚓ QBO Server running on ${BASE_URL}`);
});