"use client";

/**
 * What someone sees when a friend sends them the link.
 *
 * Nobody arrives here cold by choice. There are two audiences and they want
 * opposite things: a person whose setup just handed them a link wants the
 * sign-in and nothing else, and a person who was told "you should look at
 * this" wants to know what it is before they give anything write access to
 * their repository. The repo in the link tells the two apart — no guessing
 * about where somebody came from.
 *
 * This is the second audience. The job is not to impress them; it is to let
 * them decide, quickly and accurately, whether to hand an agent commit rights.
 * That means being specific about what it does, honest about what it costs,
 * and plain about what it does not do — a page that oversells this gets
 * someone to install it and then lose a weekend.
 */

import { BrandCredit } from "@/components/brand-credit";

export function Landing({ onSignIn, onDemo }: { onSignIn: () => void; onDemo: () => void }) {
  return (
    <div className="landing">
      <header className="landing-top">
        <b>Software Factory</b>
        <button className="btn" onClick={onSignIn}>
          Sign in
        </button>
      </header>

      <section className="hero">
        <h1>File an issue. Wake up to a pull request with a video of it working.</h1>
        <p className="hero-sub">
          An agent that lives in your repository: it reads a request, asks you what it needs to know, writes the
          change, proves it runs, and opens a pull request you merge. It runs in your own GitHub Actions, on your own
          API key, under a monthly cap you set.
        </p>
        <div className="hero-actions">
          <a className="btn filled" href="https://github.com/ChampPhil/build-software-factory">
            Set it up
          </a>
          <button className="btn" onClick={onDemo}>
            Look around with a demo
          </button>
          <button className="btn" onClick={onSignIn}>
            I already have one
          </button>
        </div>
      </section>

      {/* The hero is the thing itself: what actually lands on a repository,
          in the same visual language the dashboard uses, rather than an
          illustration of it. */}
      <section className="demo" aria-label="What a request turns into">
        <div className="demo-col">
          <div className="demo-label">What you write</div>
          <div className="rows">
            <div className="row needs" style={{ gridTemplateColumns: "1fr" }}>
              <span className="row-title">Invoices should be filterable by status</span>
              <span className="row-meta">
                <span>issue #42</span>
                <span>you, 11:40pm</span>
              </span>
            </div>
          </div>
          <div className="demo-label demo-label-mid">What it asks</div>
          <div className="rows">
            <div className="row" style={{ gridTemplateColumns: "1fr" }}>
              <span className="row-title">Should the filter apply to refunds too, or only to orders?</span>
              <span className="row-meta">
                <span>asked before writing any code</span>
              </span>
            </div>
          </div>
        </div>

        <div className="demo-col">
          <div className="demo-label">What you wake up to</div>
          <div className="rows">
            <div className="row" style={{ gridTemplateColumns: "auto 1fr" }}>
              <span className="dot pass" />
              <span className="row-title">Filter invoices by status</span>
            </div>
            <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span className="row-meta">
                <span>4 files changed</span>
                <span>tests pass</span>
              </span>
              <span className="tag">product work</span>
            </div>
            <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span className="row-meta">
                <span>a recording of the filter working</span>
              </span>
              <span className="row-num">$0.41</span>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-section">
        <h2>What it actually does</h2>
        <div className="landing-points">
          <div>
            <h3>Talks to you first</h3>
            <p>
              Most requests are a sentence, and the gap between what you wrote and what you meant is where wasted work
              comes from. It asks one question at a time until it can say your request back to you without filling
              anything in — then it starts.
            </p>
          </div>
          <div>
            <h3>Proves it works</h3>
            <p>
              Every pull request carries evidence: what changed, the checks that ran, and a recording of the thing
              actually working in a sandbox. If the app did not render, it says so instead of attaching a screenshot of
              a blank page.
            </p>
          </div>
          <div>
            <h3>Learns from your corrections</h3>
            <p>
              Review a change and say what was wrong, and it turns that into a rule the codebase enforces, so the same
              mistake cannot come back. No prompt to update, no instructions to maintain.
            </p>
          </div>
        </div>
      </section>

      <section className="landing-section">
        <h2>What it costs</h2>
        <p className="landing-prose">
          Your own Anthropic API key, with a spend limit you set in their console, plus your repository&rsquo;s GitHub
          Actions minutes. The factory enforces a monthly cap of its own on top and stops when it hits it. There is
          nothing to pay for here — this is open source, Apache 2.0, and runs entirely in your account.
        </p>
      </section>

      <section className="landing-section">
        <h2>What it does not do</h2>
        <p className="landing-prose">
          It does not merge its own work: every change is a pull request a person reads and merges. It does not touch
          the files you tell it not to. It cannot edit its own workflows or the checks that judge it. And it is not
          magic on a large unfamiliar codebase — it is at its best on a repository that already has tests, and it will
          tell you honestly what it could not verify.
        </p>
      </section>

      <section className="landing-section landing-install">
        <h2>Setting it up</h2>
        <p className="landing-prose">
          Install the skill in whichever coding agent you use, open your repository, and tell it to set up the software
          factory. It takes you through the rest — a GitHub App, a key, and a couple of questions about what you are
          building. Nothing here needs to be configured by hand.
        </p>
        <a className="btn filled" href="https://github.com/ChampPhil/build-software-factory">
          Read the setup guide
        </a>
      </section>

      <footer className="landing-foot">
        <BrandCredit />
      </footer>
    </div>
  );
}
