# oc-huggingface

Hugging Face for OpenCode agents. Any number of accounts; each signs in through the browser (OAuth, works with SSO,
tokens refresh automatically) or with a user access token. Agents search and read the Hub through Hugging Face's own
agent tools, and use the normal `hf` CLI, `git` and Python (`huggingface_hub`, `transformers`, `datasets`) in their
own shell: the right account's token is supplied to that one command after a permission check, and masked in the
output. Agents never see the token. macOS and Linux; OpenCode 2.2.6+ and Pixi.

## What agents get

| Tool | What it does |
|---|---|
| `huggingface_list` | Accounts, who they are, organizations, and what agents may do |
| `huggingface_find_actions` / `huggingface_run` | Hugging Face's Hub tools: search models/datasets/Spaces, repo details, files, papers, docs (more, such as Jobs and repo creation, can be enabled at huggingface.co/settings/mcp) |
| `huggingface_account_upsert` / `_remove` / `_signin` / `_refresh` / `_request_token` | Account setup (the agent can do it when you ask) |

In the agent's shell, `HF_TOKEN` (and a git credential for huggingface.co and hf.co) is supplied to:
`hf` / `huggingface-cli`, `git` for the Hub (including a plain `git push` in a repo whose remote is on the Hub), Python
and ML launchers (`pixi run`, `pixi exec`, `python`, `accelerate`, `torchrun`, `vllm`, …) and commands that mention
`$HF_TOKEN`. Other commands are not touched. With several accounts, `OC_HF_ACCOUNT=<id>` picks one per command.
A `huggingface` skill gives agents the know-how (pinning revisions, gated models, caches, `hf` commands).

## Permissions

Per account and agent (allow / ask / deny) in **Settings → Hugging Face** or `/huggingface`:

| Permission | Covers | Default |
|---|---|---|
| read & download | search, details, downloads, clone/pull | allow |
| upload & create | uploads, new repos and branches, push, discussions | allow |
| delete | deleting repos/files/branches, force-push | ask |
| Jobs & paid compute | Jobs, Inference Endpoints, sandboxes, Spaces | ask |
| settings & access | visibility, gating, repo settings | ask |
| token for scripts | Python and ML launchers, `$HF_TOKEN` | allow |

A denied command runs without any Hugging Face token and the agent is told why. "Allow always" on a prompt updates the
table. Hugging Face's own permissions (the organizations you grant at sign-in, or a fine-grained token's scopes) apply
on top.

## Install

Requires [OpenCode](https://opencode.ai) 2.2.6+ (CLI or Desktop) and [Pixi](https://pixi.sh); macOS or Linux.

```sh
git clone https://github.com/p-w-rs/oc-huggingface.git && cd oc-huggingface
pixi run --locked install          # runs the tests, then installs a verified snapshot into your OpenCode config
```

Restart OpenCode (or `/reload`). Then open **Settings → Hugging Face** (or `/huggingface` in a session) and add an account, or from a terminal: `pixi run signin personal` (browser) or `pixi run token-set personal` (token).
Agents can also set things up for you when you ask.

```sh
pixi run --locked install-status   # what is installed, and whether its files are intact
pixi run --locked rollback         # back to the previous snapshot
pixi run --locked uninstall        # removes only this plugin's entry; your data stays
```

Updating: `git pull && pixi run --locked install`. Accounts, sign-ins and permissions live in
`~/.local/share/oc-huggingface` and survive updates; move them between computers with **Export** / **Import** in the view.

## Development

```sh
pixi run --locked test             # type check, unit tests (fake Hugging Face), installer test
pixi run --locked smoke-host       # end to end on the real OpenCode CLI with a scripted model
pixi run --locked smoke-snapshot   # the same, from an installed snapshot
pixi run desktop-dev start         # macOS: the installed Desktop app with an isolated profile and a fake Hub
```

Notes: browser sign-in registers a public OAuth client with Hugging Face (dynamic registration + PKCE) asking for the
scopes agents need (read/write/manage repos, gated repos, organizations, Inference Providers, Jobs, discussions); the
consent page lets you choose organizations. Sign-in identity comes from `whoami-v2`, which Hugging Face rate-limits,
so it is only called on sign-in and on **Check**.
