import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  McpClient, PolicyStore, Redactor, refreshGrant, RunDir, Serial, startBrowserSignIn, Vault,
  type BrowserSignIn, type Grant, type McpToolInfo, type OAuthClient, type PermissionBridge, type ShellCaller, type Supply,
} from "oc-secure-kit"
import { ACCESS, DEFAULT_HUB, DEFAULT_MCP, OAUTH, planCommand, REFRESH, SECRET_NAMES, type Account, type Discovery } from "./model.js"
import { AccountStore } from "./store.js"

export const PLUGIN_ID = "oc-huggingface"
export const VERSION = "1.0.1"
const SERVICE = "Hugging Face"
/** Everything an agent may need; the user still chooses organizations on the consent page. */
const SCOPES = ["openid", "profile", "email", "read-mcp", "read-repos", "write-repos", "manage-repos", "gated-repos", "contribute-repos", "read-memberships", "inference-api", "jobs", "write-discussions"]
const REFRESH_MARGIN = 5 * 60_000
const run = promisify(execFile)

export interface SignInState {
  readonly account: string
  readonly url: string
  readonly expiresAt: number
  status: "waiting" | "done" | "failed"
  error?: string
  readonly flow: BrowserSignIn
}

interface Catalog { readonly tools: McpToolInfo[]; readonly at: number }
const CATALOG_TTL = 6 * 60 * 60_000

export const LOGIN_TIP = "Do not run `hf auth login` or `huggingface-cli login`: they would store a token in plain text. oc-huggingface supplies the signed-in account's token to hf, git and programs that reference $HF_TOKEN."

/** Accounts, vault, permissions, sign-in and per-account connections of one data directory. */
export class HuggingFaceService {
  readonly redactor = new Redactor()
  readonly signIns = new Map<string, SignInState>()
  #bridge?: PermissionBridge
  #redactorStale = false
  #mcp = new Map<string, McpClient>()
  #catalog = new Map<string, Catalog>()
  #refreshing = new Map<string, Serial>()
  readonly runBase: string

  private constructor(
    readonly dir: string,
    readonly store: AccountStore,
    readonly vault: Vault,
    readonly policy: PolicyStore,
    readonly mcpUrl: string,
    readonly hubUrl: string,
  ) { this.runBase = join(dir, "run") }

