# OpenAI Adapter

This adapter enables using OpenAI's models as agent backends in Criteria workflows (protocol v2).

## Features

- Multi-turn conversations with OpenAI models
- Tool calling with `submit_outcome` for workflow integration
- Support for different models (gpt-4o, gpt-4-turbo, etc.)
- Configurable max turns per step
- Structured events for observability
- Snapshot / restore for resumable sessions
- Secret-channel-only API key handling (no env-var leakage)

## Setup

1. **Install dependencies:**
   ```bash
   bun install
   ```

2. **Configure secrets via the Criteria host secret provider** (e.g. `secrets.provider = "env"`):
   ```bash
   export OPENAI_API_KEY="sk-..."
   export OPENAI_BASE_URL="https://api.openai.com/v1"   # optional
   export OPENAI_ORG_ID="org-..."                        # optional
   export OPENAI_PROJECT_ID="proj-..."                 # optional
   ```

3. **Build the adapter:**
   ```bash
   bun run build
   ```

4. **Install to Criteria plugins directory:**
   ```bash
   mkdir -p ~/.criteria/plugins
   cp out/adapter ~/.criteria/plugins/criteria-adapter-openai
   chmod +x ~/.criteria/plugins/criteria-adapter-openai
   ```

## Usage

Create a workflow file:

```hcl
workflow "code-review" {
  version       = "0.1"
  initial_state = "analyze"
  target_state  = "done"
}

adapter "openai" "default" {
  config {
   model         = "gpt-4o"
   max_turns     = 10
   system_prompt = "You are a code reviewer."
  }
}

step "analyze" {
  target = adapter.openai.default

  input {
   prompt = "Review this code for bugs: $(file src/main.ts)"
  }

  outcome "clean"        { next = state.deploy }
  outcome "issues_found" { next = state.fix }
  outcome "failure"      { next = state.failed }
}
```

Run the workflow:
```bash
criteria apply workflow.hcl
```

## Configuration

### Adapter config (set once per adapter block)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `model` | string | No | `gpt-4o` | Model to use |
| `max_turns` | number | No | `10` | Default max turns per step |
| `system_prompt` | string | No | - | System prompt for the session |

### Step-level input (set per step)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | **Yes** | The prompt to send to the model |
| `max_turns` | number | No | Per-step override for max turns |
| `model` | string | No | Per-step override for model |

### Secrets

| Name | Required | Description |
|------|----------|-------------|
| `OPENAI_API_KEY` | **Yes** | OpenAI API key |
| `OPENAI_BASE_URL` | No | Override the OpenAI API base URL |
| `OPENAI_ORG_ID` | No | OpenAI organization ID |
| `OPENAI_PROJECT_ID` | No | OpenAI project ID |

## How It Works

The adapter implements a multi-turn conversation loop:

1. **Session Open**: Creates an OpenAI client using secrets from the host, stores conversation history in `helpers.session`
2. **Execute**: Sends the prompt to OpenAI with a `submit_outcome` tool
3. **Tool Calling**: The model can call `submit_outcome(outcome, reason)` to finalize
4. **Outcome Validation**: The adapter validates the outcome via `helpers.outcomes.validate()` against allowed outcomes
5. **Result**: Returns the outcome to Criteria for workflow transition via `helpers.outcomes.finalize()`

### Shelling out safely

If the adapter ever shells out to the official `openai` CLI, use `helpers.secrets.spawnEnv(...)` to build a redacted environment map:

```typescript
const env = await helpers.secrets.spawnEnv(["OPENAI_API_KEY"]);
spawn("openai", [...], { env });
```

## Development

To modify the adapter:

1. Edit `index.ts`
2. Rebuild: `bun run build`
3. Run tests: `bun test`
4. Test with `criteria apply`

## Outputs

| Output | Type | Description |
|--------|------|-------------|
| `reason` | string | Reason for the chosen outcome. |

The step **outcome** is set by the model calling `submit_outcome(outcome, reason)`
and validated against the step's declared outcomes.

## Security & dependencies

Supply-chain controls and the dependency-freshness policy are documented in
[SECURITY.md](SECURITY.md) and [docs/dependency-policy.md](docs/dependency-policy.md).
Reproduce the CI security checks locally:

```bash
bun run vuln-scan      # osv-scanner — blocking known-vulnerability gate (reads bun.lock)
bun run deps:outdated  # bun outdated — freshness report
```

## Publish (multi-platform)

Tagging `vX.Y.Z` cross-compiles `linux/amd64`, `linux/arm64`, and `darwin/arm64`
(`bun build --compile --target=…`) and publishes them as a single multi-platform,
signed OCI artifact to `ghcr.io/brokenbots/criteria-adapter-openai:X.Y.Z` via
[`brokenbots/publish-adapter`](https://github.com/brokenbots/publish-adapter).
Pin and lock it in your workflow with `criteria adapter lock`.
