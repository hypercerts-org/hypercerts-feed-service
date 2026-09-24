# Releasing

This repository uses Changesets to version the service and create GitHub Releases. The package is private and is never published to npm. Releases are not coupled to deployment.

## Contributors

Add a Changeset when a pull request affects application behavior, runtime configuration, the public contract, supported runtime versions, service deployment, or operator procedures. This includes changes to feed selection, filtering, pagination, hydration, request parameters, responses, and public errors:

```bash
npm run changeset
```

Commit the generated `.changeset/*.md` file with the pull request. Local development tools, tests, behavior-preserving internal refactors, documentation-only corrections, and repository or CI maintenance with no service or operator impact do not need a Changeset. CI does not infer semantic release impact; contributors and reviewers must apply this policy during review. When a pull request includes an added or modified fragment, CI runs `changeset status` to reject malformed release metadata before merge. `.changeset/README.md` is documentation, not a fragment.

## Maintainers

1. Merge a normal pull request into `main` after CI passes.
2. A push to `main` with pending Changesets creates or updates one pull request from `changeset-release/main` titled **Release**. That pull request updates `package.json`, `package-lock.json`, and `CHANGELOG.md`.
3. GitHub creates CI runs for the automation-owned Release pull request in an approval-required state. A maintainer with write access must select **Approve workflows to run** in the pull request merge box. Do not merge the Release pull request until its full CI run passes, including the disposable PostgreSQL integration tests.
4. Review and merge **Release**. The release workflow checks out the exact merge commit, installs dependencies without implicit lifecycle scripts, explicitly rebuilds required native dependencies, and reruns type-checking, unit tests, PostgreSQL integration tests, and the production build.
5. After validation, the workflow checks whether the derived tag and GitHub Release already both exist. It does nothing when both exist, fails when only one exists, and otherwise creates the tag and GitHub Release from the generated changelog. It does not publish to npm or deploy the service.
6. After the publish job succeeds, including when the tag and GitHub Release already exist, the workflow opens a `main` → `dev` synchronization pull request or reuses the existing open one. This carries consumed Changeset fragment deletions and the generated package version, lockfile, and changelog metadata back to `dev`. If `main` has no commits ahead of `dev`, such as after the synchronization pull request has already merged, the job succeeds without opening another pull request.
7. Approve the synchronization pull request's workflow run and wait for its full CI run to pass. Then review the pull request and merge it with a **merge commit**. Do not squash it; preserving the release commit ancestry keeps `dev` aligned with the release history on `main`. The workflow never pushes to or merges `dev` directly.

The repository setting **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** must be enabled so the Release workflow's version and synchronization jobs can create pull requests.

The workflow uses only the automatically provided `GITHUB_TOKEN`. Current GitHub behavior creates `pull_request` workflow runs for automation-created or updated pull requests in an approval-required state. Using an organization-owned GitHub App installation token later would allow those CI runs to begin without manual approval while preserving the same Release pull request flow.
