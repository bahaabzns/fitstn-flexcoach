const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const express = require("express");

module.exports = function (sql) {
    const router = express.Router();

    router.post("/login", async (req, res) => {
        try {
            const { email, password } = req.body;
            if (!email || !password) {
                return res.status(400).json({ error: "Email and password required" });
            }
            const admins = await sql`SELECT * FROM admins WHERE email = ${email}`;
            if (admins.length === 0) {
                return res.status(401).json({ error: "Invalid credentials" });
            }
            const valid = await bcrypt.compare(password, admins[0].password_hash);
            if (!valid) {
                return res.status(401).json({ error: "Invalid credentials" });
            }
            const token = crypto.randomBytes(32).toString("hex");
            await sql`
                INSERT INTO auth_tokens (token, user_type, user_id, expires_at)
                VALUES (${token}, 'admin', ${admins[0].id}, NOW() + INTERVAL '24 hours')
            `;
            res.json({ token, email: admins[0].email });
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

    return router;
};
