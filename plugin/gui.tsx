import { Command, MenuItem, Panel, Plugin, SettingsPage, type Context, type MountedSession } from "@opencode/plugin/gui"
import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { HuggingFaceRpc, inherited, type AccountView, type Effect, type ImportPreview, type StateView } from "./rpc.js"

type Ctx = Context
type Client = MountedSession["server"]["client"]
interface Target { client(): Client; location?(): MountedSession["location"]; sessionID?(): string | undefined }

const TAB = "huggingface"
const POLL_MS = 3000
const SIGNIN_POLL_MS = 1500
const COLORS: Record<Effect, string> = { allow: "#2f9e44", ask: "#e8a317", deny: "#e03131" }
const LABELS: Record<string, string> = { read: "read & download", write: "upload & create", delete: "delete", spend: "Jobs & paid compute", admin: "settings & access", scripts: "token for scripts", manage: "edit account", remove: "remove account" }
const GROUPS: Record<string, readonly string[]> = {
  Hub: ["read", "write", "delete", "spend", "admin", "scripts"],
  Account: ["manage", "remove"],
}
const label = (capability: string) => LABELS[capability] ?? capability
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^.*?Error: /, "")
const card: JSX.CSSProperties = { border: "1px solid color-mix(in srgb, currentColor 14%, transparent)", "border-radius": "8px", padding: "10px", display: "flex", "flex-direction": "column", gap: "8px" }
const muted: JSX.CSSProperties = { opacity: 0.7, "font-size": "12px" }
const pickerStyle: JSX.CSSProperties = { font: "inherit", "font-size": "12px", background: "transparent", color: "inherit", border: "1px solid color-mix(in srgb, currentColor 20%, transparent)", "border-radius": "4px", padding: "1px 4px" }

