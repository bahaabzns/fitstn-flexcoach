// SSE (Server-Sent Events) — one-way push from server to admin dashboard.
//
// EventSource cannot set custom headers, so we accept the admin token via
// the `token` query parameter as a fallback to the Authorization header.
//
// Usage from the browser:
//   const es = new EventSource(`/api/stream?token=${adminToken}`);
//   es.addEventListener('queue_update', e => console.log(JSON.parse(e.data)));

const express = require('express');

const clients = new Set();  // active SSE connections

function broadcast(eventType, data) {
    if (clients.size === 0) return;
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
        try {
            res.write(payload);
        } catch {
            clients.delete(res);
        }
    }
}

module.exports = function (sql, requireAdmin) {
    const router = express.Router();

    // Custom auth that also accepts ?token= query param (required for EventSource)
    async function requireAdminSse(req, res, next) {
        const token =
            (req.headers.authorization?.startsWith('Bearer ')
                ? req.headers.authorization.slice(7)
                : null) ?? req.query.token;

        if (!token) {
            res.status(401).end('No token provided');
            return;
        }

        try {
            const rows = await sql`
                SELECT t.user_id, a.email
                FROM auth_tokens t
                JOIN admins a ON t.user_id = a.id
                WHERE t.token = ${token}
                  AND t.user_type = 'admin'
                  AND t.expires_at > NOW()
            `;
            if (rows.length === 0) {
                res.status(401).end('Invalid or expired token');
                return;
            }
            req.user = { id: rows[0].user_id, email: rows[0].email, type: 'admin' };
            next();
        } catch (err) {
            res.status(500).end('Auth check failed');
        }
    }

    router.get('/stream', requireAdminSse, (req, res) => {
        res.setHeader('Content-Type',      'text/event-stream');
        res.setHeader('Cache-Control',     'no-cache');
        res.setHeader('Connection',        'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');   // prevent nginx buffering
        res.flushHeaders();

        clients.add(res);

        // Heartbeat every 25 s — keeps the connection alive through proxies and
        // prevents browser EventSource from triggering a reconnect after 30 s.
        const heartbeat = setInterval(() => {
            try { res.write(':heartbeat\n\n'); } catch { /* connection dropped */ }
        }, 25_000);

        req.on('close', () => {
            clearInterval(heartbeat);
            clients.delete(res);
        });
    });

    return router;
};

module.exports.broadcast = broadcast;
module.exports.clients   = clients;
