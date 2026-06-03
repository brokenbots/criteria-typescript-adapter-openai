# Example workflow using the OpenAI adapter
#
# Prerequisites:
#   1. Build the adapter: bun run build
#   2. Install to plugins directory: cp out/adapter ~/.criteria/plugins/criteria-adapter-openai
#   3. Set OPENAI_API_KEY secret via the host secret provider.
#
# Run: criteria apply example.hcl

workflow "code-review" {
  version       = "0.1"
  initial_state = "analyze"
  target_state  = "done"
}

adapter "openai" "default" {
  config {
    model       = "gpt-4o"
    max_turns   = 10
    system_prompt = "You are a senior software engineer performing code reviews."
  }
}

step "analyze" {
  target = adapter.openai.default

  input {
    prompt = "Review this code for security vulnerabilities: $(file src/main.ts)"
    max_turns = 5
  }

  outcome "clean" {
    next = state.deploy
  }

  outcome "issues_found" {
    next = state.fix
  }

  outcome "failure" {
    next = state.failed
  }
}

step "fix" {
  target = adapter.openai.default

  input {
    prompt = "Fix the security issues found in the previous step."
  }

  outcome "success" {
    next = state.done
  }

  outcome "failure" {
    next = state.failed
  }
}

state "deploy" {
  terminal = true
}

state "done" {
  terminal = true
}

state "failed" {
  terminal = true
  success  = false
}

