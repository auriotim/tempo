#!/usr/bin/env node
/**
 * Tempo MCP Server
 * Exposes Tempo time-tracking, expenses, and backlog data to Claude.
 *
 * Tools:
 *   list_clients        — list all active clients and their sub-projects
 *   get_time_summary    — totals by client/project for a date range
 *   list_time_entries   — detailed time log with filters
 *   add_time_entry      — log a new time entry
 *   list_expenses       — browse expenses with filters
 *   add_expense         — add an expense
 *   get_backlog         — list backlog items (active / this-week / all)
 *   add_backlog_item    — create a backlog item
 *   update_backlog_item — move to week, change priority, mark done, etc.
 *
 * Required env vars:
 *   TEMPO_SUPABASE_URL              — Supabase project URL
 *   TEMPO_SUPABASE_SERVICE_ROLE_KEY — Service-role key (bypasses RLS)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

// ── Env ────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.TEMPO_SUPABASE_URL
const SUPABASE_KEY = process.env.TEMPO_SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    'Missing required env vars: TEMPO_SUPABASE_URL and TEMPO_SUPABASE_SERVICE_ROLE_KEY'
  )
  process.exit(1)
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── Types (mirrors the JS data objects stored in .data JSONB) ──────────────────

interface Client {
  id: string
  name: string
  type: 'client' | 'rd' | 'internal'
  rate: number | null
  color: string
  status: string
  createdAt: string
}

interface Project {
  id: string
  clientId: string
  name: string
  status: string
  createdAt: string
}

interface TimeEntry {
  id: string
  clientId: string
  projectId: string | null
  userId: string
  date: string
  hours: number
  notes: string
  createdAt: string
  visibility?: string
}

interface Expense {
  id: string
  clientId: string
  projectId: string | null
  userId: string
  date: string
  amount: number
  description: string
  category?: string
  createdAt: string
  visibility?: string
}

interface BacklogItem {
  id: string
  title: string
  clientId: string
  projectId: string | null
  priority: 'high' | 'medium' | 'low'
  weekOf: string | null          // ISO date of Monday — null = not scheduled
  archivedAt: string | null      // non-null = done/archived
  dueDate: string | null
  urgent: boolean
  recurFreq: string | null
  notes: string
  createdBy: string
  lastTouchedAt: string | null
  createdAt: string
  visibility?: string
  effort?: 'xs' | 's' | 'm' | 'l' | 'xl' | null
  tags?: string[]
}

interface TeamMember {
  id: string
  name: string
  email: string
  color: string
  authId?: string
  createdAt: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Fetch ALL rows from a table, pulling the .data JSONB blob */
async function fetchAll<T>(table: string): Promise<T[]> {
  const { data, error } = await supabase.from(table).select('id, data')
  if (error) throw new Error(`DB error (${table}): ${error.message}`)
  return (data ?? []).map((r: { id: string; data: T }) => r.data as T)
}

/** Fetch client/project name by id from pre-loaded maps */
function clientName(clients: Client[], id: string): string {
  return clients.find(c => c.id === id)?.name ?? id
}
function projectName(projects: Project[], id: string | null): string {
  if (!id) return ''
  return projects.find(p => p.id === id)?.name ?? id
}
function memberName(members: TeamMember[], id: string): string {
  return members.find(m => m.id === id)?.name ?? id
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function currentWeek(): string {
  const d = new Date()
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  const m = new Date(d.getFullYear(), d.getMonth(), diff)
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(m.getDate()).padStart(2, '0')}`
}

function firstOfMonth(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`
}

