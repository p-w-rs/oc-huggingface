// Browser sign-in for a Hugging Face account from a terminal (the GUI and huggingface_signin do the same).
//   pixi run signin <account>
// Creates the account if needed. Never prints tokens.
import { spawn } from "node:child_process"
import { pluginDataDir } from "oc-secure-kit"
import { normalizeAccount } from "../plugin/model.ts"
import { HuggingFaceService } from "../plugin/service.ts"

const [id] = process.argv.slice(2).filter(arg => !arg.startsWith("--"))
if (!id) { console.error("Usage: pixi run signin <account>"); process.exit(2) }
const service = await HuggingFaceService.open(pluginDataDir("oc-huggingface", process.env.OC_HUGGINGFACE_DATA_DIR || undefined), { ...(process.env.OC_HUGGINGFACE_MCP_URL && { mcpUrl: process.env.OC_HUGGINGFACE_MCP_URL }), ...(process.env.OC_HUGGINGFACE_HUB_URL && { hubUrl: process.env.OC_HUGGINGFACE_HUB_URL }) })
const account = (await service.store.get(id)) ?? await service.store.put(normalizeAccount({ id, auth: "browser" }))
if (account.auth !== "browser") { console.error(`${id} uses a token; run: pixi run token-set ${id}`); process.exit(2) }
const state = await service.startSignIn(account)
console.log(`\nOpening your browser. Sign in to Hugging Face, choose the organizations agents may use, and click Authorize.\nIf it does not open, visit:\n\n${state.url}\n`)
if (!process.env.OC_HUGGINGFACE_NO_BROWSER) spawn(process.platform === "darwin" ? "open" : "xdg-open", [state.url], { stdio: "ignore", detached: true }).on("error", () => {}).unref()
while (state.status === "waiting") await new Promise(resolve => setTimeout(resolve, 500))
if (state.status !== "done") { console.error(`Sign-in did not finish: ${state.error}`); process.exit(1) }
const discovery = await service.store.discovery(id)
console.log(`Signed in as ${discovery?.name ?? "?"}${discovery?.orgs?.length ? ` (orgs: ${discovery.orgs.join(", ")})` : ""}. Hub actions: ${discovery?.actions ?? 0}.`)
if (discovery?.error) console.log(`Problem: ${discovery.error}`)
service.dispose()
process.exit(discovery?.error ? 1 : 0)
