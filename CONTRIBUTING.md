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

Main accepts only commits that already passed the `ci-ok` check.

1. Branch from main as `internal/<topic>` and push it. CI runs on the push.
2. When `ci-ok` is green on that commit, run
   `git push origin <sha>:main` to fast-forward main to it.
3. If main moved meanwhile, rebase or merge main, push the branch again,
   and wait for `ci-ok` again.

Release tags are not affected: push `<platform>/vX.Y.Z` on a commit that is
already on main, as described in [RELEASING.md](RELEASING.md).
