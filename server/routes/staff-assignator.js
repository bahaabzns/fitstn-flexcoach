const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

module.exports = function (requireAdmin) {
    const router = require("express").Router();

    // ── CRM config ──
    const CRM_BASE = "https://followup.fitforce.io";
    const CRM_EMAIL = "admin@followup.com";
    const CRM_PASSWORD = "admin123";

    // ── Supabase / FlexCoach config ──
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    const supabaseEmail = process.env.SUPABASE_USER_EMAIL || process.env.USER_EMAIL;
    const supabasePassword = process.env.SUPABASE_USER_PASSWORD || process.env.USER_PASSWORD;
    const supabase = createClient(supabaseUrl, supabaseAnonKey);

    // ── Staff mapping data ──
    const STAFF_DATA_PATH = path.resolve(__dirname, "..", "constants", "staff_data.json");
    function loadStaffData() {
        return JSON.parse(fs.readFileSync(STAFF_DATA_PATH, "utf8"));
    }

    // ── CRM helpers ──
    function extractCookies(response) {
        let rawCookies = response.headers.getSetCookie?.() || [];
        if (rawCookies.length === 0) {
            const header = response.headers.get("set-cookie");
            if (header) {
                rawCookies = header.split(/,(?=\s*[^;=]+=[^;]+)/);
            }
        }
        return rawCookies.map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
    }

    function mergeCookies(a, b) {
        const map = {};
        for (const str of [a, b]) {
            if (!str) continue;
            for (const pair of str.split("; ")) {
                const [name] = pair.split("=");
                if (name) map[name] = pair;
            }
        }
        return Object.values(map).join("; ");
    }

    async function getCrmAuthCookie() {
        const csrfRes = await fetch(`${CRM_BASE}/api/auth/csrf`);
        const csrfCookies = extractCookies(csrfRes);
        const { csrfToken } = await csrfRes.json();

        const loginRes = await fetch(`${CRM_BASE}/api/auth/callback/credentials`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: csrfCookies },
            body: new URLSearchParams({ email: CRM_EMAIL, password: CRM_PASSWORD, csrfToken }),
            redirect: "manual",
        });

        const loginCookies = extractCookies(loginRes);
        let allCookies = mergeCookies(csrfCookies, loginCookies);

        if ([301, 302, 303, 307, 308].includes(loginRes.status)) {
            const redirectUrl = loginRes.headers.get("location");
            if (redirectUrl) {
                const fullUrl = redirectUrl.startsWith("http") ? redirectUrl : `${CRM_BASE}${redirectUrl}`;
                const redirectRes = await fetch(fullUrl, { headers: { Cookie: allCookies }, redirect: "manual" });
                allCookies = mergeCookies(allCookies, extractCookies(redirectRes));
            }
        }

        if (!allCookies) throw new Error("CRM login failed — no session cookie returned");
        return allCookies;
    }

    async function fetchCrmClientCount(cookie) {
        const res = await fetch(
            `${CRM_BASE}/api/queue/list?sortBy=code&sortDirection=asc&page=1&limit=1`,
            { headers: { Cookie: cookie } }
        );
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
            const snippet = (await res.text()).substring(0, 200);
            throw new Error(`CRM returned non-JSON (${res.status}). Likely auth failed. Response: ${snippet}`);
        }
        if (!res.ok) throw new Error(`CRM API error: ${res.status} ${res.statusText}`);
        const json = await res.json();
        return json.total || 5000;
    }

    async function fetchCrmData(cookie) {
        const totalClients = await fetchCrmClientCount(cookie);
        const res = await fetch(
            `${CRM_BASE}/api/queue/list?sortBy=code&sortDirection=asc&page=1&limit=${totalClients}`,
            { headers: { Cookie: cookie } }
        );
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
            const snippet = (await res.text()).substring(0, 200);
            throw new Error(`CRM returned non-JSON (${res.status}). Likely auth failed. Response: ${snippet}`);
        }
        if (!res.ok) throw new Error(`CRM API error: ${res.status} ${res.statusText}`);
        const json = await res.json();
        return json.queueItems || json.data || json.items || (Array.isArray(json) ? json : json);
    }

    // ── FlexCoach helpers ──
    // Supabase password login disabled — see request to stop all Supabase sign-in attempts.
    async function authenticateFlexCoach() {
        return null;
    }

    // Supabase requests disabled — see request to remove all FlexCoach requests entirely.
    async function fetchFlexCoachRooms() {
        return [];
    }

    // ── Group room partner lookup ──
    // Supabase requests disabled — see request to remove all FlexCoach requests entirely.
    async function fetchGroupRoomPartners(groupRoomIds) {
        return {};
    }

    // ── Mapping ──
    async function buildMapping(crmItems, flexRooms, staffData) {
        const flexByCode = {};
        for (const room of flexRooms) {
            const code = room.client?.code?.toString();
            if (code) flexByCode[code] = room;
        }

        const staffCrmToFlex = {};
        for (const s of staffData.staff) {
            staffCrmToFlex[s.crm_id] = { flexcoach_id: s.flexcoach_id, name: s.name };
        }

        const crmByCode = {};
        for (const item of crmItems) {
            const code = item.client?.code?.toString();
            if (code) crmByCode[code] = item;
        }

        const mapped = [];
        let matched = 0;
        let unmatched = 0;

        for (const item of crmItems) {
            const code = item.client?.code?.toString();
            if (!code) continue;

            const flexRoom = flexByCode[code];
            if (!flexRoom) { unmatched++; continue; }

            const activeAssignment = item.client?.assignments?.find(a => a.isActive);
            const crmAgentId = activeAssignment?.agentId || null;
            const crmAgentName = activeAssignment?.agent?.name || null;
            const staffEntry = crmAgentId ? staffCrmToFlex[crmAgentId] : null;

            mapped.push({
                client_code: parseInt(code, 10),
                client_name: item.client?.name || null,
                chat_room_id: flexRoom.id,
                crm_agent_id: crmAgentId,
                crm_agent_name: crmAgentName,
                flexcoach_agent_id: staffEntry?.flexcoach_id || null,
                flexcoach_agent_name: staffEntry?.name || null,
            });
            matched++;
        }

        // Handle Fit Due (group) rooms — add partner agents
        const groupRooms = flexRooms.filter(r => r.is_group);
        if (groupRooms.length > 0) {
            const partnersByRoom = await fetchGroupRoomPartners(groupRooms.map(r => r.id));

            let fitDueAdded = 0;
            for (const room of groupRooms) {
                const partnerCodes = partnersByRoom[room.id] || [];
                const existingAgents = new Set();
                mapped.filter(m => m.chat_room_id === room.id).forEach(m => {
                    if (m.flexcoach_agent_id) existingAgents.add(m.flexcoach_agent_id);
                });

                for (const partnerCode of partnerCodes) {
                    const crmItem = crmByCode[partnerCode];
                    if (!crmItem) continue;

                    const activeAssignment = crmItem.client?.assignments?.find(a => a.isActive);
                    if (!activeAssignment) continue;

                    const staffEntry = staffCrmToFlex[activeAssignment.agentId];
                    if (!staffEntry || existingAgents.has(staffEntry.flexcoach_id)) continue;

                    existingAgents.add(staffEntry.flexcoach_id);
                    mapped.push({
                        client_code: parseInt(partnerCode, 10),
                        client_name: crmItem.client?.name || null,
                        chat_room_id: room.id,
                        crm_agent_id: activeAssignment.agentId,
                        crm_agent_name: activeAssignment.agent?.name || null,
                        flexcoach_agent_id: staffEntry.flexcoach_id,
                        flexcoach_agent_name: staffEntry.name,
                    });
                    fitDueAdded++;
                }
            }
        }

        return { mapped, matched, unmatched };
    }

    // ── Injection ──
    async function injectAssignments(mapping, accessToken) {
        const toAssign = mapping.filter(m => m.flexcoach_agent_id && m.chat_room_id);
        let success = 0;
        let skipped = 0;
        let failed = 0;
        const errors = [];

        for (const entry of toAssign) {
            try {
                const response = await fetch(`${supabaseUrl}/rest/v1/chat_room_members`, {
                    method: "POST",
                    headers: {
                        Apikey: supabaseAnonKey,
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json",
                        "Content-Profile": "public",
                        Prefer: "return=minimal",
                    },
                    body: JSON.stringify({
                        room_id: entry.chat_room_id,
                        staff_id: entry.flexcoach_agent_id,
                        role: "member",
                    }),
                });

                if (response.status === 201) {
                    success++;
                } else if (response.status === 409) {
                    skipped++;
                } else {
                    const errorText = await response.text();
                    failed++;
                    errors.push(`Code ${entry.client_code}: ${response.status} — ${errorText}`);
                }
            } catch (err) {
                failed++;
                errors.push(`Code ${entry.client_code}: ${err.message}`);
            }
        }

        return { totalToAssign: toAssign.length, success, skipped, failed, errors };
    }

    // ── POST /api/staff-assignator/run ──
    router.post("/run", requireAdmin, async (req, res) => {
        const isDryRun = req.body.dryRun === true;

        try {
            const staffData = loadStaffData();

            // Step 1: CRM data
            const crmCookie = await getCrmAuthCookie();
            const crmItems = await fetchCrmData(crmCookie);

            // Step 2: FlexCoach rooms
            await authenticateFlexCoach();
            const flexRooms = await fetchFlexCoachRooms();

            // Step 3: Build mapping
            const { mapped, matched, unmatched } = await buildMapping(crmItems, flexRooms, staffData);

            // Step 4: Inject (or preview in dry run)
            const assignable = mapped.filter(m => m.flexcoach_agent_id && m.chat_room_id);

            if (isDryRun) {
                return res.json({
                    dryRun: true,
                    crmClientsCount: crmItems.length,
                    flexRoomsCount: flexRooms.length,
                    matched,
                    unmatched,
                    assignableCount: assignable.length,
                    preview: assignable.slice(0, 20),
                });
            }

            throw new Error("Supabase login is disabled — assignment injection requires an authenticated session.");
        } catch (err) {
            res.status(500).json({ error: "Staff assignator failed", details: err.message });
        }
    });

    return router;
};
