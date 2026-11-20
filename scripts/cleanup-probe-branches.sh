# Delete the branches left behind by probes and a failed PR open.
# The proxy Claude runs behind refuses branch deletion, by API and by git.
gh api -X DELETE repos/bsf-fixtures/ts-webapp/git/refs/heads/probe-branch
gh api -X DELETE repos/bsf-fixtures/ts-webapp/git/refs/heads/factory/probe-policy
gh api -X DELETE repos/bsf-fixtures/ts-webapp/git/refs/heads/factory/probe-clean
gh api -X DELETE repos/bsf-fixtures/ts-webapp/git/refs/heads/factory/probe-testedit
gh api -X DELETE repos/bsf-fixtures/ts-webapp/git/refs/heads/factory/corrections-champphil-2026-11-20-8fc06a
gh api -X DELETE repos/ChampPhil/build-software-factory/git/refs/heads/probe/write-test
gh api -X DELETE repos/ChampPhil/build-software-factory/git/refs/heads/factory/spike-gh-aw
gh api -X DELETE repos/ChampPhil/build-software-factory/git/refs/heads/factory/v0.1-core

# Leaves open: bsf-fixtures/ts-webapp#4, the contribution PR, and its branch
# factory/corrections-champphil-2026-11-20-ba79fc — that one is real evidence
# for `bsf contribute-corrections` and is worth looking at before closing.
