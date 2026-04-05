# GLOSSARY.md — Project Glossary

> Every domain term used in this project. If a word could confuse someone new, define it here.

---

| Term | Definition |
|------|-----------|
| **Agent** | A fitness coach/staff member who handles client interactions and chat sessions |
| **Shift** | A work period when an agent clocks in — has start_time, end_time, and associated breaks |
| **Shift Break** | A break taken during an active shift — deducted from gross shift time to get effective work time |
| **Session** | An active chat conversation between an agent and a client on FlexCoach |
| **Activity Event** | A logged action: message_sent, shift_started, idle_resumed, tab_focus_lost, etc. |
| **Idle State** | Agent inactive for ≥2 minutes (configurable) — generates idle_started/idle_resumed events |
| **On Break** | Agent has an active shift with an ongoing (unclosed) break |
| **SLA Cutoff Time** | Service Level Agreement threshold — max acceptable response time for agents |
| **FitStn ID** | Identifier linking an agent to the FitStn system |
| **CRM ID** | Identifier linking an agent to the CRM system |
| **FlexCoach** | External chat/coaching platform where agents interact with clients |
| **Supabase** | Backend-as-a-service used for FlexCoach platform data access |
| **API_BASE** | The base server URL — toggled between localhost (dev) and render.com (production) in config.js |
| **RTM** | Real-Time Monitoring — the core purpose of this system |