  static async open(dir: string, options: { mcpUrl?: string; hubUrl?: string } = {}): Promise<HuggingFaceService> {
    const [store, vault, policy] = await Promise.all([AccountStore.open(dir), Vault.open({ dir, plugin: PLUGIN_ID }), PolicyStore.open(dir)])
    const service = new HuggingFaceService(dir, store, vault, policy, options.mcpUrl ?? DEFAULT_MCP, (options.hubUrl ?? DEFAULT_HUB).replace(/\/+$/, ""))
    await service.refreshRedactor()
    await RunDir.sweep(service.runBase)
    vault.onChange(() => { service.#redactorStale = true })
    store.onChange(() => { service.#mcp.clear(); service.#catalog.clear() })
    return service
  }

  attach(bridge: PermissionBridge): void { this.#bridge = bridge }
  get bridge(): PermissionBridge {
    if (!this.#bridge) throw new Error(`${PLUGIN_ID}: permissions are not set up`)
    return this.#bridge
  }

  /** The account a call is for: the named one (id or Hugging Face username), the only one, or the default. */
  async pick(id: string | undefined): Promise<Account> {
    const accounts = await this.store.list()
    if (id) {
      const found = accounts.find(account => account.id === id) ?? accounts.find(account => this.store.cached().discovery[account.id]?.name === id)
      if (!found) throw new Error(`No Hugging Face account ${JSON.stringify(id)}. Accounts: ${accounts.map(account => account.id).join(", ") || "(none; create one with huggingface_account_upsert)"}`)
      return found
    }
    if (accounts.length === 1) return accounts[0]!
    const fallback = (await this.store.settings()).defaultAccount
    if (fallback) { const found = accounts.find(account => account.id === fallback); if (found) return found }
    if (!accounts.length) throw new Error("No Hugging Face account is configured yet. Create one with huggingface_account_upsert, then huggingface_signin.")
    throw new Error(`Several Hugging Face accounts exist (${accounts.map(account => account.id).join(", ")}). Pass account=<id>; decide from the conversation or ask the user.`)
  }

  // ------------------------------------------------------------------ credentials

  async saveGrant(account: Account, grant: Grant, client: OAuthClient): Promise<void> {
    await this.vault.set(account.id, ACCESS, grant.accessToken)
    if (grant.refreshToken) await this.vault.set(account.id, REFRESH, grant.refreshToken)
    await this.vault.set(account.id, OAUTH, JSON.stringify({ ...client, ...(grant.expiresAt && { expiresAt: grant.expiresAt }), scopes: grant.scopes }))
    await this.refreshRedactor()
  }

  async setToken(account: Account, token: string): Promise<void> {
    await this.vault.set(account.id, ACCESS, token.trim())
    await this.vault.delete(account.id, REFRESH)
    await this.vault.delete(account.id, OAUTH)
    this.#mcp.delete(account.id)
    this.#catalog.delete(account.id)
    await this.refreshRedactor()
  }

  async signedIn(account: Account): Promise<boolean> { return this.vault.has(account.id, ACCESS) }

  /** A valid token, refreshed when about to expire (or `force`). Refreshes are serialized per account. */
  async accessToken(account: Account, force = false): Promise<string | undefined> {
    const serial = this.#refreshing.get(account.id) ?? new Serial()
    this.#refreshing.set(account.id, serial)
    return serial.run(async () => {
      const token = await this.vault.get(account.id, ACCESS)
      const stored = await this.vault.get(account.id, OAUTH)
      const oauth = stored ? JSON.parse(stored) as OAuthClient & { expiresAt?: number } : undefined
      if (token && !force && (!oauth?.expiresAt || oauth.expiresAt - Date.now() > REFRESH_MARGIN)) return token
      const refreshToken = await this.vault.get(account.id, REFRESH)
      if (!refreshToken || !oauth) return token
      const grant = await refreshGrant(oauth, refreshToken, SERVICE)
      await this.saveGrant(account, { ...grant, refreshToken: grant.refreshToken ?? refreshToken }, oauth)
      return grant.accessToken
    })
  }

  async token(account: Account): Promise<string> {
    const token = await this.accessToken(account)
    if (!token) throw new Error(account.auth === "browser"
      ? `${account.id} is not signed in to Hugging Face. Call huggingface_signin account=${account.id} and give the user the link.`
      : `${account.id} has no token yet: ask the user to enter it (huggingface_request_token account=${account.id}).`)
    return token
  }

  // ------------------------------------------------------------------ Hub API and actions (MCP)

  async hub<T = unknown>(account: Account | undefined, method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) }
    if (account) headers.authorization = `Bearer ${await this.token(account)}`
    const response = await fetch(`${this.hubUrl}${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) })
    const text = await response.text()
    if (!response.ok) {
      let message = text.slice(0, 300)
      try { const parsed = JSON.parse(text) as { error?: string; message?: string }; message = parsed.error ?? parsed.message ?? message } catch {}
      throw new Error(`Hugging Face ${method} ${path} failed (${response.status}): ${message}`)
    }
    return (text ? JSON.parse(text) : undefined) as T
  }

  mcp(account: Account): McpClient {
    let client = this.#mcp.get(account.id)
    if (!client) {
      client = new McpClient(this.mcpUrl, {
        authorization: async () => `Bearer ${await this.token(account)}`,
        ...(account.auth === "browser" && { onUnauthorized: async () => { await this.accessToken(account, true) } }),
        clientName: PLUGIN_ID, clientVersion: VERSION, service: SERVICE,
      })
      this.#mcp.set(account.id, client)
    }
    return client
  }

  async actions(account: Account, fresh = false): Promise<McpToolInfo[]> {
    const cached = this.#catalog.get(account.id)
    if (cached && !fresh && Date.now() - cached.at < CATALOG_TTL) return cached.tools
    const tools = await this.mcp(account).listTools()
    this.#catalog.set(account.id, { tools, at: Date.now() })
    return tools
  }

  // ------------------------------------------------------------------ discovery and sign-in

  /** Learns who the token belongs to (whoami is rate limited: only on sign-in and refresh) and the available actions. */
  async rediscover(account: Account): Promise<Discovery> {
    const previous = await this.store.discovery(account.id)
    let discovery: Discovery
    try {
      const me = await this.hub<{ name?: string; fullname?: string; email?: string; isPro?: boolean; orgs?: { name: string }[]; auth?: { type?: string; accessToken?: { role?: string } } }>(account, "GET", "/api/whoami-v2")
      let actions: number | undefined, instructions: string | undefined, problem: string | undefined
      try {
        const info = await this.mcp(account).initialize()
        actions = (await this.actions(account, true)).length
        instructions = info.instructions
      } catch (error) { problem = `Signed in, but Hugging Face's agent interface did not answer: ${(error as Error).message.slice(0, 200)}` }
      discovery = {
        ...(me.name && { name: me.name }), ...(me.fullname && { fullname: me.fullname }), ...(me.email && { email: me.email }),
        orgs: (me.orgs ?? []).map(org => org.name), ...(me.auth?.accessToken?.role ? { tokenRole: me.auth.accessToken.role } : me.auth?.type ? { tokenRole: me.auth.type } : {}),
        ...(me.isPro !== undefined && { isPro: me.isPro }), ...(actions !== undefined && { actions }), ...(instructions && { instructions: instructions.slice(0, 20_000) }),
        checkedAt: new Date().toISOString(), ...(problem && { error: problem }),
      }
    } catch (error) {
      discovery = { ...(previous ?? {}), error: (error as Error).message.slice(0, 500), checkedAt: new Date().toISOString() }
    }
    await this.store.setDiscovery(account.id, discovery)
    return discovery
  }

  async startSignIn(account: Account): Promise<SignInState> {
    if (account.auth !== "browser") throw new Error(`${account.id} uses a token; ask the user to enter it (huggingface_request_token).`)
    const running = this.signIns.get(account.id)
    if (running?.status === "waiting" && running.expiresAt > Date.now()) return running
    running?.flow.cancel()
    const flow = await startBrowserSignIn(this.mcpUrl, {
      clientName: "OpenCode (oc-huggingface)", service: SERVICE, registerScopes: true,
      scopes: () => SCOPES,
    })
    const state: SignInState = { account: account.id, url: flow.url, expiresAt: flow.expiresAt, status: "waiting", flow }
    this.signIns.set(account.id, state)
    flow.done
      .then(async ({ grant, client }) => { await this.saveGrant(account, grant, client); this.#mcp.get(account.id)?.reset(); await this.rediscover(account); state.status = "done" })
      .catch(error => { if (state.status === "waiting") { state.status = "failed"; state.error = (error as Error).message } })
    return state
  }

  async signOut(account: Account): Promise<void> {
    for (const name of SECRET_NAMES) await this.vault.delete(account.id, name)
    await this.store.setDiscovery(account.id, undefined)
    this.#mcp.delete(account.id)
    this.#catalog.delete(account.id)
    await this.refreshRedactor()
  }

  // ------------------------------------------------------------------ the agent's own commands

  /** Whether `cwd` is a git repository with a remote on Hugging Face. */
  async #hubRemote(cwd: string): Promise<boolean> {
    try { const remotes = (await run("git", ["-C", cwd, "remote", "-v"], { timeout: 3000 })).stdout; return /huggingface\.co|hf\.co/.test(remotes) || remotes.includes(new URL(this.hubUrl).host) } catch { return false }
  }

  /** Account named in the command (OC_HF_ACCOUNT=<id>), else the usual choice. */
  async #accountFor(command: string): Promise<Account> {
    const named = /(?:^|\s)OC_HF_ACCOUNT=([A-Za-z0-9._-]+)/.exec(command)?.[1]
    return this.pick(named)
  }

  /** Supplies HF_TOKEN and a git credential for huggingface.co to commands that use Hugging Face, after a permission check. */
  async prepareCommand(command: string, caller: ShellCaller & { cwd: string }): Promise<Supply | undefined> {
    const plan = planCommand(command, /\bgit\b/.test(command) ? await this.#hubRemote(caller.cwd) : false, new URL(this.hubUrl).host)
    if (!plan.uses) return undefined
    const notes: string[] = []
    if (plan.login) notes.push(LOGIN_TIP)
    let account: Account
    try { account = await this.#accountFor(command) }
    catch (error) { return { env: {}, notes: [...notes, `${(error as Error).message} The command ran without a Hugging Face token.`], secrets: false } }
    if (!(await this.signedIn(account))) return { env: {}, notes: [...notes, `${account.id} is not signed in: ${account.auth === "browser" ? `huggingface_signin account=${account.id}` : `huggingface_request_token account=${account.id}`}. The command ran without a token.`], secrets: false }
    const metadata = { command: command.length > 300 ? `${command.slice(0, 300)}…` : command }
    for (const capability of plan.capabilities) {
      try { await this.bridge.check({ sessionID: caller.sessionID, ...(caller.agent && { agent: caller.agent }), ...(caller.source && { source: caller.source }), capability, entities: [account.id], metadata }) }
      catch (error) { return { env: { HF_TOKEN: "", HUGGING_FACE_HUB_TOKEN: "" }, notes: [...notes, `${capability} on ${account.id}: not granted (${(error as Error).message.split("\n")[0]}). The command ran without a Hugging Face token.`], secrets: false } }
    }
    let token: string
    try { token = await this.token(account) }
    catch (error) { return { env: {}, notes: [...notes, `${(error as Error).message} The command ran without a token.`], secrets: false } }
    const env: Record<string, string> = { HF_TOKEN: token, GIT_TERMINAL_PROMPT: "0" }
    let runDir: RunDir | undefined
    if (plan.git) {
      // A credential for huggingface.co and hf.co, layered on the user's git config (nothing else changes).
      runDir = await RunDir.create(this.runBase)
      await runDir.write("token", token)
      const helper = await runDir.write("credential-helper", `#!/bin/sh\n[ "$1" = get ] || exit 0\nprintf 'username=%s\\npassword=%s\\n' hf "$(cat "$(dirname -- "$0")/token")"\n`, 0o700)
      // An empty helper first clears helpers from the user's config (e.g. an old password in the keychain) for these hosts only.
      const entries = [new URL(this.hubUrl).origin, "https://hf.co"].flatMap(host => [[`credential.${host}.helper`, ""], [`credential.${host}.helper`, `!'${helper.replace(/'/g, "'\\''")}'`]])
      env.GIT_CONFIG_COUNT = String(entries.length)
      entries.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key!; env[`GIT_CONFIG_VALUE_${index}`] = value! })
    }
    return { env, notes, secrets: true, mask: [/hf_[A-Za-z0-9_]{20,}/g], ...(runDir && { runDir }) }
  }

  async syncRedactor(): Promise<void> {
    await this.vault.list()
    if (this.#redactorStale) { this.#redactorStale = false; await this.refreshRedactor() }
  }
  async refreshRedactor(): Promise<void> {
    this.redactor.replaceAll((await this.vault.values()).filter(item => item.name !== OAUTH).map(item => [`${item.entity}/${item.name}`, item.value] as const))
  }

  dispose(): void { for (const state of this.signIns.values()) state.flow.cancel() }
}
