# 4. Generic agent runtime with configuration-driven agents

Date: 2026-08-03

## Status

Accepted

## Context

Every AI worker in ALTHEA — backend engineers, QA engineers, product managers,
reviewers, and eventually THEA — needs to plan, call models, use tools, access
memory, and report results. Hardcoding each worker would duplicate this
machinery and make THEA a special case.

## Decision

Implement a single generic `AgentRuntime` in `services/ai-engine` where agents
are serializable `AgentConfig` data, not classes. The runtime is assembled via
constructor injection from narrow protocol-based components (model provider,
tool registry, prompt manager, context builder, memory, events, permissions).
Lifecycle transitions are enforced by an explicit state machine. Only the
Ollama provider is implemented; OpenAI, Anthropic, and Gemini are
interface-only stubs registered behind the same `ModelProvider` protocol.
Long-term memory and workflows exist as abstractions (`Memory`,
`WorkflowExecutor`) with null implementations.

## Consequences

- New agents (including THEA) are added as JSON configuration without runtime
  changes; THEA's orchestration abilities become tools/workflows on top of the
  same runtime.
- Switching model providers is a config change (`agent.provider`).
- Every component is independently testable; the runtime itself is tested with
  a fake provider and no network access.
- Business logic must live in tools, workflows, and prompts — never in the
  runtime.
