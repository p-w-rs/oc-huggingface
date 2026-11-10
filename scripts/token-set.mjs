// Enter a Hugging Face user access token for an account (huggingface.co/settings/tokens). Read with echo off, or from stdin.
//   pixi run token-set <account>
import { createInterface } from "node:readline"
import { pluginDataDir } from "oc-secure-kit"
import { looksLikeToken, normalizeAccount } from "../plugin/model.ts"
import { HuggingFaceService } from "../plugin/service.ts"

const [id] = process.argv.slice(2)
if (!id) { console.error("Usage: pixi run token-set <account>"); process.exit(2) }
const service = await HuggingFaceService.open(pluginDataDir("oc-huggingface", process.env.OC_HUGGINGFACE_DATA_DIR || undefined), { ...(process.env.OC_HUGGINGFACE_HUB_URL && { hubUrl: process.env.OC_HUGGINGFACE_HUB_URL }) })
const account = (await service.store.get(id)) ?? await service.store.put(normalizeAccount({ id, auth: "token" }))
function readHidden(prompt) {
  if (!process.stdin.isTTY) return new Promise(resolve => { let data = ""; process.stdin.on("data", c => { data += c }); process.stdin.on("end", () => resolve(data.trim())) })
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let muted = false
    rl._writeToOutput = text => { if (!muted) process.stdout.write(text) }
    rl.question(prompt, answer => { rl.close(); process.stdout.write("\n"); resolve(answer.trim()) })
    muted = true
  })
}
const token = await readHidden(`Hugging Face token for ${id}: `)
if (!token) { console.error("Empty; nothing stored."); process.exit(1) }
if (!looksLikeToken(token)) console.error("Note: Hugging Face tokens start with hf_. Storing it anyway.")
await service.setToken(account, token)
const d = await service.rediscover(account)
console.log(d.error ? `Stored, but Hugging Face said: ${d.error}` : `Stored. Signed in as ${d.name ?? "?"}${d.orgs?.length ? ` (orgs: ${d.orgs.join(", ")})` : ""}, token ${d.tokenRole ?? "?"}.`)
service.dispose()