function fmtHours(h: number): string {
  if (!h || h < 0) return '0:00'
  const hrs = Math.floor(h)
  const min = Math.round((h - hrs) * 60)
  return `${hrs}:${String(min).padStart(2, '0')}`
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// ── Tool definitions ───────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'list_clients',
    description:
      'List all active clients with their type (client/rd/internal), hourly rate, ' +
      'and sub-projects. Use this to get client and project IDs needed by other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        include_archived: {
          type: 'boolean',
          description: 'Include archived clients (default false)',
        },
      },
    },
  },
  {
    name: 'get_time_summary',
    description:
      'Get a summary of logged hours grouped by client and project for a date range. ' +
      'Returns totals per client, total billable vs R&D vs internal, and grand total. ' +
      'Defaults to the current month if no dates provided.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start date YYYY-MM-DD (default: first of current month)',
        },
        to: {
          type: 'string',
          description: 'End date YYYY-MM-DD (default: today)',
        },
        client_name: {
          type: 'string',
          description: 'Filter to one client (partial name match, case-insensitive)',
        },
        user_name: {
          type: 'string',
          description: 'Filter to one team member (partial name match)',
        },
      },
    },
  },
  {
    name: 'list_time_entries',
    description:
      'List individual time log entries with optional filters. ' +
      'Returns date, hours, client, project, notes, and who logged it.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start date YYYY-MM-DD',
        },
        to: {
          type: 'string',
          description: 'End date YYYY-MM-DD',
        },
        client_name: {
          type: 'string',
          description: 'Filter by client name (partial, case-insensitive)',
        },
        user_name: {
          type: 'string',
          description: 'Filter by team member name (partial, case-insensitive)',
        },
        limit: {
          type: 'number',
          description: 'Max entries to return (default 30, max 200)',
        },
      },
    },
  },
  {
    name: 'add_time_entry',
    description:
      'Log a new time entry. Provide client name (or partial match) and optionally project name. ' +
      'If client_name matches multiple clients, returns the list so you can be more specific.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: {
          type: 'string',
          description: 'Client name (partial match accepted)',
        },
        project_name: {
          type: 'string',
          description: 'Sub-project name (optional, partial match)',
        },
        hours: {
          type: 'number',
          description: 'Hours to log (e.g. 1.5 for 1h30m)',
        },
        date: {
          type: 'string',
          description: 'Date YYYY-MM-DD (default: today)',
        },
        notes: {
          type: 'string',
          description: 'Description of work done',
        },
        user_name: {
          type: 'string',
          description: 'Team member name (defaults to the first/only member if unambiguous)',
        },
      },
      required: ['client_name', 'hours'],
    },
  },
  {
    name: 'list_expenses',
    description:
      'List expense entries with optional filters. Returns date, amount, description, client.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start date YYYY-MM-DD (default: first of current month)',
        },
        to: {
          type: 'string',
          description: 'End date YYYY-MM-DD (default: today)',
        },
        client_name: {
          type: 'string',
          description: 'Filter by client name (partial, case-insensitive)',
        },
        limit: {
          type: 'number',
          description: 'Max entries (default 30, max 200)',
        },
      },
    },
  },
  {
    name: 'add_expense',
    description: 'Add a new expense entry.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: {
          type: 'string',
          description: 'Client name (partial match)',
        },
        project_name: {
          type: 'string',
          description: 'Sub-project name (optional)',
        },
        amount: {
          type: 'number',
          description: 'Amount in dollars',
        },
        description: {
          type: 'string',
          description: 'What the expense was for',
        },
        date: {
          type: 'string',
          description: 'Date YYYY-MM-DD (default: today)',
        },
        user_name: {
          type: 'string',
          description: 'Team member name (defaults to first/only member)',
        },
      },
      required: ['client_name', 'amount', 'description'],
    },
  },
  {
    name: 'get_backlog',
    description:
      'List backlog items. By default returns active (not archived) items scheduled for ' +
      'this week plus unscheduled items. Use filter="all" to see everything, ' +
      'filter="this_week" for just this week\'s scheduled work, ' +
      'filter="unscheduled" for items not yet assigned to a week, ' +
      'filter="done" for recently archived items.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['active', 'this_week', 'unscheduled', 'done', 'all'],
          description: 'Which items to show (default: "active" = this_week + unscheduled)',
        },
        client_name: {
          type: 'string',
          description: 'Filter by client name (partial, case-insensitive)',
        },
        priority: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Filter by priority',
        },
        limit: {
          type: 'number',
          description: 'Max items (default 50)',
        },
      },
    },
  },
  {
    name: 'add_backlog_item',
    description: 'Add a new item to the backlog.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Task title',
        },
        client_name: {
          type: 'string',
          description: 'Client name (partial match, optional — defaults to Internal if omitted)',
        },
        project_name: {
          type: 'string',
          description: 'Sub-project name (optional)',
        },
        priority: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Priority (default: medium)',
        },
        notes: {
          type: 'string',
          description: 'Additional notes or context',
        },
        due_date: {
          type: 'string',
          description: 'Due date YYYY-MM-DD (optional)',
        },
        schedule_this_week: {
          type: 'boolean',
          description: 'Set true to schedule for the current week (default false = unscheduled)',
        },
        urgent: {
          type: 'boolean',
          description: 'Mark as urgent (default false)',
        },
        user_name: {
          type: 'string',
          description: 'Team member creating the item (defaults to first/only member)',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_backlog_item',
    description:
      'Update a backlog item — change priority, schedule it for a week, mark it done, ' +
      'or edit notes. Identify the item by its id or by a title substring.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Exact item ID',
        },
        title_match: {
          type: 'string',
          description: 'Substring to find the item by title (case-insensitive; must match exactly one item)',
        },
        title: {
          type: 'string',
          description: 'New title',
        },
        priority: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'New priority',
        },
        notes: {
          type: 'string',
          description: 'New notes',
        },
        due_date: {
          type: 'string',
          description: 'New due date YYYY-MM-DD (set to "" to clear)',
        },
        urgent: {
          type: 'boolean',
          description: 'Set urgent flag',
        },
        schedule_week: {
          type: 'string',
          description: 'Move to this week\'s Monday date (YYYY-MM-DD). Use "this_week" for the current week, "none" to unschedule.',
        },
        mark_done: {
          type: 'boolean',
          description: 'Archive/complete the item',
        },
        reopen: {
          type: 'boolean',
          description: 'Un-archive a done item and put it back in the active backlog',
        },
      },
    },
  },
]

