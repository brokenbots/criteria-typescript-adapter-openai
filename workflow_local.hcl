/**
 * Example Criteria workflow using the OpenAI adapter with a local API endpoint.
 *
 * This connects to an OpenAI-compatible API running locally (e.g. Ollama)
 * at http://localhost:11434/v1 and uses the kimi-k2.6:cloud model.
 */

workflow "openai" {
  version       = "1.0"
  initial_state = "openai"
  target_state  = "done"
}

adapter "openai" "local" {
  config {
    base_url = "http://localhost:11434/v1"
    model    = "kimi-k2.6:cloud"
  }
}

step "openai" {
  target = adapter.openai.local

  input {
    prompt = "Explain what this workflow does in one sentence."
  }

  outcome "success" { next = state.done }
  outcome "failure" { next = state.failed }
}

state "done" {
  terminal = true
}

state "failed" {
  terminal = true
  success  = false
}
