const express = require('express');

module.exports = function (sql, requireAdmin) {
    const router = express.Router();

    router.get('/alerts', requireAdmin, async (req, res) => {
        try {
            const unacked = req.query.unacked === 'true';
            const limit   = Math.min(parseInt(req.query.limit) || 50, 200);

            const rows = unacked
                ? await sql`
                    SELECT oa.*, a.name AS agent_name
                    FROM operational_alerts oa
                    LEFT JOIN agents a ON oa.agent_id = a.id
                    WHERE oa.is_acknowledged = FALSE
                    ORDER BY oa.created_at DESC
                    LIMIT ${limit}`
                : await sql`
                    SELECT oa.*, a.name AS agent_name
                    FROM operational_alerts oa
                    LEFT JOIN agents a ON oa.agent_id = a.id
                    ORDER BY oa.created_at DESC
                    LIMIT ${limit}`;

            res.json({ alerts: rows });
        } catch (err) {
            res.status(500).json({ error: 'Failed to fetch alerts', details: err.message });
        }
    });

    router.post('/alerts/:id/acknowledge', requireAdmin, async (req, res) => {
        try {
            const alertId = parseInt(req.params.id);
            if (!alertId) return res.status(400).json({ error: 'Invalid alert ID' });

            const result = await sql`
                UPDATE operational_alerts
                SET is_acknowledged = TRUE,
                    acknowledged_at  = NOW(),
                    acknowledged_by  = ${req.user.id}
                WHERE id = ${alertId}
                RETURNING *
            `;

            if (result.length === 0) return res.status(404).json({ error: 'Alert not found' });
            res.json({ success: true, alert: result[0] });
        } catch (err) {
            res.status(500).json({ error: 'Failed to acknowledge alert', details: err.message });
        }
    });

    return router;
};