// ── Loader helpers ─────────────────────────────────────────────────────────────

async function loadAll() {
  const [clients, projects, timeEntries, expenses, backlog, members] = await Promise.all([
    fetchAll<Client>('clients'),
    fetchAll<Project>('projects'),
    fetchAll<TimeEntry>('time_entries'),
    fetchAll<Expense>('expenses'),
    fetchAll<BacklogItem>('backlog_items'),
    fetchAll<TeamMember>('team_members'),
  ])
  return { clients, projects, timeEntries, expenses, backlog, members }
}

function resolveClient(clients: Client[], name: string): Client[] {
  const q = name.toLowerCase()
  return clients.filter(c => c.name.toLowerCase().includes(q) && c.status !== 'archived')
}

function resolveProject(projects: Project[], clientId: string, name: string): Project | null {
  const q = name.toLowerCase()
  return projects.find(p => p.clientId === clientId && p.name.toLowerCase().includes(q)) ?? null
}

function resolveMember(members: TeamMember[], name: string): TeamMember | null {
  if (!name) return members[0] ?? null
  const q = name.toLowerCase()
  return members.find(m => m.name.toLowerCase().includes(q)) ?? null
}

// ── Handlers ───────────────────────────────────────────────────────────────────

// list_clients

const ListClientsArgs = z.object({
  include_archived: z.boolean().default(false),
})

async function handleListClients(rawArgs: unknown): Promise<string> {
  const args = ListClientsArgs.parse(rawArgs ?? {})
  const { clients, projects } = await loadAll()

  const visible = args.include_archived
    ? clients
    : clients.filter(c => c.status !== 'archived')

  if (visible.length === 0) return 'No clients found.'

  const typeOrder = { client: 0, rd: 1, internal: 2 }
  const sorted = [...visible].sort((a, b) => (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3))

  return sorted
    .map(c => {
      const ps = projects.filter(p => p.clientId === c.id && p.status !== 'archived')
      const rateStr = c.rate ? `  rate: $${c.rate}/hr` : ''
      const projStr = ps.length
        ? `\n    projects: ${ps.map(p => p.name).join(', ')}`
        : ''
      return `[${c.type.toUpperCase()}] ${c.name}${rateStr}${projStr}\n  id: ${c.id}`
    })
    .join('\n\n')
}

