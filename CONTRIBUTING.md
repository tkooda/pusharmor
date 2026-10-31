# Contributing

Issues and pull requests are welcome.

- Bugs and feature ideas: open a GitHub issue and fill in the template.
- Security problems: do not open an issue. Use private vulnerability
  reporting, see [SECURITY.md](SECURITY.md).

## Pull requests

- Keep each pull request small and about one topic.
- Describe what changed and why.
- Match the style of the code around your change.
- Run the tests of the part you changed before you push (see "Build from
  source" in [README.md](README.md)). CI must pass.
- Use plain ASCII (characters 0 to 127) in code, comments, and docs.
- Never add secrets, personal data, or test-only hooks to release builds.

By contributing you agree that your work is released under the MIT license
in [LICENSE](LICENSE).

## Landing changes on main

Main accepts only pull requests that pass the `ci-ok` check. Direct pushes
are blocked, and only squash merges are allowed.

1. Branch from main as `agent/<topic>` (or any short topic name).
2. Push the branch and run `gh pr create`.
3. Run `gh pr merge --auto --squash`. GitHub merges the pull request once
   `ci-ok` is green and deletes the branch.

Release tags are not affected: push `<platform>/vX.Y.Z` on a commit that is
already on main, as described in [RELEASING.md](RELEASING.md).
