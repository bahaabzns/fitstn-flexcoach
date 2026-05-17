// ExpressScheduler — runs once daily at WINDOW_START (11:00 local) to snapshot
// Fit Express rooms from Supabase into fit_express_schedule.
// Fit Express is a scheduled workload (not a live queue), so it needs its own
// tracking separate from the QueueEngine.

const { UTC_OFFSET, TENANT_ID } = require('../constants/sla-rules');

const WORKING_DAYS  = [0, 1, 2, 3, 4]; // Sun–Thu
const WINDOW_START  = 11;               // 11:00 local
const PACKAGE_NAME  = 'Fit Express';

class ExpressScheduler {
    constructor({ sql, supabase, ensureSupabaseAuth, broadcast }) {
        this.sql                = sql;
        this.supabase           = supabase;
        this.ensureSupabaseAuth = ensureSupabaseAuth;
        this.broadcast          = broadcast;
        this._timer             = null;
    }

    start() {
        this._scheduleNext();
        console.log('[ExpressScheduler] started — runs daily at', WINDOW_START + ':00 local');
    }

    stop() {
        if (this._timer) clearTimeout(this._timer);
    }

    _scheduleNext() {
        const msUntilWindow = this._msUntilNextWindow();
        this._timer = setTimeout(() => {
            this._runSafe();
            // Re-schedule for the same time tomorrow
            this._timer = setInterval(() => this._runSafe(), 24 * 3_600_000);
        }, msUntilWindow);
    }

    _msUntilNextWindow() {
        const nowUtc    = Date.now();
        const localNow  = new Date(nowUtc + UTC_OFFSET * 3_600_000);
        const localHour = localNow.getUTCHours();
        const localMin  = localNow.getUTCMinutes();

        // Minutes elapsed today past WINDOW_START
        const minutesPastWindow = (localHour - WINDOW_START) * 60 + localMin;

        if (minutesPastWindow < 0) {
            // Not yet reached today — wait until today's window
            return Math.abs(minutesPastWindow) * 60_000;
        }
        // Already past — wait until tomorrow's window
        const minutesUntilMidnight = (24 - localHour) * 60 - localMin;
        return (minutesUntilMidnight + WINDOW_START * 60) * 60_000;
    }

    _runSafe() {
        const localNow  = new Date(Date.now() + UTC_OFFSET * 3_600_000);
        const weekday   = localNow.getUTCDay();
        const dateStr   = localNow.toISOString().slice(0, 10);

        if (!WORKING_DAYS.includes(weekday)) {
            console.log('[ExpressScheduler] skipping — not a working day (weekday=' + weekday + ')');
            return;
        }

        this._snapshot(dateStr, weekday).catch(err =>
            console.error('[ExpressScheduler] run error:', err.message)
        );
    }

    async _snapshot(dateStr, weekday) {
        console.log('[ExpressScheduler] snapshotting Fit Express for', dateStr);
        await this.ensureSupabaseAuth();

        // Fetch all Fit Express rooms where last message is from client (still pending)
        const { data: pending, error: pendingErr } = await this.supabase.rpc('get_chat_rooms_paginated', {
            p_assigned_staff_id:          null,
            p_client_gender:              null,
            p_coach_id:                   null,
            p_ghost_days:                 null,
            p_ghost_only:                 false,
            p_last_interaction:           null,
            p_last_interaction_from:      null,
            p_last_interaction_to:        null,
            p_last_message_from:          'client',
            p_limit:                      1,
            p_no_assigned_staff:          false,
            p_offset:                     0,
            p_package_id:                 null,
            p_search:                     null,
            p_staff_id:                   null,
            p_subscription_start_date:    null,
            p_subscription_start_weekday: weekday,
            p_subscription_status:        null,
            p_subscription_t_status:      null,
            p_tenant_id:                  TENANT_ID,
            p_unread_only:                false,
        });

        if (pendingErr) {
            console.error('[ExpressScheduler] Supabase error (pending):', pendingErr.message);
            return;
        }

        // Fetch total rooms (regardless of reply state) scheduled for today's weekday
        const { data: total, error: totalErr } = await this.supabase.rpc('get_chat_rooms_paginated', {
            p_assigned_staff_id:          null,
            p_client_gender:              null,
            p_coach_id:                   null,
            p_ghost_days:                 null,
            p_ghost_only:                 false,
            p_last_interaction:           null,
            p_last_interaction_from:      null,
            p_last_interaction_to:        null,
            p_last_message_from:          null,
            p_limit:                      1,
            p_no_assigned_staff:          false,
            p_offset:                     0,
            p_package_id:                 null,
            p_search:                     null,
            p_staff_id:                   null,
            p_subscription_start_date:    null,
            p_subscription_start_weekday: weekday,
            p_subscription_status:        null,
            p_subscription_t_status:      null,
            p_tenant_id:                  TENANT_ID,
            p_unread_only:                false,
        });

        if (totalErr) {
            console.error('[ExpressScheduler] Supabase error (total):', totalErr.message);
            return;
        }

        const totalRooms   = total?.total   ?? 0;
        const pendingCount = pending?.total  ?? 0;
        const repliedCount = Math.max(0, totalRooms - pendingCount);
        const completion   = totalRooms > 0
            ? Math.round((repliedCount / totalRooms) * 10000) / 100
            : 0;

        try {
            await this.sql`
                INSERT INTO fit_express_schedule
                    (schedule_date, weekday, total_rooms, pending_count, replied_count, completion_pct)
                VALUES
                    (${dateStr}, ${weekday}, ${totalRooms}, ${pendingCount}, ${repliedCount}, ${completion})
                ON CONFLICT (schedule_date, COALESCE(coach_name, ''))
                DO UPDATE SET
                    total_rooms   = EXCLUDED.total_rooms,
                    pending_count = EXCLUDED.pending_count,
                    replied_count = EXCLUDED.replied_count,
                    completion_pct = EXCLUDED.completion_pct,
                    updated_at    = NOW()
            `;

            console.log(`[ExpressScheduler] done — ${repliedCount}/${totalRooms} replied (${completion}%) for ${dateStr}`);

            if (this.broadcast) {
                this.broadcast('express_schedule', { date: dateStr, weekday, totalRooms, pendingCount, repliedCount, completion });
            }
        } catch (err) {
            console.error('[ExpressScheduler] DB write failed:', err.message);
        }
    }
}

module.exports = ExpressScheduler;
