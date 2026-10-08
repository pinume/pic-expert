# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `pinume/pic-expert`.
Use the `gh` CLI from this repository.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body-file <file>`
- Add labels: `gh issue edit <number> --add-label "..."`
- Remove labels: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Write multiline bodies to a temporary file. Pass it with `--body-file`.
Infer the repository from the Git remote.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill instructions

When a skill says "publish to the issue tracker", create a GitHub issue.
When a skill says "fetch the relevant ticket", read the issue and its comments.

## Wayfinding

Use one issue labelled `wayfinder:map` for the map.
Use child issues labelled `wayfinder:<type>`, where type is
`research`, `prototype`, `grilling`, or `task`.

Link children with GitHub sub-issues. If unavailable, use a task list
in the map and put `Part of #<map>` in each child.

Use native issue dependencies for blockers. Dependency API calls
require the blocker's database ID, not its issue number.
If unavailable, put `Blocked by: #<number>` in the child.

Select the first open child in map order with no open blockers
and no assignee. Claim it with `gh issue edit <number> --add-assignee @me`.

On resolution, comment with the answer, close the child,
and add a concise decision and link to the map.
