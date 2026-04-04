const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const express = require("express");

module.exports = function (sql, requireAgent) {
    const router = express.Router();

    router.post("/login", async (req, res) => {
        try {
            const { email, password } = req.body;
            if (!email || !password) {
                return res.status(400).json({ error: "Email and password required" });
            }
            const agents = await sql`SELECT * FROM agents WHERE email = ${email}`;
            if (agents.length === 0) {
                return res.status(401).json({ error: "Invalid credentials" });
            }
            if (!agents[0].is_active) {
                return res.status(403).json({ error: "Agent account is deactivated" });
            }
            const valid = await bcrypt.compare(password, agents[0].password_hash);
            if (!valid) {
                return res.status(401).json({ error: "Invalid credentials" });
            }
            const token = crypto.randomBytes(32).toString("hex");
            await sql`
                INSERT INTO auth_tokens (token, user_type, user_id, expires_at)
                VALUES (${token}, 'agent', ${agents[0].id}, NOW() + INTERVAL '7 days')
            `;
            res.json({
                token,
                agent: {
                    id: agents[0].id,
                    email: agents[0].email,
                    name: agents[0].name,
                },
            });
        } catch (err) {
            res.status(500).json({ error: "Login failed", details: err.message });
        }
    });

    router.post("/logout", async (req, res) => {
        try {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith("Bearer ")) {
                const token = authHeader.slice(7);
                await sql`DELETE FROM auth_tokens WHERE token = ${token}`;
            }
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: "Logout failed" });
        }
    });

    router.get("/me", requireAgent, async (req, res) => {
        res.json({ id: req.user.id, email: req.user.email, name: req.user.name });
    });

    return router;
};
