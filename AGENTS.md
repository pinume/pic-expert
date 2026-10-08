# AGENTS.md

Priority: Explicit user requests > Project rules/repository instructions > Existing behavior and architecture > This specification.

## Principles

- **Reuse first**: Use existing modules and dependencies first. Check the standard library before you add new dependencies.
- **Deletion over compatibility**: Delete old implementations directly during internal and private interface refactoring. Do not keep shims, dual-read/dual-write paths, or legacy branches. Evaluate migration paths only for real external contracts (public APIs, persistent data formats, cross-team interfaces).

## Workflow

Lightweight tasks (documentation, comments, typos, formatting only; no runtime behavior change): Verify the diff and complete. You can skip the steps below.

1. **Analysis**: Analyze requirements, current state, dependencies, runtime versions, constraints, and risks.
2. **Design**: Use `andrej-karpathy-skills:karpathy-guidelines` to define the minimal plan and verifiable success criteria.
3. **Pre-implementation review**: Review the plan with `ponytail:ponytail` before you write code.
4. **Implementation**: Follow the plan strictly. Do not expand the scope.
5. **Build and verification**:
   - **Prefer E2E verification**: Use real entry points and real data flows. Assert that final results and side effects are completely correct.
   - **Reject useless unit tests**: Do not write unit tests for coverage metrics. Add isolated tests only when you cannot reasonably verify critical behaviors through E2E tests.
   - **Bug fix sequence**: Reproduce bugs through real entry points before you change code. When you cannot reproduce bugs reliably, record symptoms, evidence, and expected behavior. Verify fixes in the scenario closest to reality.
   - **Risk checks**: Check boundary values, invalid inputs, I/O and dependency failures, data consistency, repeated execution, and recovery capabilities.
6. **Code review**: Review the final diff with `ponytail:ponytail-review`. Run `ponytail:ponytail-audit` when you need a repository-wide scan.
7. **Closed loop**: Fix, build, verify, and review until you meet all criteria or find an explicit blocker.

## Completion Criteria

Meet all applicable items:

1. Changes match the requirements. No unrelated modifications exist.
2. The project builds and runs normally. All existing valid tests continue to pass.
3. Verification via real entry points and high-risk scenarios passes. Business results are correct (do not only verify process survival or zero exit codes).
4. You completed final code reviews. You resolved all issues and re-verified as needed.
5. Base all conclusions on real execution evidence, not assumptions.

## Reporting

Provide a brief summary upon completion:

1. What you changed;
2. Actual build, test, verification, and review steps you executed, with results (specify skill name or manual inspection);
3. Unresolved issues, limitations, or skipped verification steps (write "None" if there are none).

Writing style follows ASD-STE100 (approx. 80%): Use short sentences. One topic per sentence. Use active voice. Keep terminology consistent. Do not use ambiguous words. Use numbered lists for procedural steps, with one action per step.

## Agent skills

### Issue tracker

Track issues and specs in GitHub Issues for `pinume/pic-expert`.
Before tracker operations, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels.
Before triage, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout: root `CONTEXT.md` and `docs/adr/`.
Before codebase exploration, read `docs/agents/domain.md`.
