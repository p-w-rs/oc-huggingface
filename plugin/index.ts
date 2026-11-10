import type { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { installRedaction, PermissionBridge, pluginDataDir, SECURE_KIT_VERSION, sessionRoots, ShellSupplier, type PermissionHost } from "oc-secure-kit"
import { createAdmin } from "./admin.js"
import { defaultEffect, type Discovery } from "./model.js"
import { HuggingFaceRpc } from "./rpc.js"
import { HuggingFaceService, LOGIN_TIP, PLUGIN_ID } from "./service.js"
import { createTools, TOOL_NAMES } from "./tools.js"

export { PLUGIN_ID, SECURE_KIT_VERSION }

export interface HuggingFaceOptions {
  /** Absolute path; default `$XDG_DATA_HOME/oc-huggingface`. */
  readonly dataDirectory?: string
  /** Hugging Face MCP URL; default https://huggingface.co/mcp. For tests. */
  readonly mcpUrl?: string
  /** Hub base; default https://huggingface.co. For tests. */
  readonly hubUrl?: string
}

export function parseOptions(raw: unknown): HuggingFaceOptions {
  const options = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  for (const key of ["dataDirectory", "mcpUrl", "hubUrl"]) if (options[key] !== undefined && typeof options[key] !== "string") throw new Error(`${PLUGIN_ID}: ${key} must be a string`)
  for (const key of ["mcpUrl", "hubUrl"]) if (options[key] !== undefined && !/^https?:\/\//.test(options[key] as string)) throw new Error(`${PLUGIN_ID}: ${key} must be an http(s) URL`)
  return Object.fromEntries(["dataDirectory", "mcpUrl", "hubUrl"].filter(key => options[key] !== undefined).map(key => [key, options[key]])) as HuggingFaceOptions
}

const SKILL = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url))
const warn = (message: string, error?: unknown) =>
  console.warn(`[${PLUGIN_ID}] ${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`)

/** The bundled know-how plus Hugging Face's own guidance for agents, once an account has signed in. */
export function skillContent(base: string, discovery: Record<string, Discovery>): string {
  const instructions = Object.values(discovery).find(item => item.instructions)?.instructions
  return instructions ? `${base.trimEnd()}

## Hugging Face's own guidance for agents (from its server)

These describe the Hub actions (call them through huggingface_run). Ignore any advice to set HF_TOKEN or log in: this plugin supplies the token.

${instructions.replace(/^#{1,2} /gm, "### ")}
` : base
}

export function createPlugin(): Plugin.Plugin {
  return ({
    id: PLUGIN_ID,
    async setup(ctx) {
      const registrations: { dispose(): Promise<void> | void }[] = []
      const cleanup = async () => { await Promise.allSettled(registrations.splice(0).reverse().map(async item => item.dispose())) }
      try {
        const options = parseOptions(ctx.options)
        const service = await HuggingFaceService.open(pluginDataDir(PLUGIN_ID, options.dataDirectory), {
          ...(options.mcpUrl && { mcpUrl: options.mcpUrl }), ...(options.hubUrl && { hubUrl: options.hubUrl }),
        })
        registrations.push({ dispose: () => service.dispose() })
        const root = sessionRoots(async sessionID => (await ctx.session.get({ sessionID: sessionID as never })).parentID ?? undefined)
        const bridge = new PermissionBridge({ plugin: PLUGIN_ID, policy: service.policy, fallback: defaultEffect, root })
        registrations.push(await bridge.install(ctx.permission as unknown as PermissionHost))
        registrations.push(bridge.followReplies(ctx.event as never, error => warn("could not save Allow always", error)))
        service.attach(bridge)

        const tools = createTools(service)
        registrations.push(await ctx.tool.transform(editor => {
          for (const tool of tools) {
            editor.add({
              name: tool.name, description: tool.description(), input: tool.input as never, options: { codemode: false },
              execute: async (input, context) => {
                try { return await tool.execute(input, context) }
                finally { await service.syncRedactor().catch(error => warn("redactor refresh failed", error)) }
              },
            })
          }
        }))
        registrations.push(await installRedaction(ctx.tool as never, service.redactor, new Set<string>(TOOL_NAMES), error => warn("redaction skipped", error)))

        // hf, git for huggingface.co and commands that reference $HF_TOKEN get the token; nothing else is touched.
        const shell = new ShellSupplier({
          plugin: PLUGIN_ID, redactor: service.redactor, warn,
          prepare: async (command, caller) => {
            let cwd = process.cwd()
            try { cwd = (await ctx.session.get({ sessionID: caller.sessionID as never })).location.directory as string } catch {}
            if (caller.workdir) cwd = caller.workdir.startsWith("/") ? caller.workdir : `${cwd}/${caller.workdir}`
            return service.prepareCommand(command, { ...caller, cwd })
          },
          annotate: (command, result) => { const output = JSON.stringify(result ?? ""); return /\b(hf|huggingface-cli)\b[^\n]*\blogin\b/.test(command) ? LOGIN_TIP : /401|Invalid credentials|Repository Not Found|gated repo|Access to model .* is restricted/i.test(output) && /\b(hf|huggingface|transformers|datasets|git)\b/.test(command) ? "If this is a gated or private repo: check the account can see it (huggingface_list), request access on the model page, or run with OC_HF_ACCOUNT=<id> for another account." : undefined },
        })
        registrations.push({ dispose: () => shell.dispose() })
        registrations.push(await ctx.tool.hook("execute.before", event => shell.before(event)))
        registrations.push(await ctx.shell.hook("create.before", event => shell.create(event)))
        registrations.push(await ctx.tool.hook("execute.after", event => shell.after(event as never)))

        let skillReady = false
        try {
          const base = await readFile(SKILL, "utf8")
          const description = /^description:\s*(.+)$/m.exec(base)?.[1] ?? "Hugging Face know-how"
          registrations.push(await ctx.skill.transform(editor => {
            editor.add({ id: "huggingface" as never, name: "huggingface" as never, description, path: SKILL as never, content: skillContent(base, service.store.cached().discovery) })
          }))
          skillReady = true
        } catch (error) { warn("skill not registered", error) }

        let reloading: Promise<void> | undefined
        registrations.push({ dispose: service.store.onChange(() => {
          reloading ??= Promise.resolve()
            .then(() => Promise.all([ctx.tool.reload(), skillReady ? ctx.skill.reload() : undefined]))
            .then(() => {}).catch(error => warn("tool reload failed", error)).finally(() => { reloading = undefined })
        }) })

        const admin = createAdmin({
          service, root,
          agents: async () => ((await ctx.agent.list()).data ?? []).filter(agent => !agent.hidden).map(agent => ({ id: agent.id as string, name: agent.name, mode: agent.mode })),
        })
        const handlers = Object.fromEntries(Object.keys(HuggingFaceRpc.methods).map(name => [name, async (input: unknown) => (admin as Record<string, (input: never) => Promise<unknown>>)[name]!(input as never)]))
        registrations.push(await ctx.rpc.register(HuggingFaceRpc, handlers as never))
      } catch (error) {
        warn("disabled", error)
        await cleanup()
      }
      return cleanup
    },
  }) satisfies Plugin.Plugin
}

export default createPlugin()