function createStore(ctx: Ctx, target: Target) {
  const [state, setState] = createSignal<StateView>()
  const [error, setError] = createSignal<string>()
  let inFlight = false
  const api = () => target.client().rpc(HuggingFaceRpc)
  const options = () => ({ ...(target.location?.() && { location: target.location!() }) })
  const sessionInput = () => { const id = target.sessionID?.(); return id ? { sessionID: id } : {} }
  const accept = (next: unknown) => {
    const view = next as StateView
    if (view.fingerprint !== state()?.fingerprint) setState(view)
    setError(undefined)
  }
  const refresh = async () => {
    if (inFlight) return
    inFlight = true
    try { accept(await api().state(sessionInput(), options())) }
    catch (cause) { setError(message(cause)) }
    finally { inFlight = false }
  }
  const run = async <T,>(action: (rpc: ReturnType<typeof api>, opts: ReturnType<typeof options>) => Promise<T>, success?: string): Promise<T | undefined> => {
    try {
      const result = await action(api(), options())
      if (success) ctx.toast.show({ title: success, variant: "success" })
      return result
    } catch (cause) {
      const text = message(cause)
      ctx.toast.show({ title: /now revision/.test(text) ? "Permissions changed elsewhere; reloaded" : "Hugging Face", description: /now revision/.test(text) ? undefined : text, variant: "error" })
      return undefined
    } finally { await refresh() }
  }
  onMount(() => {
    void refresh()
    // Faster while a sign-in code is on screen, so success shows up promptly.
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      if (document.visibilityState === "visible") void refresh()
      timer = setTimeout(tick, state()?.accounts.some(account => account.signIn?.status === "waiting") ? SIGNIN_POLL_MS : POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    onCleanup(() => clearTimeout(timer))
  })
  return { state, error, refresh, run, sessionInput, accept }
}
type Store = ReturnType<typeof createStore>

function Field(props: { label: string; children: JSX.Element }) {
  return <label style={{ display: "flex", "flex-direction": "column", gap: "4px" }}><span style={muted}>{props.label}</span>{props.children}</label>
}

/** Rows: Any agent, agents with own cells (or all), This session. Columns: capabilities of one group, for one entity. */
function Grid(props: { store: Store; entity: string; capabilities: readonly string[]; showAll: boolean }) {
  const state = () => props.store.state()!
  const rows = () => [
    { label: "Any agent", agent: "*" as string | undefined, title: "Default for every agent" },
    ...state().agents.filter(agent => props.showAll || props.capabilities.some(capability => state().cells[props.entity]?.[agent.id]?.[capability])).map(agent => ({ label: agent.name, agent: agent.id as string | undefined, title: `${agent.name} (${agent.mode})` })),
    ...(state().session ? [{ label: "This session", agent: undefined, title: "Overrides for the current session and its subagents only" }] : []),
  ]
  const own = (row: { agent?: string }, capability: string) =>
    row.agent ? state().cells[props.entity]?.[row.agent]?.[capability] : state().session?.cells[props.entity]?.[capability]
  const change = (row: { agent?: string }, capability: string, effect: Effect | null) =>
    props.store.run((rpc, opts) => rpc.setCells({
      expectedRevision: state().revision, ...props.store.sessionInput(),
      changes: [{ entity: props.entity, capability, effect, ...(row.agent ? { agent: row.agent } : { session: true }) }],
    }, opts).then(next => props.store.accept(next)))
  const cell: JSX.CSSProperties = { padding: "4px 6px", "border-bottom": "1px solid color-mix(in srgb, currentColor 12%, transparent)", "text-align": "left", "white-space": "nowrap" }
  return (
    <div style={{ "overflow-x": "auto" }}>
      <table style={{ "border-collapse": "collapse", "font-size": "12px", width: "100%" }}>
        <thead><tr><th style={cell} /><For each={props.capabilities}>{capability => <th style={{ ...cell, "font-weight": 500 }}>{label(capability)}</th>}</For></tr></thead>
        <tbody>
          <For each={rows()}>{row => (
            <tr>
              <td style={{ ...cell, opacity: 0.85, "font-style": row.agent ? undefined : "italic" }} title={row.title}>{row.label}</td>
              <For each={props.capabilities}>{capability => {
                const value = () => own(row, capability)
                const shown = () => value() ?? (row.agent ? inherited(state(), props.entity, capability, row.agent) : undefined)
                return (
                  <td style={cell}>
                    <select aria-label={`${capability} for ${row.label}`} value={value() ?? ""} onChange={event => void change(row, capability, (event.currentTarget.value || null) as Effect | null)}
                      style={{ ...pickerStyle, color: shown() ? COLORS[shown()!] : "inherit", "font-weight": value() ? 600 : 400, opacity: value() ? 1 : 0.7 }}>
                      <option value="">{shown() ? `· ${shown()}` : "· inherit"}</option>
                      <option value="allow">allow</option>
                      <option value="ask">ask</option>
                      <option value="deny">deny</option>
                    </select>
                  </td>
                )
              }}</For>
            </tr>
          )}</For>
        </tbody>
      </table>
    </div>
  )
}

function ExportDialog(props: { ctx: Ctx; store: Store; close(): void }) {
  const [passphrase, setPassphrase] = createSignal("")
  const [confirm, setConfirm] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const valid = () => [...passphrase()].length >= 10 && passphrase() === confirm()
  const go = async () => {
    if (!valid() || busy()) return
    setBusy(true)
    const result = await props.store.run((rpc, opts) => rpc.exportBundle({ passphrase: passphrase() }, opts)) as { name: string; content: string; counts: { accounts: number; secrets: number } } | undefined
    setBusy(false)
    if (result && await props.ctx.system.save({ name: result.name, content: result.content })) {
      props.ctx.toast.show({ title: "Exported", description: `${result.counts.accounts} accounts, ${result.counts.secrets} stored sign-in values → ${result.name}`, variant: "success" })
      props.close()
    }
  }
  return (
    <props.ctx.ui.Dialog title="Export Hugging Face accounts" description="Accounts, agent permissions and sign-ins in one encrypted file. Keep the passphrase; it is needed to import."
      footer={<><props.ctx.ui.Button variant="ghost" onClick={props.close}>Cancel</props.ctx.ui.Button><props.ctx.ui.Button variant="contrast" busy={busy()} disabled={!valid()} onClick={() => void go()}>Export…</props.ctx.ui.Button></>}>
      <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
        <Field label="Passphrase (10+ characters)"><props.ctx.ui.TextInput label="Passphrase" type="password" value={passphrase()} onInput={setPassphrase} autofocus /></Field>
        <Field label="Repeat passphrase"><props.ctx.ui.TextInput label="Repeat passphrase" type="password" value={confirm()} onInput={setConfirm} invalid={!!confirm() && confirm() !== passphrase()} onSubmit={() => void go()} /></Field>
      </div>
    </props.ctx.ui.Dialog>
  )
}

function ImportDialog(props: { ctx: Ctx; store: Store; close(): void }) {
  const [content, setContent] = createSignal<string>()
  const [file, setFile] = createSignal("")
  const [passphrase, setPassphrase] = createSignal("")
  const [preview, setPreview] = createSignal<ImportPreview>()
  const [mode, setMode] = createSignal<"merge" | "replace">("merge")
  const [busy, setBusy] = createSignal(false)
  let input: HTMLInputElement | undefined
  const pick = async (event: Event) => {
    const chosen = (event.currentTarget as HTMLInputElement).files?.[0]
    if (!chosen) return
    setFile(chosen.name); setPreview(undefined); setContent(await chosen.text())
  }
  const check = async () => {
    if (!content() || !passphrase() || busy()) return
    setBusy(true)
    setPreview(await props.store.run((rpc, opts) => rpc.previewImport({ content: content()!, passphrase: passphrase() }, opts)) as ImportPreview | undefined)
    setBusy(false)
  }
  const apply = async () => {
    if (!preview() || busy()) return
    setBusy(true)
    const result = await props.store.run((rpc, opts) => rpc.applyImport({ content: content()!, passphrase: passphrase(), mode: mode() }, opts), "Imported")
    setBusy(false)
    if (result) { setPassphrase(""); setContent(undefined); props.close() }
  }
  const counts = (items: readonly { status: string }[]) => {
    const by = (status: string) => items.filter(item => item.status === status).length
    return `${by("added")} new, ${by("changed")} changed, ${by("unchanged")} same${by("local-only") ? `, ${by("local-only")} only here (${mode() === "replace" ? "removed" : "kept"})` : ""}`
  }
  return (
    <props.ctx.ui.Dialog title="Import Hugging Face accounts" description="Nothing changes until you press Import." size="normal"
      footer={<>
        <props.ctx.ui.Button variant="ghost" onClick={props.close}>Cancel</props.ctx.ui.Button>
        <Show when={preview()} fallback={<props.ctx.ui.Button variant="contrast" busy={busy()} disabled={!content() || !passphrase()} onClick={() => void check()}>Preview</props.ctx.ui.Button>}>
          <props.ctx.ui.Button variant={mode() === "replace" ? "danger" : "contrast"} busy={busy()} onClick={() => void apply()}>Import</props.ctx.ui.Button>
        </Show>
      </>}>
      <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
        <input ref={input} type="file" accept=".ocbundle,application/json" style={{ display: "none" }} onChange={event => void pick(event)} />
        <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
          <props.ctx.ui.Button icon="download" onClick={() => input?.click()}>Choose file…</props.ctx.ui.Button>
          <span style={{ opacity: 0.8 }}>{file() || "No file chosen"}</span>
        </div>
        <Field label="Bundle passphrase"><props.ctx.ui.TextInput label="Bundle passphrase" type="password" value={passphrase()} onInput={value => { setPassphrase(value); setPreview(undefined) }} onSubmit={() => void check()} /></Field>
        <Show when={preview()}>{view => <>
          <div style={{ "font-size": "13px", display: "flex", "flex-direction": "column", gap: "2px" }}>
            <span>Exported {new Date(view().createdAt).toLocaleString()}</span>
            <span>Accounts: {counts(view().accounts)}</span>
            <span>{view().secrets} stored sign-in values, permissions for {view().permissionEntities} accounts</span>
          </div>
          <Field label="Mode"><props.ctx.ui.Select label="Mode" value={mode()} onChange={setMode} options={[
            { value: "merge", label: "Merge: add and update; keep everything else" }, { value: "replace", label: "Replace: make this install match the file" },
          ]} /></Field>
        </>}</Show>
      </div>
    </props.ctx.ui.Dialog>
  )
}

function AddAccountDialog(props: { ctx: Ctx; store: Store; close(): void }) {
  const [id, setId] = createSignal("personal")
  const [auth, setAuth] = createSignal<"browser" | "token">("browser")
  const valid = () => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id())
  const create = async () => {
    if (!valid()) return
    const result = await props.store.run((rpc, opts) => rpc.createAccount({ id: id(), auth: auth() }, opts), `Added ${id()}`)
    if (!result) return
    props.close()
    if (auth() === "browser") void props.store.run((rpc, opts) => rpc.signIn({ id: id() }, opts))
    else props.ctx.dialogs.open(dialog => <KeyDialog ctx={props.ctx} store={props.store} account={id()} close={() => dialog.close()} />)
  }
  return (
    <props.ctx.ui.Dialog title="Add Hugging Face account" description="One per Hugging Face login. Organizations come with the login."
      footer={<>
        <props.ctx.ui.Button variant="ghost" onClick={props.close}>Cancel</props.ctx.ui.Button>
        <props.ctx.ui.Button variant="contrast" disabled={!valid()} onClick={() => void create()}>{auth() === "browser" ? "Add and sign in" : "Add"}</props.ctx.ui.Button>
      </>}>
      <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
        <Field label="Name (e.g. personal, work)"><props.ctx.ui.TextInput label="Name" value={id()} onInput={setId} autofocus /></Field>
        <Field label="Sign in with"><props.ctx.ui.Select label="Sign in with" value={auth()} onChange={setAuth} options={[
          { value: "browser", label: "Browser (Sign in with Hugging Face; recommended)" },
          { value: "token", label: "A token I create at huggingface.co/settings/tokens" },
        ]} /></Field>
      </div>
    </props.ctx.ui.Dialog>
  )
}

