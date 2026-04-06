// Compute gap-based idle: sum of inter-session gaps exceeding the threshold within a shift.
// Gaps are computed between: shift_start→first_session, between sessions, last_session→shift_end.
// If a gap >= threshold → counted as idle. If gap < threshold → counted as off-session work.
// NOTE: shifts.js has an equivalent SQL CTE version for the real-time polling endpoint.
function computeGapIdle(shiftStart, shiftEnd, sessions, activityThresholdSeconds) {
    const shiftStartMs = new Date(shiftStart).getTime();
    const shiftEndMs = new Date(shiftEnd).getTime();

    const sortedSessions = sessions.map(s => ({
        start: Math.max(new Date(s.clicked_at).getTime(), shiftStartMs),
        end: Math.min(new Date(s.ended_at).getTime(), shiftEndMs)
    }));

    let idleGapTotal = 0;
    let prevEnd = shiftStartMs;
    for (const s of sortedSessions) {
        const gapSeconds = Math.max(0, (s.start - prevEnd) / 1000);
        if (gapSeconds >= activityThresholdSeconds) {
            idleGapTotal += gapSeconds;
        }
        prevEnd = Math.max(prevEnd, s.end);
    }
    // Gap after last session to shift end
    const finalGapSeconds = Math.max(0, (shiftEndMs - prevEnd) / 1000);
    if (finalGapSeconds >= activityThresholdSeconds) {
        idleGapTotal += finalGapSeconds;
    }
    return Math.round(idleGapTotal);
}

module.exports = { computeGapIdle };