// get_time_summary

const GetTimeSummaryArgs = z.object({
  from:        z.string().default(''),
  to:          z.string().default(''),
  client_name: z.string().optional(),
  user_name:   z.string().optional(),
})

async function handleGetTimeSummary(rawArgs: unknown): Promise<string> {
  const args = GetTimeSummaryArgs.parse(rawArgs ?? {})
  const from = args.from || firstOfMonth()
  const to   = args.to   || todayStr()

  const { clients, projects, timeEntries, members } = await loadAll()

  let entries = timeEntries.filter(e => e.date >= from && e.date <= to)

  if (args.client_name) {
    const matched = resolveClient(clients, args.client_name).map(c => c.id)
    entries = entries.filter(e => matched.includes(e.clientId))
  }
  if (args.user_name) {
    const m = resolveMember(members, args.user_name)
    if (m) entries = entries.filter(e => e.userId === m.id)
  }

  if (entries.length === 0) {
    return `No time entries found between ${from} and ${to}.`
  }

  // Group by clientId → projectId
  const byClient: Record<string, Record<string, number>> = {}
  for (const e of entries) {
    if (!byClient[e.clientId]) byClient[e.clientId] = {}
    const pk = e.projectId ?? '__none__'
    byClient[e.clientId][pk] = (byClient[e.clientId][pk] ?? 0) + e.hours
  }

  const lines: string[] = [`Time summary: ${from} → ${to}\n`]
  let grandTotal = 0
  const byType: Record<string, number> = {}

  for (const [cid, projMap] of Object.entries(byClient)) {
    const cl = clients.find(c => c.id === cid)
    const cName = cl?.name ?? cid
    const cType = cl?.type ?? 'client'
    const cTotal = Object.values(projMap).reduce((a, b) => a + b, 0)
    grandTotal += cTotal
    byType[cType] = (byType[cType] ?? 0) + cTotal

    lines.push(`${cName} [${cType}]  →  ${fmtHours(cTotal)} (${cTotal.toFixed(2)}h)`)
    for (const [pid, hrs] of Object.entries(projMap)) {
      const pName = pid === '__none__' ? 'no project' : projectName(projects, pid)
      lines.push(`    ${pName}: ${fmtHours(hrs)}`)
    }
  }

  lines.push(`\nGrand total: ${fmtHours(grandTotal)} (${grandTotal.toFixed(2)}h)`)
  if (byType.client)   lines.push(`  Client (billable): ${fmtHours(byType.client)}`)
  if (byType.rd)       lines.push(`  R&D: ${fmtHours(byType.rd)}`)
  if (byType.internal) lines.push(`  Internal: ${fmtHours(byType.internal)}`)

  return lines.join('\n')
}

// list_time_entries

const ListTimeEntriesArgs = z.object({
  from:        z.string().optional(),
  to:          z.string().optional(),
  client_name: z.string().optional(),
  user_name:   z.string().optional(),
  limit:       z.number().int().min(1).max(200).default(30),
})