function KeyDialog(props: { ctx: Ctx; store: Store; account: string; close(): void }) {
  const [value, setValue] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const save = async () => {
    if (!value() || busy()) return
    setBusy(true)
    const result = await props.store.run((rpc, opts) => rpc.setToken({ id: props.account, token: value() }, opts)) as { user?: string | null; error?: string } | undefined
    setBusy(false)
    if (!result) return
    setValue("")
    props.ctx.toast.show(result.error ? { title: "Token stored, but Hugging Face rejected it", description: result.error, variant: "error" } : { title: `Connected${result.user ? ` as ${result.user}` : ""}`, variant: "success" })
    props.close()
  }
  return (
    <props.ctx.ui.Dialog title={`Token for ${props.account}`} description="Create it at huggingface.co/settings/tokens (Write, or fine-grained for the repos agents need). Stored encrypted on this OpenCode server; the agent only sees that it is set."
      footer={<>
        <props.ctx.ui.Button variant="ghost" onClick={() => { setValue(""); props.close() }}>Cancel</props.ctx.ui.Button>
        <props.ctx.ui.Button variant="contrast" busy={busy()} disabled={!value()} onClick={() => void save()}>Save</props.ctx.ui.Button>
      </>}>
      <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
        <props.ctx.ui.Button size="small" icon="square-arrow-top-right" onClick={() => props.ctx.system.openExternal("https://huggingface.co/settings/tokens")}>Open token settings</props.ctx.ui.Button>
        <Field label="Token (hf_…)"><props.ctx.ui.TextInput label="Token" type="password" value={value()} onInput={setValue} onSubmit={() => void save()} autofocus /></Field>
      </div>
    </props.ctx.ui.Dialog>
  )
}

