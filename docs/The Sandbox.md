# The Sandbox

A sandbox is an isolated place where the app runs the same way every time. Agents build, test, and verify inside it. A compromised agent cannot reach a laptop or a secret from there. Agents hold no write token. They can reach the model API, package registries, and the app's own stand-in services. Their changes leave only as checked safe outputs.

Two properties follow:

- **The same app every time.** Setup reuses the repository's devcontainer, Dockerfile, or setup script, and describes the result as a `devcontainer.json`. When the repository has none, setup generates one from the language, the install, and the services the app needs.
- **Proof it actually started.** The setup job brings that sandbox up on a GitHub runner, runs the commands, starts the app, and screenshots it. Secrets the app needs in order to run are stored as repository secrets and read as environment variables.

The posture is chosen per repository. Agents run in gh-aw's sandbox on the default Docker profile. A repository whose app needs an Actions service container, such as a database, needs `sandbox.agent.runtime: docker-sudo-iptables`, which runs with host privileges. Setup detects that, says so, and prefers starting the dependency inside the agent's network where that works. The posture is a literal written at compile time. Changing it later is a recompile.

How setup builds the sandbox, phase by phase, is [Setup](Setup.md).
