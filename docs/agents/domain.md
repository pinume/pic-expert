# Domain docs

## Before codebase exploration

Read root `CONTEXT.md` and relevant ADRs in `docs/adr/`, when present.
If absent, proceed silently.

The domain-modeling skill creates these documents when domain terms
or architectural decisions are resolved.

## Layout

This repository uses a single-context layout:

- `CONTEXT.md`: domain terminology.
- `docs/adr/`: architectural decision records.

## Vocabulary

Use terms defined in `CONTEXT.md` in issues, proposals, and tests.
When a required term is missing, assess whether it belongs in the
domain vocabulary. Record real gaps for domain-modeling.

## ADR conflicts

State explicitly when a proposal conflicts with an existing ADR.
Identify the ADR and explain why the decision should be reconsidered.