function SignInBox(props: { ctx: Ctx; store: Store; account: AccountView }) {
  const signIn = () => props.account.signIn!
  const [pasted, setPasted] = createSignal("")
  return (
    <div style={{ ...card, "border-color": signIn().status === "failed" ? COLORS.deny : COLORS.ask, background: "color-mix(in srgb, currentColor 4%, transparent)" }}>
      <Show when={signIn().status === "waiting"} fallback={<span style={{ color: COLORS.deny }}>Sign-in failed: {signIn().error}</span>}>
        <span>Open the sign-in, log in to Hugging Face, choose the organizations agents may use, and click <b>Authorize</b>.</span>
        <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
          <props.ctx.ui.Button size="small" variant="contrast" icon="square-arrow-top-right" onClick={() => props.ctx.system.openExternal(signIn().url)}>Open sign-in</props.ctx.ui.Button>
          <props.ctx.ui.Button size="small" icon="copy" onClick={() => void props.ctx.system.copy(signIn().url).then(() => props.ctx.toast.show({ title: "Link copied" }))}>Copy link</props.ctx.ui.Button>
          <props.ctx.ui.Button size="small" variant="ghost" onClick={() => void props.store.run((rpc, opts) => rpc.cancelSignIn({ id: props.account.id }, opts))}>Cancel</props.ctx.ui.Button>
        </div>
        <details style={muted}>
          <summary>Browser on another computer?</summary>
          <div style={{ display: "flex", gap: "6px", "align-items": "center", "margin-top": "6px" }}>
            <props.ctx.ui.TextInput label="Address after sign-in" placeholder="Paste the http://127.0.0.1:…/callback?code=… address" value={pasted()} onInput={setPasted} />
            <props.ctx.ui.Button size="small" disabled={!pasted()} onClick={() => void props.store.run((rpc, opts) => rpc.completeSignIn({ id: props.account.id, url: pasted() }, opts))}>Finish</props.ctx.ui.Button>
          </div>
        </details>
        <span style={muted}>Waiting for Hugging Face… the link expires at {new Date(signIn().expiresAt).toLocaleTimeString()}.</span>
      </Show>
    </div>
  )
}

