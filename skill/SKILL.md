---
name: huggingface
description: Work effectively with the Hugging Face Hub through oc-huggingface — finding models, datasets, Spaces and papers, gated and private repos, hf download/upload/repos/jobs, git for huggingface.co, transformers/datasets loading, caching and Xet storage, Inference Providers, and which account's token a command uses. Load before non-trivial Hugging Face work.
---

# Working with the Hugging Face Hub

## How access works here

- **Never run `hf auth login` / `huggingface-cli login`** (or `hf auth token`), and never write a token to a file or
  `.env`. The plugin supplies the signed-in account's token (`HF_TOKEN`) per command to: `hf` / `huggingface-cli`
  (also as `pixi exec … hf`, `uvx hf`, `pipx run … hf`); `git` network commands (clone, pull, fetch, push, lfs, xet)
  for huggingface.co / hf.co, or in a repo whose remote is the Hub; Python and ML launchers (`python`, `accelerate`,
  `torchrun`, `deepspeed`, `vllm`, `lm_eval`, `jupyter`, and `pixi run|exec`, `uv run`, `uvx`, `conda run`); and commands
  that mention `$HF_TOKEN`. Other commands get nothing. Output is masked. Several accounts: put `OC_HF_ACCOUNT=<id>`
  in front of the command. For `hf jobs run`, pass the token as `--secrets HF_TOKEN` (never `-e HF_TOKEN=…`).
- **Searching and reading the Hub**: `huggingface_find_actions` + `huggingface_run` (Hugging Face's own Hub tools:
  `hub_repo_search`, `hub_repo_details`, `hf_fs` for files, cards, collections, papers and docs, `hf_whoami`). Read
  the schema with `names=[...]` first. Space tools (`dynamic_space`, `gr…`) use quota (spend). The user can enable more
  (repo creation, Jobs) at huggingface.co/settings/mcp.
- **Moving files and managing repos**: the `hf` CLI (huggingface_hub ≥ 1.0). If it is not installed, run it through Pixi:
  `pixi exec --spec huggingface_hub hf …` (or add `huggingface_hub` to the project and use `pixi run hf …`).
- Permissions (user's table; defaults): read, write (upload/create/push) and scripts (token for programs) run; delete
  (repos, files, branches, force-push, `--delete`), spend (Jobs, Endpoints, sandboxes, Spaces) and admin
  (`hf repos settings`/`move`: visibility, gating) ask. A denied command runs without the token and says so; tell the
  user rather than working around it.

## Ground truth first

- Check the repo before using it: `hub_repo_details` (license, gated, size, files, library, pipeline tag, last
  update). Prefer the official org (e.g. `meta-llama`, `Qwen`, `google`, `mistralai`, `nvidia`) over re-uploads.
- Pin what you use: `revision=<commit sha>` (or a tag) in code and in `hf download --revision`, and record it
  (MLflow param, README). `main` moves.
- Read the model card (`hf models card <id>`) for the chat template, context length, dtype, and required `transformers`
  version or `trust_remote_code`. Avoid `trust_remote_code=True` unless the user agrees; review the code it runs.
- **Gated models**: a 401/403 or "gated repo" means the account has not been granted access. The user must accept
  the terms on the model page (with the account whose token is used); you cannot do it for them.

## hf CLI essentials

```sh
hf download Qwen/Qwen3-0.6B                              # whole repo into the cache; prints the local path
hf download Qwen/Qwen3-0.6B config.json --revision <sha>  # specific files
hf download org/data --repo-type dataset --include "*.parquet" --local-dir data/
hf upload me/my-model ./out . --commit-message "v1"      # folder → repo root (creates the repo if needed)
                                                         # big folders: split into commits; rerun to resume
hf repos create me/my-model --private                     # also --repo-type dataset|space
hf repos delete me/old                                    # asks the user first (delete)
hf repos delete-files me/x "*.bin"                        # delete (asks); branches/tags: hf repos branch|tag --help
hf models info org/name   hf models card org/name   hf datasets info org/name   hf papers search "…"
hf datasets sql "SELECT … FROM read_parquet('…')"         # DuckDB over a dataset's parquet files
hf cache ls / hf cache rm … / hf cache prune              # inspect and clean the local cache
hf jobs hardware                                          # flavors and prices
hf jobs run --flavor a10g-small --secrets HF_TOKEN pytorch/pytorch:latest python train.py   # costs money: asks
hf jobs uv run --flavor a10g-small train.py               # Python script with inline deps
hf jobs ps / hf jobs logs <id> / hf jobs cancel <id>
hf env                                                    # versions and paths, for bug reports
```

Use `--json` (`--format json`) when you parse output; `hf <cmd> --help` for anything else. There is no
`upload-large-folder` command any more (`hf upload` resumes). Transfers use Xet automatically; for very fast machines
set `HF_XET_HIGH_PERFORMANCE=1` (`HF_HUB_ENABLE_HF_TRANSFER` is deprecated and does nothing).

## Python

```python
from huggingface_hub import snapshot_download, hf_hub_download, HfApi
path = snapshot_download("Qwen/Qwen3-0.6B", revision="<sha>", allow_patterns=["*.json", "*.safetensors"])
HfApi().upload_folder(repo_id="me/my-model", folder_path="out", commit_message="v1")
```

`transformers` / `datasets` / `diffusers` pick up `HF_TOKEN` automatically; do not pass `token=` literals.
`load_dataset("org/name", revision="<sha>")`; `streaming=True` for huge datasets.
Prefer `.safetensors` weights; never load untrusted pickles (`.bin`, `.pt`) without the user's consent.

## Caches and offline

- Cache: `HF_HOME` (default `~/.cache/huggingface`), hub files in `$HF_HOME/hub`, Xet chunks in `$HF_HOME/xet`.
  Large shared machines: set `HF_HOME` to a big disk instead of copying models around.
- `HF_HUB_OFFLINE=1` uses only the cache (reproducible runs, air-gapped devices such as edge targets). Download on a
  connected machine, then copy `$HF_HOME/hub` or use `--local-dir` and load from the path.

## git

`git clone https://huggingface.co/<org>/<repo>` (datasets: `/datasets/…`, Spaces: `/spaces/…`) gets the token
automatically. Large files need Git LFS and, for Xet-backed repos, `git-xet` (`git xet install`); for weights prefer
`hf download` / `hf upload`, which are faster and resumable. Force-pushes and branch deletes count as delete.

## Inference Providers

OpenAI-compatible endpoint `https://router.huggingface.co/v1` (chat models): `model="org/name:fastest"` (or
`:cheapest`, or a provider such as `:groq`), API key `$HF_TOKEN` (put it in the command or let a Python launcher read
it). It is billed to the account: treat it as spend and say so.
