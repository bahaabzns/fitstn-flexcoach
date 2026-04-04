module.exports = function (sql) {
    async function requireAdmin(req, res, next) {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "No token provided" });
        }
        const token = authHeader.slice(7);
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
                return res.status(401).json({ error: "Invalid or expired token" });
            }
            req.user = { id: rows[0].user_id, email: rows[0].email, type: "admin" };
            next();
        } catch (err) {
            res.status(500).json({ error: "Auth check failed" });
        }
    }

    async function requireAgent(req, res, next) {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "No token provided" });
        }
        const token = authHeader.slice(7);
        try {
            const rows = await sql`
                SELECT t.user_id, a.email, a.name, a.is_active
                FROM auth_tokens t
                JOIN agents a ON t.user_id = a.id
                WHERE t.token = ${token}
                  AND t.user_type = 'agent'
                  AND t.expires_at > NOW()
            `;
            if (rows.length === 0) {
                return res.status(401).json({ error: "Invalid or expired token" });
            }
            if (!rows[0].is_active) {
                return res.status(403).json({ error: "Agent account is deactivated" });
            }
            req.user = { id: rows[0].user_id, email: rows[0].email, name: rows[0].name, type: "agent" };
            next();
        } catch (err) {
            res.status(500).json({ error: "Auth check failed" });
        }
    }

    return { requireAdmin, requireAgent };
};
