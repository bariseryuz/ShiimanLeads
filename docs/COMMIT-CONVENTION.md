# Commit message convention

We use a simple convention so history stays clear and consistent.

## Format

```
<type>: <short subject>

[optional body]
```

- **Subject:** One line, imperative mood, ~72 chars max.  
  Good: `Add digest job for lead alerts`  
  Avoid: `Added digest job` or `Adding digest job`

- **Body (optional):** Explain what changed and why. Separate from subject with a blank line.

## Types

| Type     | Use for |
|----------|--------|
| `feat`   | New feature |
| `fix`    | Bug fix |
| `docs`   | Documentation only |
| `style`  | Formatting, no code change |
| `refactor` | Code change that doesn’t fix a bug or add a feature |
| `test`   | Tests |
| `chore`  | Build, tooling, config, deps |

## Examples

```
feat: add Paddle billing and plan limit enforcement
fix: use source_name in stats and leadsBySource queries
docs: add SUPPORT.md and RESTORE.md
chore: move guides into docs/ and legal pages into frontend/legal/
```

## Using the template

From the repo root:

```bash
git config commit.template .gitmessage
```

After that, `git commit` (without `-m`) will open your editor with this template.
