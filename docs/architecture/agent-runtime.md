# Agent Runtime

The agent runtime (`services/ai-engine/app/runtime/`) is the generic execution
engine every ALTHEA AI worker runs on. Agents — including THEA, later — are
**configuration**, not code: instantiating a new worker means writing a JSON
config, never modifying the runtime.

## Components

| Component | Module | Responsibility |
|---|---|---|
| `AgentConfig` | `agent.py` | Serializable agent definition (identity, prompt, tools, permissions, model settings) |
| `Lifecycle` | `agent.py` | Explicit state machine: `created → idle → planning → executing → waiting → reviewing → completed / failed / cancelled` |
| `AgentRegistry` | `registry.py` | Stores agent configs; loads `*.json` definitions from a directory |
| `ModelProvider` | `providers/base.py` | Protocol over LLM backends; `ProviderRegistry` selects one by agent config |
| `OllamaProvider` | `providers/ollama.py` | Implemented provider (`/api/chat`, native tool calling, token usage) |
| OpenAI / Anthropic / Gemini | `providers/stubs.py` | Interface-only placeholders for later milestones |
| `PromptManager` | `prompts.py` | Modular prompt composition: system, developer, context, memory, tool descriptions, output format, task |
| `ContextBuilder` | `context.py` | Builds `ExecutionContext` from project / workspace / issue / artifacts / history / memory |
| `Memory` | `memory.py` | Abstraction (`load_context`, `search`, `remember`, `forget`, `summarize`); `NullMemory` until long-term memory lands |
| `Tool` / `ToolRegistry` | `tools/base.py` | Pluggable tool protocol with auto-discovery (`ToolRegistry.discover()` scans the tools package) |
| Filesystem tools | `tools/filesystem.py` | `read_file`, `write_file`, `search_files` — sandboxed to a workspace root |
| `PermissionManager` | `permissions.py` | Denies tools not in `available_tools` or lacking the required permission |
| `WorkflowExecutor` | `workflows.py` | Abstraction only; concrete workflows are a later milestone |
| `EventPublisher` | `events.py` | `agent_started`, `planning_started`, `model_invoked`, `tool_executed`, `tool_failed`, `completed`, `failed` |
| `ExecutionResult` | `results.py` | Structured outcome: execution id, state, output, token usage, tool invocations, duration |
| `AgentRuntime` | `runtime.py` | Orchestrates a run; contains no business logic |

## Execution flow

```
run(agent, task)
  ├─ created → idle            publish agent_started
  ├─ idle → planning           publish planning_started
  │    build ExecutionContext (context builder + memory search)
  │    compose messages (prompt manager)
  │    select provider (provider registry, by agent.provider)
  ├─ planning → executing
  │    loop (≤ max_iterations):
  │       invoke model         publish model_invoked
  │       execute tool calls   permission check → publish tool_executed / tool_failed
  │       executing → waiting → executing
  ├─ executing → reviewing
  │    remember outcome (agent.memory_scope)
  └─ reviewing → completed     publish completed  →  ExecutionResult
       (any AgentRuntimeError → failed, publish failed)
```

## Dependency injection

`AgentRuntime` receives every collaborator through its constructor
(`ProviderRegistry`, `ToolRegistry`, `PromptManager`, `ContextBuilder`,
`Memory`, `EventPublisher`, `PermissionManager`). There is no global state;
each component is independently testable and replaceable (see
`tests/test_runtime.py`, which swaps in a `FakeProvider`).

## Usage

```python
from app.runtime import AgentRegistry, AgentRuntime
from app.runtime.context import DefaultContextBuilder
from app.runtime.events import LoggingEventPublisher
from app.runtime.memory import NullMemory
from app.runtime.permissions import PermissionManager
from app.runtime.prompts import PromptManager
from app.runtime.providers.base import ProviderRegistry
from app.runtime.providers.ollama import OllamaProvider
from app.runtime.tools.base import ToolRegistry

agents = AgentRegistry.from_directory("agents")
memory = NullMemory()

runtime = AgentRuntime(
    providers=ProviderRegistry({"ollama": OllamaProvider()}),
    tools=ToolRegistry.discover(),
    prompt_manager=PromptManager(),
    context_builder=DefaultContextBuilder(memory),
    memory=memory,
    events=LoggingEventPublisher(),
    permissions=PermissionManager(),
)

result = await runtime.run(agents.get("backend-engineer"), "Implement the endpoint")
```

Example agent definitions live in `services/ai-engine/agents/`.

## Logging

Structured logging only (structlog). Every execution logs execution id,
agent id, duration, model, token usage (when the provider reports it), tool
invocation count, and errors. `LoggingEventPublisher` additionally emits every
event as a structured log line; `InMemoryEventPublisher` fans events out to
subscribers (future dashboards).
