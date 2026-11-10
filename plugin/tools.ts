import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { McpToolInfo } from "oc-secure-kit"
import { ACCESS, classifyAction, mergeAccount, normalizeAccount, validAccountId, type Account, type Discovery } from "./model.js"
import type { HuggingFaceService } from "./service.js"

export const TOOL_NAMES = [
  "huggingface_list", "huggingface_find_actions", "huggingface_run",
  "huggingface_account_upsert", "huggingface_account_remove", "huggingface_signin", "huggingface_refresh", "huggingface_request_token",
] as const

export interface ToolDefinition {
  readonly name: (typeof TOOL_NAMES)[number]
  readonly description: () => string
  readonly input: Record<string, unknown>
  readonly execute: (input: any, context: ToolContext) => Promise<{ content: string }>
}

const MAX_OUTPUT = 60_000
const json = (value: unknown) => ({ content: JSON.stringify(value, null, 2) })
const ACCOUNT = { type: "string", description: "Account id (optional when there is only one account)" }

export const USAGE = [
  "Load the 'huggingface' skill before non-trivial Hugging Face work (finding models/datasets, downloading, uploading, repos, Jobs).",
  "Search and read the Hub: huggingface_find_actions, then huggingface_run. Download, upload, repos, Jobs: the hf CLI in your shell (pixi exec hf … or a project's hf), or Python (huggingface_hub, transformers, datasets).",
  "The signed-in account's token is supplied automatically to hf, to git for huggingface.co, and to commands that reference $HF_TOKEN; never run hf auth login. Several accounts: OC_HF_ACCOUNT=<id> in front of the command.",
].join("\n")

function describe(account: Account, discovery: Discovery | undefined): string {
  const who = discovery?.name ? `${discovery.name}${discovery.fullname && discovery.fullname !== discovery.name ? ` (${discovery.fullname})` : ""}` : "not signed in"
  const orgs = discovery?.orgs?.length ? `; orgs ${discovery.orgs.join(", ")}` : ""
  return `  ${account.id}: ${who}${orgs}${discovery?.tokenRole ? `; token ${discovery.tokenRole}` : ""}${account.label ? ` (${account.label})` : ""}${discovery?.error ? ` [problem: ${discovery.error.slice(0, 160)}]` : ""}`
}

export function inventory(accounts: readonly Account[], discovery: Record<string, Discovery>): string {
  if (!accounts.length) return "No Hugging Face accounts are configured yet. Create one with huggingface_account_upsert, then huggingface_signin (or a token: auth=token, huggingface_request_token)."
  return ["Hugging Face accounts (models, datasets, Spaces, Jobs):", ...accounts.map(account => describe(account, discovery[account.id]))].join("\n")
}

/** Ranks actions by how well they match a keyword query. */
export function searchActions(tools: readonly McpToolInfo[], query: string): McpToolInfo[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1).map(word => word.replace(/s$/, ""))
  if (!words.length) return [...tools]
  const score = (tool: McpToolInfo) => {
    const name = tool.name.toLowerCase(), text = `${name} ${(tool.description ?? "").toLowerCase()}`
    return words.reduce((sum, word) => sum + (name.includes(word) ? 3 : text.includes(word) ? 1 : 0), 0)
  }
  return tools.map(tool => [tool, score(tool)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([tool]) => tool)
}

