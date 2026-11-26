# The Dependabot entry for runner upgrades

Add this under `updates:` in `.github/dependabot.yml`, as the last entry, replacing
`OWNER/REPO` with the factory's repository (`ChampPhil/build-software-factory`):

```yaml
  - package-ecosystem: github-actions
    directory: /
    allow:
      - dependency-name: "OWNER/REPO*"
    schedule:
      interval: daily
    cooldown:
      default-days: 3
    labels:
      - factory-runner-upgrade
    commit-message:
      prefix: "Upgrade the factory runner"
```

It watches only the runner pin in `.github/workflows/factory-runner-pin.yml`.
