# Tempo — Setup & Deploy

## Phase 1 — The App ✅

Single-file app (`index.html`) with Supabase sync.
Open `index.html` in any browser or serve it via Netlify.
No build step required.

---

## Phase 2 — MCP Server ✅

The MCP server lives in `tempo/mcp/` and exposes Tempo to Claude in Chat, Cowork,
and Claude Code via nine tools:

| Tool | What it does |
|------|-------------|
| `list_clients` | List all clients with type, rate, and sub-projects |
| `get_time_summary` | Hours summary by client/project for a date range |
| `list_time_entries` | Detailed time log with filters |
| `add_time_entry` | Log a new time entry by client name |
| `list_expenses` | Browse expenses with filters |
| `add_expense` | Add an expense entry |
| `get_backlog` | List backlog items (active / this week / unscheduled / done) |
| `add_backlog_item` | Create a backlog item |
| `update_backlog_item` | Change priority, schedule to a week, mark done, etc. |

### 1. Get your Supabase service-role key

The MCP server uses the **service-role** key (not the anon key) so it can read and
write without RLS restrictions.

Supabase dashboard → **Project Settings → API → service_role** → copy the key.

Your project URL is: `https://boynlwmuhunnfgruwamg.supabase.co`

### 2. Install MCP dependencies

Run this once from Terminal:

```bash
cd "/Users/timsandrik/Documents/Documents - Tims MacBook Pro/20260504 Time Expense and R&D Tracking/tempo/mcp"
npm install
```

### 3. Test it locally

```bash
TEMPO_SUPABASE_URL="https://boynlwmuhunnfgruwamg.supabase.co" \
TEMPO_SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
npx tsx src/index.ts
# Should print: Tempo MCP server running on stdio
# Press Ctrl+C to stop
```

### 4. Register with Claude Desktop / Cowork

Open (or create) your Claude config file:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add the `tempo` entry inside `mcpServers` (alongside your existing `warehouse` entry):

```json
{
  "mcpServers": {
    "warehouse": {
      "...existing warehouse config..."
    },
    "tempo": {
      "command": "npx",
      "args": [
        "tsx",
        "/Users/timsandrik/Documents/Documents - Tims MacBook Pro/20260504 Time Expense and R&D Tracking/tempo/mcp/src/index.ts"
      ],
      "env": {
        "TEMPO_SUPABASE_URL": "https://boynlwmuhunnfgruwamg.supabase.co",
        "TEMPO_SUPABASE_SERVICE_ROLE_KEY": "eyJ..."
      }
    }
  }
}
```

Save the file, then **quit and relaunch** the Claude desktop app.
You should see "tempo" listed under connected MCP servers.

### 5. Verify in Claude

Open a new chat and try:

> "How many hours have I logged this month?"

Claude will call `get_time_summary` and return a breakdown from your live Tempo data.

Other useful prompts to try:
- "What's on my backlog this week?"
- "Log 1.5 hours for [client name] today — worked on [task]"
- "Add an expense of $35 for [client] — [description]"
- "Show me all unscheduled backlog items"

---

## Phase 3 (next ideas)
- Timer control via MCP — start/stop the running timer from Claude
- Cross-link with Warehouse — `source_ref: tempo:ITEM-ID` on backlog outcomes
- Recurring task suggestions — Claude notices patterns and proposes recurrence