async function handleListTimeEntries(rawArgs: unknown): Promise<string> {
  const args = ListTimeEntriesArgs.parse(rawArgs ?? {})
  const { clients, projects, timeEntries, members } = await loadAll()

  let entries = [...timeEntries].sort((a, b) => b.date.localeCompare(a.date))

  if (args.from) entries = entries.filter(e => e.date >= args.from!)
  if (args.to)   entries = entries.filter(e => e.date <= args.to!)

  if (args.client_name) {
    const matched = resolveClient(clients, args.client_name).map(c => c.id)
    entries = entries.filter(e => matched.includes(e.clientId))
  }
  if (args.user_name) {
    const m = resolveMember(members, args.user_name)
    if (m) entries = entries.filter(e => e.userId === m.id)
  }

  entries = entries.slice(0, args.limit)
  if (entries.length === 0) return 'No time entries found.'

  return entries
    .map(e => {
      const cName = clientName(clients, e.clientId)
      const pName = projectName(projects, e.projectId ?? null)
      const uName = memberName(members, e.userId)
      const proj  = pName ? ` / ${pName}` : ''
      const notes = e.notes ? `  "${e.notes}"` : ''
      return `${e.date}  ${fmtHours(e.hours)}  ${cName}${proj}  [${uName}]${notes}\n  id: ${e.id}`
    })
    .join('\n')
}

// add_time_entry

const AddTimeEntryArgs = z.object({
  client_name:  z.string(),
  project_name: z.string().optional(),
  hours:        z.number().positive(),
  date:         z.string().optional(),
  notes:        z.string().optional(),
  user_name:    z.string().optional(),
})

async function handleAddTimeEntry(rawArgs: unknown): Promise<string> {
  const args = AddTimeEntryArgs.parse(rawArgs)
  const { clients, projects, members } = await loadAll()

  const matched = resolveClient(clients, args.client_name)
  if (matched.length === 0) return `No client found matching "${args.client_name}". Use list_clients to see available clients.`
  if (matched.length > 1)   return `Multiple clients match "${args.client_name}":\n${matched.map(c => `  ${c.name}`).join('\n')}\nPlease be more specific.`

  const client = matched[0]
  let projectId: string | null = null
  if (args.project_name) {
    const p = resolveProject(projects, client.id, args.project_name)
    if (!p) return `No project matching "${args.project_name}" found under ${client.name}.`
    projectId = p.id
  }

  const member = resolveMember(members, args.user_name ?? '')
  if (!member) return 'No team member found. Please specify user_name.'

  const entry: TimeEntry = {
    id:        uid(),
    clientId:  client.id,
    projectId,
    userId:    member.id,
    date:      args.date ?? todayStr(),
    hours:     args.hours,
    notes:     args.notes ?? '',
    createdAt: new Date().toISOString(),
    visibility: 'public',
  }

  const { error } = await supabase
    .from('time_entries')
    .upsert({ id: entry.id, data: entry, updated_at: new Date().toISOString() })

  if (error) return `Failed to save time entry: ${error.message}`

  const pName = projectId ? ` / ${projectName(projects, projectId)}` : ''
  return (
    `Logged ${fmtHours(args.hours)} (${args.hours}h) on ${entry.date}\n` +
    `  Client: ${client.name}${pName}\n` +
    `  By: ${member.name}\n` +
    (entry.notes ? `  Notes: "${entry.notes}"\n` : '') +
    `  id: ${entry.id}`
  )
}

// list_expenses

const ListExpensesArgs = z.object({
  from:        z.string().optional(),
  to:          z.string().optional(),
  client_name: z.string().optional(),
  limit:       z.number().int().min(1).max(200).default(30),
})

async function handleListExpenses(rawArgs: unknown): Promise<string> {
  const args = ListExpensesArgs.parse(rawArgs ?? {})
  const { clients, projects, expenses, members } = await loadAll()

  const from = args.from ?? firstOfMonth()
  const to   = args.to   ?? todayStr()

  let entries = [...expenses]
    .filter(e => e.date >= from && e.date <= to)
    .sort((a, b) => b.date.localeCompare(a.date))

  if (args.client_name) {
    const matched = resolveClient(clients, args.client_name).map(c => c.id)
    entries = entries.filter(e => matched.includes(e.clientId))
  }

  entries = entries.slice(0, args.limit)
  if (entries.length === 0) return `No expenses found between ${from} and ${to}.`

  const total = entries.reduce((s, e) => s + e.amount, 0)
  const lines = entries.map(e => {
    const cName = clientName(clients, e.clientId)
    const pName = projectName(projects, e.projectId ?? null)
    const proj  = pName ? ` / ${pName}` : ''
    return `${e.date}  $${e.amount.toFixed(2)}  ${cName}${proj}  ${e.description}\n  id: ${e.id}`
  })

  return `${lines.join('\n')}\n\nTotal: $${total.toFixed(2)} (${entries.length} expense${entries.length === 1 ? '' : 's'})`
}

