import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { PolicyStore, Vault } from "oc-secure-kit"
import plugin, { createPlugin, parseOptions, PLUGIN_ID } from "./index.js"
import { startFakeHf, type FakeHf } from "./testhf.js"

const dirs: string[] = []
let fake: FakeHf
before(async () => { fake = await startFakeHf() })
after(async () => { await fake.stop(); await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

type Effect = "allow" | "ask" | "deny"
type Tool = { name: string; description: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }

async function host(reply: "approve" | "reject" = "approve", options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ochf-"))
  dirs.push(dir)
  const hooks = { evaluate: [] as any[], before: [] as any[], after: [] as any[], shell: [] as any[] }
  const transforms: ((editor: any) => void)[] = []
  const skillTransforms: ((editor: any) => void)[] = []
  const tools = new Map<string, Tool>()
  const skills: { id: string; content: string }[] = []
  const prompts: { action: string; resources: string[]; metadata?: Record<string, unknown> }[] = []
  let rpc: any
  const registration = (list: unknown[], item: unknown) => { list.push(item); return { dispose: async () => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1) } } }
  const rebuild = () => { tools.clear(); for (const transform of transforms) transform({ add: (tool: Tool) => tools.set(tool.name, tool) }) }
  const rebuildSkills = () => { skills.length = 0; for (const transform of skillTransforms) transform({ add: (skill: any) => skills.push(skill) }) }
  const ctx = {
    options: { dataDirectory: dir, mcpUrl: fake.mcpUrl, hubUrl: fake.base, ...options },
    session: { get: async () => ({ parentID: undefined, location: { directory: dir } }) },
    permission: {
      hook: async (_: string, callback: any) => registration(hooks.evaluate, callback),
      assert: async (input: any) => {
        const event = { ...input, effect: "allow" as Effect }
        for (const hook of hooks.evaluate) await hook(event)
        if (event.effect === "deny") throw new Error(event.message ?? "denied")
        if (event.effect === "ask") { prompts.push({ action: input.action, resources: input.resources, metadata: input.metadata }); if (reply === "reject") throw new Error("rejected by user") }
      },
    },
    tool: {
      transform: async (callback: any) => { transforms.push(callback); rebuild(); return { dispose: async () => { transforms.splice(transforms.indexOf(callback), 1); rebuild() } } },
      reload: async () => rebuild(),
      hook: async (name: string, callback: any) => registration(name === "execute.before" ? hooks.before : hooks.after, callback),
    },
    shell: { hook: async (_: string, callback: any) => registration(hooks.shell, callback) },
    skill: {
      transform: async (callback: any) => { skillTransforms.push(callback); rebuildSkills(); return { dispose: async () => { skillTransforms.splice(skillTransforms.indexOf(callback), 1); rebuildSkills() } } },
      reload: async () => rebuildSkills(),
    },
    event: { subscribe: () => (async function* () {})() },
    agent: { list: async () => ({ data: [{ id: "build", name: "build", mode: "primary", hidden: false }] }) },
    rpc: { register: async (_: unknown, handlers: any) => { rpc = handlers; return { dispose: async () => { rpc = undefined } } } },
  }
  const cleanup = await createPlugin().setup(ctx as unknown as Plugin.Context) as () => Promise<void>
  let n = 0
  const context = (agent: string) => ({ sessionID: "s", agent, messageID: "m", id: `c${++n}`, signal: new AbortController().signal, progress: async () => {} })
  const finish = async (event: any) => { for (const hook of hooks.after) await hook(event); return event }
  const call = async (name: string, input: unknown, agent = "build") => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`no tool ${name}`)
    const c = context(agent)
    let event: any
    try { event = { tool: name, id: c.id, input, status: "completed", result: await tool.execute(input, c) } }
    catch (error) { event = { tool: name, id: c.id, input, status: "error", error } }
    await finish(event)
    if (event.status === "error") throw event.error
    const text = event.result.content
    try { return JSON.parse(text) } catch { return text }
  }
  /** Runs a command through the native shell path: execute.before, shell create.before, a real sh, execute.after. */
  const shell = async (command: string, agent = "build") => {
    const c = context(agent)
    const input = { command, description: "test" }
    for (const hook of hooks.before) await hook({ tool: "shell", ...c, input })
    const create = { command, cwd: dir, timeout: 60_000, shell: "/bin/sh", env: {} as Record<string, string | undefined> }
    for (const hook of hooks.shell) await hook(create)
    const { exit, output } = await new Promise<{ exit: number; output: string }>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", command], { cwd: dir, env: { ...process.env, ...create.env } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] })
      let output = ""
      child.stdout.on("data", chunk => { output += chunk }); child.stderr.on("data", chunk => { output += chunk })
      child.on("error", reject)
      child.on("close", code => resolve({ exit: code ?? -1, output }))
    })
    const event = await finish({ tool: "shell", id: c.id, input, status: "completed", result: { output: { exit, truncated: false, output, status: "completed" }, content: [{ type: "text", text: output }], metadata: { exit } } })
    return { exit, text: event.result.content[0].text as string, env: create.env }
  }
  const signIn = async (id: string) => {
    await call("huggingface_account_upsert", { id })
    const started = await call("huggingface_signin", { account: id })
    await fake.approve(/(http\S+\/oauth\/authorize\S+)/.exec(started.tellUser)![1]!)
    for (let i = 0; i < 100; i++) { const list = await rpc.state({}); if (list.accounts.find((a: { id: string; user?: string }) => a.id === id)?.user) return; await new Promise(r => setTimeout(r, 30)) }
    throw new Error("sign-in did not settle")
  }
  return { dir, tools, skills, prompts, call, shell, signIn, cleanup, rpc: () => rpc, policy: () => PolicyStore.open(dir), vault: () => Vault.open({ dir, plugin: PLUGIN_ID }) }
}

