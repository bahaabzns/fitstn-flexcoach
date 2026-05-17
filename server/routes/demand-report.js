const express = require("express");
const { SLA_RULES, PKG_ORDER, DAY_NAMES, TENANT_ID, UTC_OFFSET, isInSLAWindow } = require('../constants/sla-rules');

function extractCoachName(room) {
    if (Array.isArray(room.assigned_staff) && room.assigned_staff.length > 0) {
        const s = room.assigned_staff[0];
        return s.fullname || s.name || s.display_name || null;
    }
    return room.assigned_staff?.fullname || room.assigned_staff?.name
        || room.coach?.fullname          || room.coach?.name
        || room.staff?.fullname          || room.staff?.name
        || null;
}

async function fetchAllRooms(sb, dayStart, dayEnd, tag) {
    const PAGE_SIZE = 200;
    let offset = 0, allRooms = [], total = null, pageNum = 0;
    do {
        pageNum++;
        console.log(`[${tag}] rooms: page ${pageNum} (offset ${offset})…`);
        const { data, error } = await sb.rpc('get_chat_rooms_paginated', {
            p_assigned_staff_id: null, p_client_gender: null, p_coach_id: null,
            p_ghost_days: null, p_ghost_only: false, p_last_interaction: null,
            p_last_interaction_from: dayStart.toISOString(),
            p_last_interaction_to:   dayEnd.toISOString(),
            p_last_message_from: null, p_limit: PAGE_SIZE, p_no_assigned_staff: false,
            p_offset: offset, p_package_id: null, p_search: null, p_staff_id: null,
            p_subscription_start_date: null, p_subscription_start_weekday: null,
            p_subscription_status: null, p_subscription_t_status: null,
            p_tenant_id: TENANT_ID, p_unread_only: false,
        });
        if (error) throw new Error(`Rooms fetch failed: ${error.message}`);
        const page = data?.rooms || [];
        if (total === null) total = data?.total ?? page.length;
        allRooms.push(...page);
        offset += PAGE_SIZE;
        console.log(`[${tag}] rooms: ${allRooms.length}/${total} fetched`);
        if (page.length < PAGE_SIZE) break;
    } while (allRooms.length < total);
    return allRooms;
}

