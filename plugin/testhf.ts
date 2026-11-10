// Test helper: a fake Hugging Face — OAuth (resource + server metadata, dynamic registration that records the scopes,
// PKCE, refresh), whoami-v2, the MCP endpoint, and a git "smart HTTP" check that answers 200 only with the right token.
import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

export interface FakeHf {
  readonly base: string
  readonly mcpUrl: string
  /** A user access token the fake accepts (auth=token accounts). */
  readonly userToken: string
  approve(authorizeUrl: string): Promise<void>
  readonly calls: { name: string; args: Record<string, unknown> }[]
  readonly registeredScopes: () => string | undefined
  /** Basic-auth passwords git presented to the fake repo. */
  readonly gitAuth: string[]
  expireTokens(): void
  stop(): Promise<void>
}

export const INSTRUCTIONS = "You have tools for the Hugging Face Hub. Direct the User to set their HF_TOKEN for higher limits."

export async function startFakeHf(): Promise<FakeHf> {
  const clients = new Map<string, string | undefined>()
  const codes = new Map<string, { clientId: string; challenge: string; redirect: string }>()
  const access = new Map<string, number>()
  const refresh = new Set<string>()
  const sessions = new Set<string>()
  const calls: FakeHf["calls"] = []
  const gitAuth: string[] = []
  const userToken = `hf_${randomBytes(16).toString("hex")}`
  access.set(userToken, Number.MAX_SAFE_INTEGER)
  let registeredScopes: string | undefined
  let base = ""
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)) }
  const read = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer); return Buffer.concat(chunks).toString() }
  const issue = () => {
    const token = `hf_oauth_${randomBytes(12).toString("hex")}`; access.set(token, Date.now() + 8 * 3600_000)
    const r = randomBytes(12).toString("hex"); refresh.add(r)
    return { access_token: token, refresh_token: r, expires_in: 28800, token_type: "Bearer" }
  }
  const valid = (req: IncomingMessage) => { const token = req.headers.authorization?.replace(/^Bearer /, "") ?? ""; const expiry = access.get(token); return expiry !== undefined && expiry > Date.now() ? token : undefined }
  const ro = { readOnlyHint: true, destructiveHint: false }
  const tools = [
    { name: "hf_whoami", description: "Inspect the current Hugging Face authentication context.", annotations: ro, inputSchema: { type: "object", properties: {} } },
    { name: "hub_repo_search", description: "Search and list Hugging Face models, datasets and Spaces.", annotations: ro, inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    { name: "hub_repo_details", description: "Get details for one or more Hugging Face repos.", annotations: ro, inputSchema: { type: "object", properties: { repo_ids: { type: "array" } } } },
    { name: "hf_jobs", description: "Run and manage Jobs on Hugging Face infrastructure.", annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: { type: "object", properties: { operation: { type: "string" } } } },
  ]
  const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, base)
    const path = url.pathname
    if (path === "/.well-known/oauth-protected-resource/mcp") return send(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["openid", "profile", "read-mcp", "read-repos", "jobs", "contribute-repos", "inference-api"], bearer_methods_supported: ["header"] })
    if (path === "/.well-known/oauth-authorization-server") return send(res, 200, { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`, scopes_supported: ["openid", "profile", "email", "read-repos", "write-repos", "manage-repos", "inference-api", "jobs"], code_challenge_methods_supported: ["S256"] })
    if (path === "/oauth/register") {
      const body = JSON.parse(await read(req))
      if (body.token_endpoint_auth_method !== "none") return send(res, 400, { error: "invalid_client_metadata" })
      const id = randomBytes(8).toString("hex"); clients.set(id, body.scope); registeredScopes = body.scope
      return send(res, 201, { client_id: id, redirect_uris: body.redirect_uris, scope: body.scope })
    }
    if (path === "/oauth/authorize") {
      const p = url.searchParams
      if (!clients.has(p.get("client_id")!) || p.get("code_challenge_method") !== "S256") return send(res, 400, { error: "invalid_request" })
      // Like Hugging Face: a client may only ask for the scopes it registered.
      const allowed = new Set((clients.get(p.get("client_id")!) ?? "openid profile").split(" "))
      if ((p.get("scope") ?? "").split(" ").some(scope => scope && !allowed.has(scope))) return send(res, 400, { error: "invalid_scope" })
      const code = randomBytes(8).toString("hex")
      codes.set(code, { clientId: p.get("client_id")!, challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")! })
      res.writeHead(302, { location: `${p.get("redirect_uri")}?code=${code}&state=${p.get("state")}` }); res.end(); return
    }
    if (path === "/oauth/token") {
      const form = new URLSearchParams(await read(req))
      if (form.get("grant_type") === "authorization_code") {
        const entry = codes.get(form.get("code")!)
        if (!entry || entry.clientId !== form.get("client_id") || entry.redirect !== form.get("redirect_uri") || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== entry.challenge) return send(res, 400, { error: "invalid_grant" })
        codes.delete(form.get("code")!)
        return send(res, 200, issue())
      }
      if (form.get("grant_type") === "refresh_token" && refresh.delete(form.get("refresh_token") ?? "")) return send(res, 200, issue())
      return send(res, 400, { error: "invalid_grant" })
    }
    if (path === "/api/whoami-v2") {
      const token = valid(req)
      if (!token) return send(res, 401, { error: "Invalid credentials in Authorization header" })
      return send(res, 200, { type: "user", name: "patlee", fullname: "Pat Lee", email: "pat.lee@acme.example", isPro: false, orgs: [{ name: "acme-ml" }], auth: { type: token.startsWith("hf_oauth_") ? "oauth" : "access_token", ...(!token.startsWith("hf_oauth_") && { accessToken: { displayName: "test", role: "write" } }) } })
    }
    if (path.startsWith("/acme-ml/tiny-model") && path.includes("/info/refs")) {
      const basic = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString()
      const password = basic.slice(basic.indexOf(":") + 1)
      if (!req.headers.authorization) { res.writeHead(401, { "www-authenticate": 'Basic realm="Authentication required"' }); res.end(); return }
      gitAuth.push(password)
      if (!access.has(password)) { res.writeHead(403); res.end("bad token"); return }
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" })
      res.end("001e# service=git-upload-pack\n0000" + "0000")
      return
    }
    if (path === "/mcp") {
      if (!valid(req)) return send(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` })
      const message = JSON.parse(await read(req))
      if (message.method === "initialize") { const id = randomBytes(6).toString("hex"); sessions.add(id); return send(res, 200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "huggingface.co/mcp", version: "0.4.34" }, instructions: INSTRUCTIONS } }, { "mcp-session-id": id }) }
      if (!sessions.has(String(req.headers["mcp-session-id"]))) return send(res, 404, { error: "session not found" })
      if (!("id" in message)) { res.writeHead(202); res.end(); return }
      let result: unknown
      if (message.method === "tools/list") result = { tools }
      else if (message.method === "tools/call") {
        const { name, arguments: args } = message.params
        calls.push({ name, args })
        if (name === "hub_repo_search") result = text("Found 1 model:\n- acme-ml/tiny-model (downloads 42)")
        else if (name === "hf_whoami") result = text("You are patlee")
        else result = text({ ok: true })
      } else return send(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } })
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`); return
    }
    send(res, 404, { error: "Not Found" })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    base, mcpUrl: `${base}/mcp`, userToken, calls, gitAuth, registeredScopes: () => registeredScopes,
    async approve(authorizeUrl) {
      const redirect = await fetch(authorizeUrl, { redirect: "manual" })
      const location = redirect.headers.get("location")
      if (!location) throw new Error(`authorize failed: ${redirect.status} ${await redirect.text()}`)
      await fetch(location)
    },
    expireTokens() { for (const [token] of access) if (token.startsWith("hf_oauth_")) access.set(token, 0) },
    async stop() { await new Promise(resolve => server.close(resolve)) },
  }
}