test("identity, tools, skill, and safe failure", async () => {
  assert.equal(plugin.id, PLUGIN_ID)
  const h = await host()
  assert.equal(h.tools.size, 8)
  assert.equal(h.skills[0]!.id, "huggingface")
  assert.match(h.skills[0]!.content, /hf download/)
  assert.match(h.tools.get("huggingface_list")!.description, /No Hugging Face accounts are configured yet/)
  await h.cleanup()
  assert.equal(h.tools.size, 0)
  const broken = await host("approve", { hubUrl: "ftp://x" })
  assert.equal(broken.tools.size, 0)
  assert.throws(() => parseOptions({ mcpUrl: 3 }), /string/)
})

test("browser sign-in registers the scopes it asks for, then the inventory, actions and a priced action that asks", async () => {
  const h = await host()
  await h.signIn("personal")
  assert.match(fake.registeredScopes()!, /write-repos/, "scopes are sent at registration (Hugging Face limits a client to them)")
  assert.match(h.tools.get("huggingface_list")!.description, /personal: patlee \(Pat Lee\); orgs acme-ml; token oauth/)
  const found = await h.call("huggingface_find_actions", { query: "search models" })
  assert.equal(found.actions[0].name, "hub_repo_search")
  assert.match(await h.call("huggingface_run", { action: "hub_repo_search", arguments: { query: "tiny" } }), /acme-ml\/tiny-model/)
  assert.equal(h.prompts.length, 0, "reading does not ask")
  await h.call("huggingface_run", { action: "hf_jobs", arguments: { operation: "run" } })
  assert.equal(h.prompts.at(-1)!.action, "oc-huggingface.spend", "Jobs ask first")
  fake.expireTokens()
  assert.match(await h.call("huggingface_run", { action: "hub_repo_search", arguments: {} }), /tiny-model/, "an expired token is refreshed")
  await h.cleanup()
})

test("a user access token; the token reaches hf, git for the Hub and $HF_TOKEN scripts, and nothing else", async () => {
  const h = await host()
  await h.call("huggingface_account_upsert", { id: "work", auth: "token" })
  assert.match((await h.call("huggingface_request_token", { account: "work" })).tellUser, /settings\/tokens/)
  await h.rpc().setToken({ id: "work", token: fake.userToken })
  assert.match(h.tools.get("huggingface_list")!.description, /work: patlee .*token write/)

  const script = await h.shell('test "$HF_TOKEN" = "' + fake.userToken + '" && echo got-it; echo "$HF_TOKEN"')
  assert.match(script.text, /got-it/)
  assert.doesNotMatch(script.text, new RegExp(fake.userToken), "the token is masked in the output")
  assert.equal((await h.shell("echo plain-$HF_TOKEN-x | tr a-z A-Z")).text.includes("PLAIN-"), true)
  assert.equal((await h.shell("ls")).env.HF_TOKEN, undefined, "other commands are untouched")

  const before = fake.gitAuth.length
  const git = await h.shell(`git ls-remote ${fake.base}/acme-ml/tiny-model 2>&1; echo exit=$?`)
  assert.match(git.text, /exit=0/, git.text)
  assert.equal(fake.gitAuth.slice(before).at(-1), fake.userToken, "git authenticated with the account's token")

  await h.policy().then(policy => policy.setCells([{ entity: "work", capability: "scripts", effect: "deny", row: { agent: "*" } }]))
  const denied = await h.shell('echo "[$HF_TOKEN]"')
  assert.match(denied.text, /\[\]/)
  assert.match(denied.text, /scripts on work: not granted/)
  await h.cleanup()
})