type Pickers = Map<string, ReturnType<typeof createSignal<string>>>

function AccountCard(props: { ctx: Ctx; store: Store; account: AccountView; showAll: boolean; pickers: Pickers }) {
  const { ctx, store } = props
  const account = () => props.account
  if (!props.pickers.has(props.account.id)) props.pickers.set(props.account.id, createSignal("Hub"))
  const [group, setGroup] = props.pickers.get(props.account.id)!
  const confirmRemove = () => ctx.dialogs.open(dialog => (
    <ctx.ui.Dialog title={`Remove ${account().id}?`} description="Deletes its stored key and permission settings from this plugin. Nothing changes on Hugging Face; revoke the token or app at huggingface.co/settings if it is no longer needed."
      footer={<>
        <ctx.ui.Button variant="ghost" onClick={() => dialog.close()}>Cancel</ctx.ui.Button>
        <ctx.ui.Button variant="danger" onClick={() => { dialog.close(); void store.run((rpc, opts) => rpc.removeAccount({ id: account().id }, opts), `Removed ${account().id}`) }}>Remove</ctx.ui.Button>
      </>} />
  ))
  const summary = () => [
    account().signedIn ? (account().user ? `${account().user}${account().orgs?.length ? ` · orgs ${account().orgs!.join(", ")}` : ""}` : "connected") : "not signed in",
    account().tokenRole ? `token ${account().tokenRole}` : undefined, account().auth === "token" ? "token" : "browser sign-in", account().label,
  ].filter(Boolean).join(" · ")
  return (
    <div style={card}>
      <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
        <b>{account().id}</b>
        <span style={{ flex: 1, ...muted }}>{summary()}</span>
        <Show when={account().auth === "browser"}>
          <ctx.ui.Button size="small" variant={account().signedIn ? "ghost" : "contrast"} onClick={() => void store.run((rpc, opts) => rpc.signIn({ id: account().id }, opts))}>{account().signedIn ? "Sign in again" : "Sign in"}</ctx.ui.Button>
        </Show>
        <Show when={account().auth === "token"}>
          <ctx.ui.Button size="small" variant={account().signedIn ? "ghost" : "contrast"} icon="lock" onClick={() => ctx.dialogs.open(dialog => <KeyDialog ctx={ctx} store={store} account={account().id} close={() => dialog.close()} />)}>{account().signedIn ? "Replace token" : "Enter token"}</ctx.ui.Button>
        </Show>
        <Show when={account().signedIn}>
          <ctx.ui.Button size="small" variant="ghost" icon="refresh" onClick={() => void store.run((rpc, opts) => rpc.refresh({ id: account().id }, opts), "Checked")}>Check</ctx.ui.Button>
          <ctx.ui.Button size="small" variant="ghost" onClick={() => void store.run((rpc, opts) => rpc.signOut({ id: account().id }, opts), `Signed out ${account().id}`)}>Sign out</ctx.ui.Button>
        </Show>
        <Show when={store.state()!.accounts.length > 1}>
          <ctx.ui.Switch label="Default" checked={account().isDefault} onChange={value => void store.run((rpc, opts) => rpc.setDefault({ id: value ? account().id : null }, opts))} />
        </Show>
        <ctx.ui.IconButton icon="trash" label={`Remove ${account().id}`} variant="ghost" size="small" onClick={confirmRemove} />
      </div>
      <Show when={account().signIn}><SignInBox ctx={ctx} store={store} account={account()} /></Show>
      <Show when={account().error}><span style={{ color: COLORS.deny, "font-size": "12px" }}>{account().error}</span></Show>
      <Show when={account().actions}><span style={muted}>{account().actions} Hub actions (more at huggingface.co/settings/mcp)</span></Show>
      <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
        <span style={muted}>Permissions for</span>
        <select aria-label={`Group for ${account().id}`} value={group()} onChange={event => setGroup(event.currentTarget.value)} style={pickerStyle}>
          <For each={Object.keys(GROUPS)}>{name => <option value={name}>{name}</option>}</For>
        </select>
      </div>
      <Grid store={store} entity={account().id} capabilities={GROUPS[group()] ?? []} showAll={props.showAll} />
    </div>
  )
}

