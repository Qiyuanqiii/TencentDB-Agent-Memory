# Recall History Compaction

Related issue: https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/120

This is a narrow follow-up on top of #375 for injected memory history that
already survived into session messages. It is not the primary runtime
prompt-cache fix for #120.

#375 owns the default-safe runtime behavior: `recall.injectionMode`,
`recall.showInjected`, and stripping newly injected recall before persistence.
This follow-up only handles historical replay/migration cases where older
sessions or legacy host paths already contain `<relevant-memories>`.

## Scope

Dynamic L1 recall is injected as:

```xml
<relevant-memories>
...
</relevant-memories>
```

That block is useful for the active turn. If it is later persisted or replayed
from history, the full recalled payload becomes stale context. This change
compacts only that historical payload into a stable marker:

```xml
<memory-omitted reason="prevent_context_bloat" />
```

The marker keeps an audit trail that memory injection happened, while removing
the turn-specific recalled content from future history.

## Non-goals

- Do not change the default recall injection mode.
- Do not dedupe or reorder system messages.
- Do not make provider-specific cache-hit claims.
- Do not replace #375's runtime-side prompt-cache fix.
- Do not change #375's `before_message_write` stripping behavior.

## Where It Runs

`before_prompt_build`

Existing history is compacted as a migration/safety pass before the prompt is
built. This catches older sessions or host paths where injected memory already
reached `event.messages` before #375's default-safe persistence behavior was in
place.

## Validation

Run:

```bash
npm test -- src/utils/memory-injection-cache.test.ts
npm test
npm run build
git diff --check
```