const clip = (text: string) => text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated ${text.length - MAX_OUTPUT} characters; narrow the request]` : text
const summarize = (value: unknown) => { const text = JSON.stringify(value); return text.length > 400 ? `${text.slice(0, 400)}…` : text }
const kind = (tool: McpToolInfo) => classifyAction(tool.name, tool.annotations as never)

export function createTools(service: HuggingFaceService): ToolDefinition[] {
  const caller = (context: ToolContext) => ({ sessionID: context.sessionID, agent: context.agent, source: { type: "tool" as const, messageID: context.messageID, id: context.id } })
  const check = (context: ToolContext, capability: string, entity: string, metadata?: Record<string, unknown>) =>
    service.bridge.check({ ...caller(context), capability, entities: [entity], ...(metadata && { metadata }) })

  return [
    {
      name: "huggingface_list",
      description: () => {
        const { accounts, discovery } = service.store.cached()
        return `${inventory(accounts, discovery)}\n${USAGE}\nCall this tool for details and what you may do (allow / ask = the user is prompted / deny).`
      },
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, context) => {
        const settings = await service.store.settings()
        const accounts = await Promise.all((await service.store.list()).map(async account => {
          const discovery = await service.store.discovery(account.id)
          const signIn = service.signIns.get(account.id)
          const may = Object.fromEntries(await Promise.all(["read", "write", "delete", "spend", "admin", "scripts"].map(async capability =>
            [capability, (await service.bridge.effect({ ...caller(context), capability, entity: account.id })).effect] as const)))
          return {
            id: account.id, auth: account.auth, ...(account.label && { label: account.label }),
            user: discovery?.name ?? null, orgs: discovery?.orgs ?? [], ...(discovery?.tokenRole && { token: discovery.tokenRole }),
            signedIn: await service.signedIn(account), actions: discovery?.actions ?? 0,
            ...(signIn?.status === "waiting" && { signIn: `waiting for the user: ${signIn.url}` }), ...(discovery?.error && { problem: discovery.error }),
            ...(settings.defaultAccount === account.id && { default: true }), youMay: may,
          }
        }))
        return json({ accounts, usage: USAGE })
      },
    },
    {
      name: "huggingface_find_actions",
      description: () => "Find Hugging Face Hub actions by keyword, e.g. 'search models', 'repo details', 'papers', 'docs', 'jobs'. Returns names, permission kind and summaries; pass names=[...] for exact parameters before huggingface_run.",
      input: {
        type: "object",
        properties: { account: ACCOUNT, query: { type: "string", maxLength: 200 }, names: { type: "array", items: { type: "string" }, maxItems: 20 }, limit: { type: "integer", minimum: 1, maximum: 100 } },
        additionalProperties: false,
      },
      execute: async (input: { account?: string; query?: string; names?: string[]; limit?: number }) => {
        const account = await service.pick(input.account)
        const tools = await service.actions(account)
        if (input.names?.length) {
          return json({ account: account.id, actions: input.names.map(name => {
            const tool = tools.find(item => item.name === name)
            return tool ? { name: tool.name, kind: kind(tool), description: tool.description, parameters: tool.inputSchema } : { name, missing: true }
          }) })
        }
        const matches = searchActions(tools, input.query ?? "").slice(0, input.limit ?? 25)
        return json({
          account: account.id, total: tools.length,
          actions: matches.map(tool => ({ name: tool.name, kind: kind(tool), summary: (tool.description ?? "").replace(/\s+/g, " ").slice(0, 240) })),
          next: "Call huggingface_find_actions names=[...] for parameters, then huggingface_run. More actions (repo creation, Jobs, Spaces) can be turned on at huggingface.co/settings/mcp.",
        })
      },
    },
    {
      name: "huggingface_run",
      description: () => "Run a Hugging Face Hub action found with huggingface_find_actions, e.g. action='hub_repo_search' arguments={query:'qwen', repo_types:['model']}. Actions that cost money or quota (Jobs, sandboxes, Spaces) may ask the user first.",
      input: {
        type: "object",
        properties: { account: ACCOUNT, action: { type: "string", minLength: 1, maxLength: 120 }, arguments: { type: "object", additionalProperties: true } },
        required: ["action"], additionalProperties: false,
      },
      execute: async (input: { account?: string; action: string; arguments?: Record<string, unknown> }, context) => {
        const account = await service.pick(input.account)
        const tools = await service.actions(account)
        const tool = tools.find(item => item.name === input.action)
        if (!tool) {
          const near = searchActions(tools, input.action.replace(/_/g, " ")).slice(0, 5).map(item => item.name)
          throw new Error(`No action ${JSON.stringify(input.action)}.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Use huggingface_find_actions.`)
        }
        await check(context, kind(tool), account.id, { action: tool.name, arguments: summarize(input.arguments ?? {}) })
        const result = await service.mcp(account).call(tool.name, input.arguments ?? {})
        if (result.isError) throw new Error(`${tool.name} failed: ${clip(result.text)}`)
        return { content: clip(result.text || "(no output)") }
      },
    },
    {
      name: "huggingface_account_upsert",
      description: () => "Create or update a Hugging Face account (fields merge; null clears). auth: browser (sign in with Hugging Face, SSO-friendly; recommended) or token (the user enters a user access token from huggingface.co/settings/tokens). Never pass tokens here.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64, description: "Name chosen by the user, e.g. work or personal" },
          rename: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64 },
          auth: { enum: ["browser", "token"] }, label: { type: ["string", "null"] }, notes: { type: ["string", "null"] },
        },
        required: ["id"], additionalProperties: false,
      },
      execute: async (input: Record<string, unknown> & { id: string; rename?: string }, context) => {
        const { id, rename, ...patch } = input
        validAccountId(id)
        const existing = await service.store.get(id)
        await check(context, "manage", id, { operation: existing ? "update" : "create" })
        if (rename !== undefined && !existing) throw new Error(`Cannot rename: no account ${id}`)
        const target = rename ?? id
        if (target !== id) await check(context, "manage", validAccountId(target), { operation: "rename", from: id })
        const saved = await service.store.put(normalizeAccount({ ...mergeAccount(existing, patch), id: target }), existing && target !== id ? id : undefined)
        if (existing && target !== id) { await service.vault.renameEntity(id, target); await service.policy.renameEntity(id, target) }
        const signedIn = await service.signedIn(saved)
        return json({ saved, signedIn, ...(!signedIn && { next: saved.auth === "browser" ? `sign in: huggingface_signin account=${saved.id}` : `ask for the token: huggingface_request_token account=${saved.id}` }) })
      },
    },
    {
      name: "huggingface_account_remove",
      description: () => "Delete a Hugging Face account with its stored sign-in and permission settings. Asks the user by default. Does not change anything on Hugging Face.",
      input: { type: "object", properties: { account: { type: "string" } }, required: ["account"], additionalProperties: false },
      execute: async (input: { account: string }, context) => {
        const account = await service.pick(input.account)
        await check(context, "remove", account.id)
        service.signIns.get(account.id)?.flow.cancel()
        service.signIns.delete(account.id)
        await service.store.remove(account.id)
        await service.vault.deleteEntity(account.id)
        await service.policy.removeEntity(account.id)
        return json({ removed: account.id })
      },
    },
    {
      name: "huggingface_signin",
      description: () => "Start the browser sign-in to Hugging Face (auth=browser). Returns a link for the user to open on this computer; it completes in the background once they approve (they choose which organizations to grant). wait blocks up to that many seconds.",
      input: { type: "object", properties: { account: ACCOUNT, wait: { type: "integer", minimum: 0, maximum: 600 } }, additionalProperties: false },
      execute: async (input: { account?: string; wait?: number }, context) => {
        const account = await service.pick(input.account)
        await check(context, "manage", account.id, { operation: "sign in" })
        const state = await service.startSignIn(account)
        const deadline = Date.now() + (input.wait ?? 0) * 1000
        while (state.status === "waiting" && Date.now() < deadline) {
          context.signal?.throwIfAborted()
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        const discovery = state.status === "done" ? await service.store.discovery(account.id) : undefined
        return json({
          account: account.id, status: state.status,
          ...(state.status === "waiting" && { tellUser: `Open this link on this computer, sign in to Hugging Face, choose the organizations agents may use, and click Authorize: ${state.url}  — or click Sign in in OpenCode (Settings → Hugging Face).` }),
          ...(state.error && { error: state.error }),
          ...(discovery && { user: discovery.name ?? null, orgs: discovery.orgs ?? [], actions: discovery.actions, ...(discovery.error && { problem: discovery.error }) }),
        })
      },
    },
    {
      name: "huggingface_refresh",
      description: () => "Check an account again: who it is, its organizations and token kind, how many Hub actions (after the user signed in or something failed).",
      input: { type: "object", properties: { account: ACCOUNT }, additionalProperties: false },
      execute: async (input: { account?: string }) => {
        const account = await service.pick(input.account)
        const { instructions: _, ...discovery } = await service.rediscover(account)
        return json({ account: account.id, ...discovery })
      },
    },
    {
      name: "huggingface_request_token",
      description: () => "Ask the user to enter a Hugging Face user access token for an account (auth=token). They enter it outside the chat; you only learn whether it is set.",
      input: { type: "object", properties: { account: ACCOUNT, purpose: { type: "string", maxLength: 300 } }, additionalProperties: false },
      execute: async (input: { account?: string; purpose?: string }) => {
        const account = await service.pick(input.account)
        return json({
          status: (await service.vault.has(account.id, ACCESS)) ? "set (the user may replace it)" : "unset",
          tellUser: `Please create a token at https://huggingface.co/settings/tokens (Write, or fine-grained with the repos and permissions agents need) and enter it in OpenCode (Settings → Hugging Face → ${account.id} → Enter token), or in a terminal in the oc-huggingface folder: pixi run token-set ${account.id}${input.purpose ? ` — for: ${input.purpose}` : ""}`,
        })
      },
    },
  ]
}