// add_expense

const AddExpenseArgs = z.object({
  client_name:  z.string(),
  project_name: z.string().optional(),
  amount:       z.number().positive(),
  description:  z.string().min(1),
  date:         z.string().optional(),
  user_name:    z.string().optional(),
})

async function handleAddExpense(rawArgs: unknown): Promise<string> {
  const args = AddExpenseArgs.parse(rawArgs)
  const { clients, projects, members } = await loadAll()

  const matched = resolveClient(clients, args.client_name)
  if (matched.length === 0) return `No client found matching "${args.client_name}".`
  if (matched.length > 1)   return `Multiple clients match "${args.client_name}":\n${matched.map(c => `  ${c.name}`).join('\n')}\nPlease be more specific.`

  const client = matched[0]
  let projectId: string | null = null
  if (args.project_name) {
    const p = resolveProject(projects, client.id, args.project_name)
    if (!p) return `No project matching "${args.project_name}" found under ${client.name}.`
    projectId = p.id
  }

  const member = resolveMember(members, args.user_name ?? '')
  if (!member) return 'No team member found.'

  const expense: Expense = {
    id:          uid(),
    clientId:    client.id,
    projectId,
    userId:      member.id,
    date:        args.date ?? todayStr(),
    amount:      args.amount,
    description: args.description,
    createdAt:   new Date().toISOString(),
    visibility:  'public',
  }

  const { error } = await supabase
    .from('expenses')
    .upsert({ id: expense.id, data: expense, updated_at: new Date().toISOString() })

  if (error) return `Failed to save expense: ${error.message}`

  const pName = projectId ? ` / ${projectName(projects, projectId)}` : ''
  return (
    `Expense added: $${expense.amount.toFixed(2)} on ${expense.date}\n` +
    `  Client: ${client.name}${pName}\n` +
    `  Description: ${expense.description}\n` +
    `  id: ${expense.id}`
  )
}

// get_backlog

const GetBacklogArgs = z.object({
  filter:      z.enum(['active', 'this_week', 'unscheduled', 'done', 'all']).default('active'),
  client_name: z.string().optional(),
  priority:    z.enum(['high', 'medium', 'low']).optional(),
  limit:       z.number().int().min(1).max(200).default(50),
})

async function handleGetBacklog(rawArgs: unknown): Promise<string> {
  const args = GetBacklogArgs.parse(rawArgs ?? {})
  const { clients, projects, backlog, members } = await loadAll()

  const cw = currentWeek()
  let items = [...backlog]

  // Apply status filter
  switch (args.filter) {
    case 'this_week':
      items = items.filter(b => b.weekOf === cw && !b.archivedAt)
      break
    case 'unscheduled':
      items = items.filter(b => !b.weekOf && !b.archivedAt)
      break
    case 'done':
      items = items.filter(b => !!b.archivedAt)
      break
    case 'active':
      items = items.filter(b => !b.archivedAt)
      break
    case 'all':
      // no filter
      break
  }

  if (args.client_name) {
    const matched = resolveClient(clients, args.client_name).map(c => c.id)
    items = items.filter(b => matched.includes(b.clientId))
  }
  if (args.priority) {
    items = items.filter(b => b.priority === args.priority)
  }

  // Sort: urgent first, then by priority, then by due date
  const priOrder = { high: 0, medium: 1, low: 2 }
  items.sort((a, b) => {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1
    const pd = (priOrder[a.priority] ?? 1) - (priOrder[b.priority] ?? 1)
    if (pd !== 0) return pd
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
    if (a.dueDate) return -1
    if (b.dueDate) return 1
    return 0
  })

  items = items.slice(0, args.limit)
  if (items.length === 0) return `No backlog items found (filter: ${args.filter}).`

  const header = `Backlog (${args.filter}, ${items.length} item${items.length === 1 ? '' : 's'})\n`
  const body = items
    .map(b => {
      const cName = clientName(clients, b.clientId)
      const pName = projectName(projects, b.projectId ?? null)
      const proj  = pName ? ` / ${pName}` : ''
      const week  = b.weekOf ? ` [week: ${b.weekOf}]` : ' [unscheduled]'
      const due   = b.dueDate ? ` due: ${b.dueDate}` : ''
      const urgentFlag = b.urgent ? ' ⚡ URGENT' : ''
      const done  = b.archivedAt ? ` ✓ done ${b.archivedAt.slice(0, 10)}` : ''
      const notes = b.notes ? `\n    notes: ${b.notes}` : ''
      return (
        `[${b.priority.toUpperCase()}]${urgentFlag} ${b.title}${done}\n` +
        `    ${cName}${proj}${week}${due}${notes}\n    id: ${b.id}`
      )
    })
    .join('\n\n')

  return header + '\n' + body
}

