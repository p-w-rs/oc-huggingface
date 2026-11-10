import { validName } from "oc-secure-kit"

export const ACCOUNTS_FORMAT = "oc-huggingface-accounts/1"

/** Hugging Face's agent interface (MCP) and Hub. Overridable for tests. */
export const DEFAULT_MCP = "https://huggingface.co/mcp"
export const DEFAULT_HUB = "https://huggingface.co"

/**
 * How an account signs in.
 * - browser: OAuth in the browser (works with SSO); tokens are refreshed automatically.
 * - token: a user access token (hf_…) the user creates at huggingface.co/settings/tokens and enters.
 */
export type Auth = "browser" | "token"

/** A Hugging Face login. Organizations come with it. */
export interface Account {
  readonly id: string
  readonly label?: string
  readonly auth: Auth
  readonly notes?: string
  readonly updatedAt: string
}

/** What the plugin learned by signing in. Rediscovered; never exported. */
export interface Discovery {
  readonly name?: string
  readonly fullname?: string
  readonly email?: string
  readonly orgs?: readonly string[]
  /** read, write, fineGrained, oauth … */
  readonly tokenRole?: string
  readonly isPro?: boolean
  readonly actions?: number
  readonly instructions?: string
  readonly checkedAt?: string
  readonly error?: string
}

/**
 * - read: search and download, including private and gated repos the account can see
 * - write: upload files, create repos and branches, open discussions and pull requests
 * - delete: delete repos, files, branches, tags
 * - spend: things that cost money or quota (Jobs, Inference Endpoints, sandboxes, paid inference)
 * - admin: visibility, gated access, collaborators, webhooks, organization settings
 * - scripts: the token given to the agent's own programs that use it (Python, transformers, datasets, …)
 */
export const CAPABILITIES = ["read", "write", "delete", "spend", "admin", "scripts", "manage", "remove"] as const
export type Capability = (typeof CAPABILITIES)[number]

/** Starting point only; users change it in the table. */
export function defaultEffect(capability: string): "allow" | "ask" {
  return ["delete", "spend", "admin", "remove"].includes(capability) ? "ask" : "allow"
}

/** Vault secret names (entity = account id). */
export const ACCESS = "access-token"
export const REFRESH = "refresh-token"
/** OAuth client bound to the tokens: { clientId, tokenEndpoint, resource, expiresAt, scopes }. */
export const OAUTH = "oauth"
export const SECRET_NAMES = [ACCESS, REFRESH, OAUTH] as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CONTROL = /[\u0000-\u001f\u007f]/
const fail = (message: string): never => { throw new Error(message) }
const text = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || value.length > max || CONTROL.test(value)) fail(`${field} must be a single-line string up to ${max} characters`)
  return value as string
}

export function validAccountId(id: unknown): string {
  if (typeof id !== "string" || !ID.test(id)) return fail(`account id ${JSON.stringify(id)} must be 1-64 letters, digits, '.', '_' or '-'`)
  return validName("account", id)
}

export function normalizeAccount(input: unknown, now = new Date()): Account {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("account must be an object")
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) if (!["id", "label", "auth", "notes", "updatedAt"].includes(key)) fail(`Unknown account field ${JSON.stringify(key)}`)
  const id = validAccountId(raw.id)
  const auth = (raw.auth ?? "browser") as Auth
  if (!["browser", "token"].includes(auth)) fail("auth must be browser or token")
  const label = text(raw.label, "label", 120)
  const notes = typeof raw.notes === "string" && raw.notes.length <= 4000 ? raw.notes : raw.notes == null ? undefined : fail("notes must be text up to 4000 characters")
  return { id, auth, ...(label && { label }), ...(notes && { notes }), updatedAt: now.toISOString() }
}

export function mergeAccount(existing: Account | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = existing ? { ...existing } : {}
  delete base.updatedAt
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key]
    else base[key] = value
  }
  return base
}

/** Looks like a Hugging Face token (user access token or OAuth token). */
export const looksLikeToken = (value: string) => /^hf_[A-Za-z0-9_]{20,}$/.test(value.trim())

// ------------------------------------------------------------------ action classification (MCP tools)

export interface ActionAnnotations { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean }

export function classifyAction(name: string, annotations: ActionAnnotations = {}): Capability {
  if (/jobs|sandbox|dynamic_space|endpoint|gr\d*_|space_/.test(name) && annotations.readOnlyHint !== true) return "spend"
  if (annotations.readOnlyHint === true || /^(hf_whoami|hub_repo_search|hub_repo_details|hf_fs|.*_search|.*_details|paper_|.*_list)/.test(name)) return "read"
  if (annotations.destructiveHint === true || /delete|remove/.test(name)) return "delete"
  return "write"
}

// ------------------------------------------------------------------ shell commands