function HuggingFaceView(props: { ctx: Ctx; target: Target }) {
  const { ctx } = props
  const store = createStore(ctx, props.target)
  const [showAll, setShowAll] = createSignal(false)
  const pickers: Pickers = new Map()
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "16px", padding: "12px", "font-size": "13px", "overflow-y": "auto", height: "100%", "box-sizing": "border-box" }}>
      <div style={{ display: "flex", gap: "6px", "align-items": "center", "flex-wrap": "wrap" }}>
        <span style={{ flex: 1, ...muted }}>Hugging Face accounts your agents can use: search, download and upload models and datasets, Spaces, Jobs. You own sign-ins and permissions.</span>
        <ctx.ui.Button size="small" variant="contrast" icon="plus" onClick={() => ctx.dialogs.open(dialog => <AddAccountDialog ctx={ctx} store={store} close={() => dialog.close()} />)}>Add account</ctx.ui.Button>
        <ctx.ui.Button size="small" variant="ghost" icon="download" onClick={() => ctx.dialogs.open(dialog => <ImportDialog ctx={ctx} store={store} close={() => dialog.close()} />)}>Import</ctx.ui.Button>
        <ctx.ui.Button size="small" variant="ghost" icon="cloud-upload" onClick={() => ctx.dialogs.open(dialog => <ExportDialog ctx={ctx} store={store} close={() => dialog.close()} />)}>Export</ctx.ui.Button>
        <ctx.ui.IconButton icon="refresh" label="Refresh" variant="ghost" size="small" onClick={() => void store.refresh()} />
      </div>
      <Show when={store.error() && !store.state()}><div style={{ color: COLORS.deny }}>Hugging Face unavailable: {store.error()}. Is oc-huggingface enabled on this server?</div></Show>
      <Show when={!store.state() && !store.error()}><ctx.ui.Loader /></Show>
      <Show when={store.state()}>{state => <>
        <ctx.ui.Switch label="Show all agents" checked={showAll()} onChange={setShowAll} />
        <Show when={state().accounts.length} fallback={<span style={muted}>No accounts yet. Click Add account, or ask your agent, e.g. “connect my Hugging Face account”.</span>}>
          <For each={state().accounts}>{account => <AccountCard ctx={ctx} store={store} account={account} showAll={showAll()} pickers={pickers} />}</For>
        </Show>
        <span style={muted}>Cells: allow runs without asking, ask shows a prompt each time, deny refuses. “· x” means inherited. “Jobs & paid compute” covers Jobs, Inference Endpoints, sandboxes and Spaces; “token for scripts” gives the token to programs that reference $HF_TOKEN. Hugging Face's own permissions still apply on top.</span>
      </>}</Show>
    </div>
  )
}

export default Plugin.define({
  setup(ctx) {
    const key = `${ctx.id}:${TAB}`
    const tab = { id: TAB, title: "Hugging Face" }
    ctx.add(Panel, {
      id: "huggingface", region: "side", width: 640,
      mobile: { title: "Hugging Face", order: 85, kind: "menu", icon: "cube" },
      list: input => input.open.includes(TAB) ? [tab] : [],
      render: props => <HuggingFaceView ctx={ctx} target={{ client: () => props.session.server.client, location: () => props.session.location, sessionID: () => props.session.pending ? undefined : props.session.id }} />,
    })
    const open = () => { const session = ctx.sessions.current(); if (session) ctx.layout.open(key, session) }
    ctx.add(MenuItem, { menu: "session.panel", id: "open-huggingface", title: "Hugging Face", icon: "cube", description: "Models, datasets, permissions", run: open })
    ctx.add(Command, () => ({ id: "open", title: "Open Hugging Face accounts", group: "Hugging Face", slash: { name: "huggingface" }, enabled: !!ctx.sessions.current(), run: open }))
    ctx.add(SettingsPage, {
      id: "huggingface", title: "Hugging Face", icon: "cube",
      entries: [{ id: "huggingface", title: "Hugging Face", description: "Hugging Face accounts, sign-in and permissions for agents", keywords: "hugging face hf models datasets spaces hub token oc-huggingface export import" }],
      render: () => (
        <ctx.ui.SettingsLayout title="Hugging Face" description="Hugging Face accounts your agents can use, and who may do what.">
          <HuggingFaceView ctx={ctx} target={{ client: () => ctx.client }} />
        </ctx.ui.SettingsLayout>
      ),
    })
  },
})