// add_backlog_item

const AddBacklogItemArgs = z.object({
  title:               z.string().min(1),
  client_name:         z.string().optional(),
  project_name:        z.string().optional(),
  priority:            z.enum(['high', 'medium', 'low']).default('medium'),
  notes:               z.string().optional(),
  due_date:            z.string().optional(),
  schedule_this_week:  z.boolean().default(false),
  urgent:              z.boolean().default(false),
  user_name:           z.string().optional(),
})

async function handleAddBacklogItem(rawArgs: unknown): Promise<string> {
  const args = AddBacklogItemArgs.parse(rawArgs)
  const { clients, projects, members } = await loadAll()

  // Default to Internal client if none specified
  let clientId: string
  if (args.client_name) {
    const matched = resolveClient(clients, args.client_name)
    if (matched.length === 0) return `No client found matching "${args.client_name}".`
    if (matched.length > 1)   return `Multiple clients match "${args.client_name}":\n${matched.map(c => `  ${c.name}`).join('\n')}`
    clientId = matched[0].id
  } else {
    const internal = clients.find(c => c.type === 'internal' && c.status !== 'archived')
    clientId = internal?.id ?? clients[0]?.id ?? ''
  }

  let projectId: string | null = null
  if (args.project_name) {
    const p = resolveProject(projects, clientId, args.project_name)
    if (!p) return `No project matching "${args.project_name}" found.`
    projectId = p.id
  }

  const member = resolveMember(members, args.user_name ?? '')

  const item: BacklogItem = {
    id:            uid(),
    title:         args.title,
    clientId,
    projectId,
    priority:      args.priority,
    weekOf:        args.schedule_this_week ? currentWeek() : null,
    archivedAt:    null,
    dueDate:       args.due_date ?? null,
    urgent:        args.urgent,
    recurFreq:     null,
    notes:         args.notes ?? '',
    createdBy:     member?.id ?? '',
    lastTouchedAt: null,
    createdAt:     new Date().toISOString(),
    visibility:    'public',
  }

  const { error } = await supabase
    .from('backlog_items')
    .upsert({ id: item.id, data: item, updated_at: new Date().toISOString() })

  if (error) return `Failed to create backlog item: ${error.message}`

  const cName = clientName(clients, clientId)
  const weekStr = item.weekOf ? `scheduled for week of ${item.weekOf}` : 'unscheduled'
  return (
    `Backlog item created (${weekStr}):\n` +
    `  [${item.priority.toUpperCase()}] ${item.title}\n` +
    `  Client: ${cName}\n` +
    (item.notes ? `  Notes: "${item.notes}"\n` : '') +
    `  id: ${item.id}`
  )
}

// update_backlog_item