module.exports = function (sql, supabase, ensureSupabaseAuth, requireAdmin) {
    const router = express.Router();

    // ── GET /api/daily-stats ──────────────────────────────────────────────────
    router.get("/daily-stats", requireAdmin, async (req, res) => {
        const { from, to } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'Missing from or to param.' });
        const rangeStart = new Date(from);
        const rangeEnd   = new Date(to);
        if (isNaN(rangeStart) || isNaN(rangeEnd) || rangeEnd <= rangeStart)
            return res.status(400).json({ error: 'Invalid from/to values.' });
        if (rangeEnd - rangeStart > 24 * 60 * 60 * 1000)
            return res.status(400).json({ error: 'Maximum range is 24 hours.' });

        try {
            await ensureSupabaseAuth();
            console.log(`[daily-stats] ${from} → ${to}: fetching rooms…`);
            const rooms = await fetchAllRooms(supabase, rangeStart, rangeEnd, 'daily-stats');
            console.log(`[daily-stats] ${rooms.length} rooms — fetching messages…`);

            if (rooms.length === 0) {
                return res.json({ from, to, demand_rows: [], coach_rows: [],
                    peak_hours_client_first: Array(24).fill(0), peak_hours_client_replied: Array(24).fill(0),
                    total_demand_rooms: 0, total_active_rooms: 0,
                    total_coach_initiated: 0, total_client_replied: 0,
                    client_messages: 0, coach_messages: 0 });
            }

            const pkgMap   = {};
            const coachMap = {};
            const peak_hours_client_first   = Array(24).fill(0);
            const peak_hours_client_replied = Array(24).fill(0);
            let total_active_rooms = 0, client_messages = 0, coach_messages = 0;
            const CONCURRENCY = 25;
            let nextIdx = 0, doneCount = 0;

            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rooms.length) }, async () => {
                while (nextIdx < rooms.length) {
                    const room = rooms[nextIdx++];
                    const { data: messages, error: msgErr } = await supabase.rpc('get_chat_messages', {
                        p_before: rangeEnd.toISOString(), p_limit: 150, p_room_id: room.id,
                    });
                    doneCount++;
                    if (doneCount % 25 === 0 || doneCount === rooms.length)
                        console.log(`[daily-stats] messages: ${doneCount}/${rooms.length} rooms`);
                    if (msgErr || !messages?.length) continue;

                    const rangeMsgs = messages
                        .filter(m => { const t = new Date(m.created_at); return t >= rangeStart && t <= rangeEnd; })
                        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                    if (!rangeMsgs.length) continue;
                    total_active_rooms++;

                    const pkg   = room.subscription?.plan_name || 'Unknown';
                    const coach = extractCoachName(room) || 'Unassigned';
                    if (!pkgMap[pkg])     pkgMap[pkg]     = { demand_rooms: 0, total_active_rooms: 0, coach_initiated: 0, client_replied: 0, client_messages: 0, coach_messages: 0 };
                    if (!coachMap[coach]) coachMap[coach] = { demand_rooms: 0, total_active_rooms: 0, coach_initiated: 0, client_replied: 0, client_messages: 0, coach_messages: 0 };

                    pkgMap[pkg].total_active_rooms++;
                    coachMap[coach].total_active_rooms++;
                    const roomClientMsgs = rangeMsgs.filter(m => m.sender_client_id).length;
                    const roomCoachMsgs  = rangeMsgs.length - roomClientMsgs;
                    pkgMap[pkg].client_messages     += roomClientMsgs;
                    pkgMap[pkg].coach_messages      += roomCoachMsgs;
                    coachMap[coach].client_messages += roomClientMsgs;
                    coachMap[coach].coach_messages  += roomCoachMsgs;
                    client_messages += roomClientMsgs;
                    coach_messages  += roomCoachMsgs;

                    const first = rangeMsgs[0];
                    if (first.sender_client_id) {
                        pkgMap[pkg].demand_rooms++;
                        coachMap[coach].demand_rooms++;
                        const h = ((new Date(first.created_at).getUTCHours() + UTC_OFFSET) % 24 + 24) % 24;
                        peak_hours_client_first[h]++;
                    } else {
                        pkgMap[pkg].coach_initiated++;
                        coachMap[coach].coach_initiated++;
                        const firstReply = rangeMsgs.slice(1).find(m => m.sender_client_id);
                        if (firstReply) {
                            pkgMap[pkg].client_replied++;
                            coachMap[coach].client_replied++;
                            const h = ((new Date(firstReply.created_at).getUTCHours() + UTC_OFFSET) % 24 + 24) % 24;
                            peak_hours_client_replied[h]++;
                        }
                    }
                }
            }));

            const demand_rows = Object.entries(pkgMap)
                .map(([pkg, c]) => ({ package: pkg, ...c }))
                .sort((a, b) => b.demand_rooms - a.demand_rooms);
            const coach_rows = Object.entries(coachMap)
                .map(([coach, c]) => ({ coach, ...c }))
                .sort((a, b) => (b.demand_rooms + b.client_replied) - (a.demand_rooms + a.client_replied));
            const total_demand_rooms    = demand_rows.reduce((s, r) => s + r.demand_rooms,    0);
            const total_coach_initiated = demand_rows.reduce((s, r) => s + r.coach_initiated, 0);
            const total_client_replied  = demand_rows.reduce((s, r) => s + r.client_replied,  0);
            console.log(`[daily-stats] done — ${total_active_rooms} active, ${total_demand_rooms} demand`);
            res.json({ from, to, demand_rows, coach_rows, peak_hours_client_first, peak_hours_client_replied,
                total_demand_rooms, total_active_rooms, total_coach_initiated, total_client_replied,
                client_messages, coach_messages });
        } catch (err) {
            console.error('[daily-stats] error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── GET /api/daily-stats-cache ────────────────────────────────────────────
    router.get("/daily-stats-cache", requireAdmin, async (req, res) => {
        const { from, to } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'Missing from or to' });
        const rangeKey = `${from}|${to}`;
        try {
            const rows = await sql`
                SELECT range_from, range_to, peak_hours_client_first, peak_hours_client_replied,
                       demand_rows, coach_rows, total_demand_rooms, total_active_rooms,
                       total_coach_initiated, total_client_replied, client_messages, coach_messages, saved_at
                FROM daily_stats_cache WHERE range_key = ${rangeKey}
            `;
            if (rows.length === 0) return res.json({ exists: false });
            const r = rows[0];
            res.json({
                exists: true,
                from: r.range_from, to: r.range_to,
                peak_hours_client_first:   r.peak_hours_client_first,
                peak_hours_client_replied: r.peak_hours_client_replied,
                demand_rows: r.demand_rows,
                coach_rows:  r.coach_rows,
                total_demand_rooms:    r.total_demand_rooms,
                total_active_rooms:    r.total_active_rooms,
                total_coach_initiated: r.total_coach_initiated,
                total_client_replied:  r.total_client_replied,
                client_messages: r.client_messages,
                coach_messages:  r.coach_messages,
                savedAt: r.saved_at,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── POST /api/daily-stats-cache ───────────────────────────────────────────
    router.post("/daily-stats-cache", requireAdmin, async (req, res) => {
        const { from, to, peak_hours_client_first, peak_hours_client_replied,
                demand_rows, coach_rows, total_demand_rooms, total_active_rooms,
                total_coach_initiated, total_client_replied, client_messages, coach_messages } = req.body;
        if (!from || !to) return res.status(400).json({ error: 'Missing from or to' });
        const rangeKey = `${from}|${to}`;
        try {
            await sql`
                INSERT INTO daily_stats_cache (
                    range_key, range_from, range_to,
                    peak_hours_client_first, peak_hours_client_replied,
                    demand_rows, coach_rows,
                    total_demand_rooms, total_active_rooms,
                    total_coach_initiated, total_client_replied,
                    client_messages, coach_messages, saved_at
                ) VALUES (
                    ${rangeKey}, ${from}, ${to},
                    ${JSON.stringify(peak_hours_client_first)}::jsonb,
                    ${JSON.stringify(peak_hours_client_replied)}::jsonb,
                    ${JSON.stringify(demand_rows)}::jsonb,
                    ${JSON.stringify(coach_rows || [])}::jsonb,
                    ${total_demand_rooms    || 0},
                    ${total_active_rooms    || 0},
                    ${total_coach_initiated || 0},
                    ${total_client_replied  || 0},
                    ${client_messages || 0},
                    ${coach_messages  || 0},
                    NOW()
                )
                ON CONFLICT (range_key) DO UPDATE SET
                    peak_hours_client_first   = EXCLUDED.peak_hours_client_first,
                    peak_hours_client_replied = EXCLUDED.peak_hours_client_replied,
                    demand_rows               = EXCLUDED.demand_rows,
                    coach_rows                = EXCLUDED.coach_rows,
                    total_demand_rooms        = EXCLUDED.total_demand_rooms,
                    total_active_rooms        = EXCLUDED.total_active_rooms,
                    total_coach_initiated     = EXCLUDED.total_coach_initiated,
                    total_client_replied      = EXCLUDED.total_client_replied,
                    client_messages           = EXCLUDED.client_messages,
                    coach_messages            = EXCLUDED.coach_messages,
                    saved_at                  = NOW()
            `;
            res.json({ saved: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ── GET /api/sla-stats ────────────────────────────────────────────────────
    router.get("/sla-stats", requireAdmin, async (req, res) => {
        const { from, to } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'Missing from or to param.' });
        const rangeStart = new Date(from);
        const rangeEnd   = new Date(to);
        if (isNaN(rangeStart) || isNaN(rangeEnd) || rangeEnd <= rangeStart)
            return res.status(400).json({ error: 'Invalid from/to values.' });

        try {
            await ensureSupabaseAuth();
            console.log(`[sla-stats] ${from} → ${to}: fetching rooms…`);
            const rooms = await fetchAllRooms(supabase, rangeStart, rangeEnd, 'sla-stats');
            console.log(`[sla-stats] ${rooms.length} rooms — processing SLA…`);

            if (rooms.length === 0) return res.json({ from, to, sla_rows: [], sla_coach_rows: [] });

            const pkgSla   = {};
            const coachSla = {};
            const fetchBefore = new Date(rangeEnd.getTime() + 24 * 60 * 60 * 1000);
            const CONCURRENCY = 25;
            let nextIdx = 0, doneCount = 0;

            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rooms.length) }, async () => {
                while (nextIdx < rooms.length) {
                    const room  = rooms[nextIdx++];
                    const pkg   = room.subscription?.plan_name || 'Unknown';
                    const coach = extractCoachName(room) || 'Unassigned';
                    if (!pkgSla[pkg])     pkgSla[pkg]     = { total: 0, within: 0, breach: 0, noReply: 0, rooms: 0, roomsWithReply: 0 };
                    if (!coachSla[coach]) coachSla[coach] = { total: 0, within: 0, breach: 0, noReply: 0 };

                    const { data: messages, error: msgErr } = await supabase.rpc('get_chat_messages', {
                        p_before: fetchBefore.toISOString(), p_limit: 200, p_room_id: room.id,
                    });
                    doneCount++;
                    if (doneCount % 25 === 0 || doneCount === rooms.length)
                        console.log(`[sla-stats] messages: ${doneCount}/${rooms.length} rooms`);
                    if (msgErr || !messages?.length) continue;

                    const allMsgs   = [...messages].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                    const rangeMsgs = allMsgs.filter(m => { const t = new Date(m.created_at); return t >= rangeStart && t <= rangeEnd; });
                    if (!rangeMsgs.length) continue;

                    if (pkg === 'Fit Express') {
                        pkgSla[pkg].rooms++;
                        const hasReply = rangeMsgs.some(m => !m.sender_client_id);
                        if (hasReply) pkgSla[pkg].roomsWithReply++; else pkgSla[pkg].breach++;
                        coachSla[coach].total++;
                        if (hasReply) coachSla[coach].within++; else coachSla[coach].noReply++;
                    } else {
                        const rule = SLA_RULES[pkg];
                        if (!rule) continue;
                        for (const msg of rangeMsgs) {
                            if (!msg.sender_client_id) continue;
                            const msgTime = new Date(msg.created_at);
                            if (!isInSLAWindow(msgTime, rule)) continue;
                            pkgSla[pkg].total++;
                            coachSla[coach].total++;
                            const msgIdx    = allMsgs.indexOf(msg);
                            const nextReply = allMsgs.slice(msgIdx + 1).find(m => !m.sender_client_id);
                            if (!nextReply) {
                                pkgSla[pkg].noReply++;
                                coachSla[coach].noReply++;
                            } else {
                                const diffMin = (new Date(nextReply.created_at) - msgTime) / 60000;
                                if (diffMin <= rule.maxMinutes) { pkgSla[pkg].within++;  coachSla[coach].within++;  }
                                else                            { pkgSla[pkg].breach++;  coachSla[coach].breach++;  }
                            }
                        }
                    }
                }
            }));

            const sla_rows = Object.entries(pkgSla).map(([pkg, s]) => {
                if (pkg === 'Fit Express') {
                    return {
                        package: pkg, sla_type: 'weekly',
                        sla_target: '1 reply / week', sla_window: 'Weekly (subscription start day)',
                        rooms: s.rooms, rooms_with_reply: s.roomsWithReply, breach_count: s.breach,
                        sla_rate: s.rooms > 0 ? parseFloat(((s.roomsWithReply / s.rooms) * 100).toFixed(1)) : null,
                    };
                }
                const rule    = SLA_RULES[pkg];
                const winStr  = rule ? `${String(rule.startHour).padStart(2,'0')}:00 – ${String(rule.endHour).padStart(2,'0')}:00` : '—';
                const daysStr = rule ? `${DAY_NAMES[rule.days[0]]}–${DAY_NAMES[rule.days[rule.days.length - 1]]}` : '—';
                return {
                    package: pkg, sla_type: 'timed',
                    sla_target: rule ? (rule.maxMinutes === 60 ? '1 hour' : `${rule.maxMinutes / 60}h`) : '—',
                    sla_window: `${daysStr}  ${winStr}  (UTC+2)`,
                    total: s.total, within: s.within, breach: s.breach, noReply: s.noReply,
                    sla_rate: s.total > 0 ? parseFloat(((s.within / s.total) * 100).toFixed(1)) : null,
                };
            }).sort((a, b) => (PKG_ORDER.indexOf(a.package) + 1 || 99) - (PKG_ORDER.indexOf(b.package) + 1 || 99));

            const sla_coach_rows = Object.entries(coachSla)
                .map(([coach, s]) => ({
                    coach,
                    total: s.total, within: s.within, breach: s.breach, noReply: s.noReply,
                    sla_rate: s.total > 0 ? parseFloat(((s.within / s.total) * 100).toFixed(1)) : null,
                }))
                .sort((a, b) => (b.sla_rate ?? -1) - (a.sla_rate ?? -1));

            console.log(`[sla-stats] done — ${rooms.length} rooms processed`);
            res.json({ from, to, sla_rows, sla_coach_rows });
        } catch (err) {
            console.error('[sla-stats] error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
