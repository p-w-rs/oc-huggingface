import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyAction, classifyHf, normalizeAccount, planCommand } from "./model.js"

test("accounts", () => {
  assert.deepEqual(normalizeAccount({ id: "work" }, new Date(0)), { id: "work", auth: "browser", updatedAt: "1970-01-01T00:00:00.000Z" })
  assert.throws(() => normalizeAccount({ id: "w", auth: "apikey" }), /browser or token/)
  assert.throws(() => normalizeAccount({ id: "w", token: "x" }), /Unknown account field/)
})

test("hf subcommands map to permissions", () => {
  const c = (line: string) => classifyHf(line.split(" "))
  assert.equal(c("download Qwen/Qwen3-0.6B --local-dir m"), "read")
  assert.equal(c("upload acme/model ./out ."), "write")
  assert.equal(c("repos create acme/model --private"), "admin")
  assert.equal(c("repos create acme/model"), "write")
  assert.equal(c("repos delete acme/model"), "delete")
  assert.equal(c("jobs run python:3.12 python -c 1"), "spend")
  assert.equal(c("jobs ps"), "read")
  assert.equal(c("auth whoami"), "read")
})

test("which commands get the token", () => {
  assert.deepEqual(planCommand("ls -la"), { uses: false, capabilities: [], git: false, login: false })
  assert.deepEqual(planCommand("hf download gpt2 && hf upload me/x ."), { uses: true, capabilities: ["read", "write"], git: false, login: false })
  assert.equal(planCommand("pixi exec hf jobs run x").capabilities[0], "spend")
  assert.deepEqual(planCommand("git clone https://huggingface.co/acme/model").capabilities, ["read"])
  assert.equal(planCommand("git push origin main").uses, false, "a push elsewhere is left alone")
  assert.deepEqual(planCommand("git push origin main", true).capabilities, ["write"])
  assert.deepEqual(planCommand("git push --force origin main", true).capabilities, ["delete"])
  assert.deepEqual(planCommand("pixi run python train.py --token $HF_TOKEN").capabilities, ["scripts"])
  assert.deepEqual(planCommand("pixi run python train.py").capabilities, ["scripts"], "Python launchers get it (transformers reads HF_TOKEN)")
  assert.deepEqual(planCommand("torchrun --nproc-per-node 8 train.py").capabilities, ["scripts"])
  assert.equal(planCommand("pixi install").uses, false)
  assert.equal(planCommand("hf auth login").login, true)
})

test("Hub actions", () => {
  assert.equal(classifyAction("hub_repo_search", { readOnlyHint: true }), "read")
  assert.equal(classifyAction("hf_jobs", { readOnlyHint: false }), "spend")
  assert.equal(classifyAction("hf_sandbox_exec"), "spend")
  assert.equal(classifyAction("create_repo", { readOnlyHint: false }), "write")
})
