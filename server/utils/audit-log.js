// Thin wrapper for writing to the audit_log table.
// Fire-and-forget: errors are logged but never bubble up to callers.

async function writeAudit(sql, { actorId, actorType = 'admin', action, entityType, entityId, before = null, after = null, sessionId = null }) {
    try {
        await sql`
            INSERT INTO audit_log
                (actor_id, actor_type, action, entity_type, entity_id, before_val, after_val, session_id)
            VALUES
                (${actorId ?? null}, ${actorType}, ${action},
                 ${entityType ?? null}, ${entityId != null ? String(entityId) : null},
                 ${before != null ? JSON.stringify(before) : null},
                 ${after  != null ? JSON.stringify(after)  : null},
                 ${sessionId ?? null})
        `;
    } catch (err) {
        console.error('[AuditLog] write failed:', err.message);
    }
}

module.exports = { writeAudit };
