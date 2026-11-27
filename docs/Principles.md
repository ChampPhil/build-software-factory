# Principles

Every part of the factory exists to enforce these principles. What a software factory is, and what this one does, is the subject of the README.

## Principles the factory enshrines

- **The codebase is the largest input coding agents get.**
  - Agents copy the patterns they see → the code must be kept pristine, so they copy good patterns and don't carry tech debt.
  - Large refactors to make code pristine are now cheap with agents.
- **Nuance breeds slop.**
  - Avoid APIs and code patterns that need nuance to use correctly.
  - Design APIs and interfaces that remove nuance, and ban the specific patterns that introduce it.
- **Treat the code as a well-maintained garden.**
  - The continuous stream of code coming in must be good code.
  - The deterministic checks are the guardrails of the garden: the concrete foundation the code grows on.
- **Categorically eliminate problems.**
  - When correcting agent work, prefer a code-based check over updating prose: a small refactor, or a static rule like a linter or dependency graph analyzer.
  - Always ask: *"How can I eliminate this problem for the entire codebase?"*
- **No unrequested markdown from agents.**
  - Stray docs lead agents to justify wrong patterns to other agents.
- **The directory tree is context.**
  - How the filesystem is structured shapes how agents interact with the codebase.
  - One folder per feature, plus deterministic checks that block bad imports between folders.
- **Verification is what builds trust.**
  - Human "code review" shifts to reviewing verification artifacts: screenshots, diagrams, videos.
  - Runtime verification is required; formal verification is used where it's needed.
- **Open, adaptable and defined in code.**
  - *Open* → built from open tools (gh-aw, memex, Semgrep, Playwright), with no hosted service. Its agents run on Claude Code, the one harness whose spend its budget is proven to stop.
  - *Adaptable* → works with the infrastructure, tools and conventions the team already has.
  - *Defined in code* → a strict, version-controlled definition of the factory, including its skills and workflows.
- **Every agent and human trace is recorded and used for improvement.**

## The core idea

**Existing code → build a collection of guardrails → fit the existing code to the guardrails → a pristine garden, where all future code is guaranteed to add to the garden.**

- Guardrails come from three sources:
  - The codebase's own best existing patterns.
  - Past corrections: the developers' past chats with AI coding agents (every time someone corrected an agent), review comments, reverts, fix commits, bug history, prose rules (AGENTS.md, contributing guides). The goal is to catch all of them.
  - Universal rules every codebase should have.
- Fitting the code happens *under* the guardrails → the garden never gets worse while it's being cleaned.
- Once the garden is pristine, the guardrails make sure every future change keeps it that way.
- The garden keeps getting stricter: every correction is recorded, and a correction that recurs (or that a human flags) becomes a new guardrail (hardening).