const UpdateBacklogItemArgs = z.object({
  id:            z.string().optional(),
  title_match:   z.string().optional(),
  title:         z.string().optional(),
  priority:      z.enum(['high', 'medium', 'low']).optional(),
  notes:         z.string().optional(),
  due_date:      z.string().optional(),
  urgent:        z.boolean().optional(),
  schedule_week: z.string().optional(),
  mark_done:     z.boolean().optional(),
  reopen:        z.boolean().optional(),
})

async function handleUpdateBacklogItem(rawArgs: unknown): Promise<string> {
  const args = UpdateBacklogItemArgs.parse(rawArgs)

  if (!args.id && !args.title_match) {
    return 'Provide either id or title_match to identify the backlog item.'
  }

  const { clients, backlog } = await loadAll()

  let item: BacklogItem | undefined
  if (args.id) {
    item = backlog.find(b => b.id === args.id)
  } else if (args.title_match) {
    const q = args.title_match.toLowerCase()
    const matches = backlog.filter(b => b.title.toLowerCase().includes(q))
    if (matches.length === 0) return `No backlog item found matching title "${args.title_match}".`
    if (matches.length > 1) {
      return `Multiple items match "${args.title_match}":\n${matches.map(b => `  ${b.title} (id: ${b.id})`).join('\n')}\nPlease use the id to be specific.`
    }
    item = matches[0]
  }

  if (!item) return `Backlog item not found.`

  // Apply changes
  const updated: BacklogItem = { ...item }

  if (args.title     !== undefined) updated.title    = args.title
  if (args.priority  !== undefined) updated.priority = args.priority
  if (args.notes     !== undefined) updated.notes    = args.notes
  if (args.urgent    !== undefined) updated.urgent   = args.urgent

  if (args.due_date !== undefined) {
    updated.dueDate = args.due_date === '' ? null : args.due_date
  }

  if (args.schedule_week !== undefined) {
    if (args.schedule_week === 'none') {
      updated.weekOf = null
    } else if (args.schedule_week === 'this_week') {
      updated.weekOf = currentWeek()
    } else {
      updated.weekOf = args.schedule_week
    }
  }

  if (args.mark_done) {
    updated.archivedAt = new Date().toISOString()
    updated.weekOf     = null
  }
  if (args.reopen) {
    updated.archivedAt = null
  }

  updated.lastTouchedAt = new Date().toISOString()

  const { error } = await supabase
    .from('backlog_items')
    .upsert({ id: updated.id, data: updated, updated_at: new Date().toISOString() })

  if (error) return `Failed to update backlog item: ${error.message}`

  const cName  = clientName(clients, updated.clientId)
  const doneStr  = updated.archivedAt ? ` ✓ done ${updated.archivedAt.slice(0, 10)}` : ''
  const weekStr  = updated.weekOf ? ` [week: ${updated.weekOf}]` : ' [unscheduled]'
  return (
    `Updated successfully.\n` +
    `[${updated.priority.toUpperCase()}]${updated.urgent ? ' ⚡' : ''} ${updated.title}${doneStr}\n` +
    `  ${cName}${weekStr}\n` +
    `  id: ${updated.id}`
  )
}

// ── Server setup ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'tempo', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    let text: string
    switch (name) {
      case 'list_clients':         text = await handleListClients(args);       break
      case 'get_time_summary':     text = await handleGetTimeSummary(args);    break
      case 'list_time_entries':    text = await handleListTimeEntries(args);   break
      case 'add_time_entry':       text = await handleAddTimeEntry(args);      break
      case 'list_expenses':        text = await handleListExpenses(args);      break
      case 'add_expense':          text = await handleAddExpense(args);        break
      case 'get_backlog':          text = await handleGetBacklog(args);        break
      case 'add_backlog_item':     text = await handleAddBacklogItem(args);    break
      case 'update_backlog_item':  text = await handleUpdateBacklogItem(args); break
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        }
    }
    return { content: [{ type: 'text', text }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `Error in ${name}: ${message}` }],
      isError: true,
    }
  }
})

// ── Start ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('Tempo MCP server running on stdio')
