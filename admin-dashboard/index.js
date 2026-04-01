const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });
const express = require("express");
const postgres = require("postgres");

const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

const sql = process.env.DATABASE_URL
    ? postgres(process.env.DATABASE_URL)
    : postgres({
        host: "localhost",
        port: 5432,
        database: process.env.DATABASE_NAME,
        username: process.env.DATABASE_USERNAME,
        password: process.env.DATABASE_PASSWORD,
    });

const STATUS_IN_SESSION = "in session";
const STATUS_BETWEEN_SESSIONS = "between sessions";
let agentStatus = STATUS_BETWEEN_SESSIONS;

app.use(cors());
app.use(express.json());
app.use(express.text());
app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/sessions", async (req, res) => {
    try {
        const result = await sql`SELECT * FROM sessions ORDER BY clicked_at DESC`;
        const rows = result.map(row => ({
            ...row,
            duration_seconds: row.ended_at
                ? Math.round((new Date(row.ended_at) - new Date(row.clicked_at)) / 1000)
                : null,
        }));
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch sessions", details: err.message });
    }
});

app.post("/api/chat-click", async (req, res) => {
    try {
        const { chatName, chatPreview } = req.body;

        // Close the previous open session
        const updated = await sql`
            UPDATE sessions SET ended_at = NOW()
            WHERE ended_at IS NULL
            RETURNING id
        `;
        console.log("Closed sessions:", updated.map(r => r.id));

        const result = await sql`
            INSERT INTO sessions (chat_name, chat_preview)
            VALUES (${chatName || null}, ${chatPreview || null})
            RETURNING *
        `;
        agentStatus = STATUS_IN_SESSION;
        res.json({ success: true, data: result[0] });
    } catch (err) {
        console.error("POST /api/chat-click error:", err.message);
        res.status(500).json({ error: "Failed to save chat click", details: err.message });
    }
});

app.get("/api/agent-status", (req, res) => {
    res.json({ status: agentStatus });
});

app.post("/api/close-session", async (req, res) => {
    try {
        const updated = await sql`
            UPDATE sessions SET ended_at = NOW()
            WHERE ended_at IS NULL
            RETURNING id
        `;
        console.log("Session closed:", updated.map(r => r.id));
        agentStatus = STATUS_BETWEEN_SESSIONS;
        res.json({ success: true, closed: updated.length });
    } catch (err) {
        res.status(500).json({ error: "Failed to close session", details: err.message });
    }
});

app.listen(PORT, async () => {
    try {
        await sql`SELECT 1`;
        console.log("✅ Connected to PostgreSQL database: fitstnflexcoach");

        // await sql`
        //     ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP
        // `;

        // Backfill old sessions: set ended_at to the next session's clicked_at
        await sql`
            UPDATE sessions s
            SET ended_at = (
                SELECT s2.clicked_at FROM sessions s2
                WHERE s2.clicked_at > s.clicked_at
                ORDER BY s2.clicked_at ASC LIMIT 1
            )
            WHERE s.ended_at IS NULL
            AND EXISTS (
                SELECT 1 FROM sessions s2 WHERE s2.clicked_at > s.clicked_at
            )
        `;
        console.log("Table 'sessions' schema updated.");
    } catch (err) {
        console.error("❌ Failed to connect to database:", err.message);
    }
        console.log(`✨ Server running on http://localhost:${PORT}`);
});

