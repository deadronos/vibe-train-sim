# Releasing

A release is a version bump merged to `main`, a tag on that commit, and a GitHub Release once the site is live. Pushing the tag is what deploys, so only do it when someone has asked for a release.

## Choosing a version

Versions follow `MAJOR.MINOR.PATCH`, and tags add a `v` prefix, such as `v0.2.0`. While the project is below 1.0:

- Use a minor bump for new features or anything that changes how the game plays.
- Use a patch bump for fixes.

## Steps

The examples release `0.2.0`.

1. Bump the version on a branch and open a pull request. This updates `package.json` and `package-lock.json` without creating a tag:

   ```bash
   git switch -c release/v0.2.0
   npm version 0.2.0 --no-git-tag-version
   ```

2. Merge the pull request once CI passes.

3. Tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag v0.2.0 && git push origin v0.2.0
   ```

4. Wait for the [Deploy to Pages](../../.github/workflows/deploy-pages.yml) run to pass, then check that the [live site](https://deadronos.github.io/vibe-train-sim/) loads and trains run:

   ```bash
   gh run list --event push --limit 1
   gh run watch <run-id> --exit-status
   ```

5. Publish the GitHub Release, which is the record that this version went live:

   ```bash
   gh release create v0.2.0 --verify-tag --generate-notes
   ```

## When something goes wrong

- **The check fails on the tag:** nothing was deployed. Fix it in a new pull request and release the next patch version.
- **The deploy job fails but the check passed:** re-run the failed job. If it's rejected, check that the `github-pages` environment allows `v*` tags.
- **A bad version went live:** run the workflow from the Actions tab on the previous good tag to put that version back, then fix forward with a new patch version.

Don't move or reuse a published tag. Each version number should only ever mean one commit.