const HUB_HOST = /(^|[\s"'=@/])(huggingface\.co|hf\.co)([/:\s"']|$)/
/** Splits a command line into simple commands (|, ;, &&, ||, newlines). Good enough for classification. */
const segments = (command: string) => command.split(/\|\||&&|[|;\n]/).map(part => part.trim()).filter(Boolean)
const words = (segment: string) => segment.replace(/^(\w+=\S*\s+)+/, "").split(/\s+/).filter(Boolean)

/** Permission an `hf` / `huggingface-cli` invocation needs, from its subcommand. */
export function classifyHf(args: readonly string[]): Capability {
  const [group = "", action = "", third = ""] = args.filter(arg => !arg.startsWith("-"))
  const all = args.join(" ")
  if (["auth", "env", "version", "cache", "skills", "extensions", "help", "update"].includes(group)) return "read"
  if (group === "download") return "read"
  if (["models", "datasets", "papers", "collections", "spaces"].includes(group) && /^(|ls|list|info|search|download|show|read)$/.test(action)) return "read"
  if (group === "jobs" || group === "endpoints" || group === "sandbox") return /^(ps|ls|list|inspect|logs|describe|hardware|catalog)$/.test(action) ? "read" : action === "delete" || action === "cancel" ? "delete" : "spend"
  if (/\b(delete|rm|remove)\b/.test(`${action} ${third}`) || /--delete\b/.test(all)) return "delete"
  if (group === "repos" || group === "repo") {
    if (/^(ls|list|info|search)$/.test(action)) return "read"
    if (/settings|move|gated|visibility|private/.test(`${action} ${all}`)) return "admin"
    return "write"
  }
  if (["upload", "upload-large-folder", "sync", "cp", "buckets", "discussions", "lfs-enable-largefiles"].includes(group)) return "write"
  if (["login", "logout", "whoami"].includes(group)) return "read"
  return "write"
}

export interface CommandPlan {
  /** Whether this command gets the token at all. */
  readonly uses: boolean
  /** Permissions needed, strongest last. */
  readonly capabilities: readonly Capability[]
  readonly git: boolean
  /** Runs an interactive login that would store a token on disk. */
  readonly login: boolean
}

/** Programs that typically load models or datasets from the Hub. */
const ML_PROGRAMS = new Set(["python", "python3", "accelerate", "torchrun", "deepspeed", "vllm", "sglang", "lm_eval", "lighteval", "optimum-cli", "transformers", "transformers-cli", "jupyter", "ipython", "llamafactory-cli", "axolotl", "trl", "tune", "mlx_lm.generate"])

const RANK: Record<string, number> = { read: 0, scripts: 1, write: 2, admin: 3, delete: 4, spend: 5 }

/**
 * Which commands get the token and which permissions they need. Commands that don't touch Hugging Face are left alone.
 * `hubRemote`: the working folder is a git repository whose remote is on Hugging Face (so a bare `git push` is for it).
 */
export function planCommand(command: string, hubRemote = false, hubHost?: string): CommandPlan {
  const onHub = (text: string) => HUB_HOST.test(text) || (!!hubHost && text.includes(hubHost))
  const needed = new Set<Capability>()
  let git = false, login = false
  for (const segment of segments(command)) {
    const argv = words(segment)
    const program = (argv[0] ?? "").split("/").pop() ?? ""
    const rest = argv.slice(1)
    const hfAt = rest.findIndex(arg => arg === "hf" || arg === "huggingface-cli")
    if (program === "hf" || program === "huggingface-cli" || (["pixi", "uvx", "pipx"].includes(program) && hfAt >= 0)) {
      const args = program === "hf" || program === "huggingface-cli" ? rest : rest.slice(hfAt + 1)
      needed.add(classifyHf(args))
      if (/^(auth\s+)?login\b/.test(args.filter(arg => !arg.startsWith("-")).join(" "))) login = true
    } else if (ML_PROGRAMS.has(program) || (["pixi", "uv", "uvx", "pipx", "conda", "mamba"].includes(program) && /^(run|exec|x)$/.test(rest[0] ?? ""))) {
      // Python and ML launchers: transformers, datasets, diffusers, vLLM … read HF_TOKEN by themselves.
      needed.add("scripts")
    } else if (program === "git") {
      const sub = rest.find(arg => !arg.startsWith("-")) ?? ""
      const network = ["push", "pull", "fetch", "clone", "lfs", "xet", "ls-remote", "submodule"].includes(sub)
      if (network && (onHub(segment) || (hubRemote && sub !== "clone"))) {
        git = true
        needed.add(sub !== "push" ? "read" : /--delete\b|\s:\S|--force\b|\s-f\b|\s\+\S/.test(segment) ? "delete" : "write")
      }
    }
  }
  if (/\$\{?(HF_TOKEN|HUGGING_FACE_HUB_TOKEN)\b/.test(command)) needed.add("scripts")
  const capabilities = [...needed].sort((a, b) => (RANK[a] ?? 0) - (RANK[b] ?? 0))
  return { uses: capabilities.length > 0, capabilities, git, login }
}
