# Contributing

Issues are welcome. This project does not take pull requests.

- Bugs and feature ideas: open a GitHub issue and fill in the template.
- Security problems: see [SECURITY.md](SECURITY.md).

## Landing changes on main

Main accepts only commits that already passed the `ci-ok` check. A release
only tags a commit of main; nothing is committed for it (RELEASING.md).

1. Branch from main as `internal/<topic>` and push it. CI runs on the push.
2. When `ci-ok` is green on that commit, run
   `git push origin <sha>:main` to fast-forward main to it.
3. If main moved meanwhile, rebase or merge main, push the branch again,
   and wait for `ci-ok` again.

Release tags are not affected: push `<platform>/vX.Y.Z` on a commit that is
already on main, as described in [RELEASING.md](RELEASING.md).
