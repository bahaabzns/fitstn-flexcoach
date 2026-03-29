const bcrypt = require("bcryptjs");
const express = require("express");

module.exports = function (sql, requireAdmin) {
    const router = express.Router();

    router.get("/", requireAdmin, async (req, res) => {
        try {
            const agents = await sql`
                SELECT id, email, name, is_active, created_at, updated_at
                FROM agents ORDER BY created_at DESC
            `;
            res.json(agents);
        } catch (err) {
            res.status(500).json({ error: "Failed to fetch agents", details: err.message });
        }
    });

    router.post("/", requireAdmin, async (req, res) => {
        try {
            const { email, password, name } = req.body;
            if (!email || !password) {
                return res.status(400).json({ error: "Email and password required" });
            }
            const hash = await bcrypt.hash(password, 10);
            const result = await sql`
                INSERT INTO agents (email, password_hash, name)
                VALUES (${email}, ${hash}, ${name || null})
                RETURNING id, email, name, is_active, created_at
            `;
            res.json(result[0]);
        } catch (err) {
            if (err.code === "23505") {
                return res.status(409).json({ error: "An agent with this email already exists" });
            }
            res.status(500).json({ error: "Failed to create agent", details: err.message });
        }
    });

    router.put("/:id", requireAdmin, async (req, res) => {
        try {
            const { email, name, password, is_active } = req.body;
            const id = req.params.id;

            const existing = await sql`SELECT id FROM agents WHERE id = ${id}`;
            if (existing.length === 0) {
                return res.status(404).json({ error: "Agent not found" });
            }

            if (password) {
                const hash = await bcrypt.hash(password, 10);
                await sql`UPDATE agents SET password_hash = ${hash}, updated_at = NOW() WHERE id = ${id}`;
            }
            if (email !== undefined) {
                await sql`UPDATE agents SET email = ${email}, updated_at = NOW() WHERE id = ${id}`;
            }
            if (name !== undefined) {
                await sql`UPDATE agents SET name = ${name}, updated_at = NOW() WHERE id = ${id}`;
            }
            if (is_active !== undefined) {
                await sql`UPDATE agents SET is_active = ${is_active}, updated_at = NOW() WHERE id = ${id}`;
                if (!is_active) {
                    await sql`DELETE FROM auth_tokens WHERE user_type = 'agent' AND user_id = ${id}`;
                }
            }

            const result = await sql`
                SELECT id, email, name, is_active, created_at, updated_at
                FROM agents WHERE id = ${id}
            `;
            res.json(result[0]);
        } catch (err) {
            if (err.code === "23505") {
                return res.status(409).json({ error: "An agent with this email already exists" });
            }
            res.status(500).json({ error: "Failed to update agent", details: err.message });
        }
    });

    router.delete("/:id", requireAdmin, async (req, res) => {
        try {
            const id = req.params.id;
            await sql`UPDATE agents SET is_active = false, updated_at = NOW() WHERE id = ${id}`;
            await sql`DELETE FROM auth_tokens WHERE user_type = 'agent' AND user_id = ${id}`;
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: "Failed to delete agent", details: err.message });
        }
    });

    return router;
};
