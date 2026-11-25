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
 * So the hero is the product itself: the briefing as it looks on a morning
 * with work waiting, in the same classes the real one uses.
 */

import { BrandCredit } from "@/components/brand-credit";
import { Check, Mark } from "@/components/ui";

const SETUP = "https://github.com/ChampPhil/build-software-factory";

export function Landing({ onSignIn, onDemo }: { onSignIn: () => void; onDemo: () => void }) {
  return (
    <div className="landing">
      <header className="top">
        <div className="top-in">
          <span className="brand">
            <Mark />
            Software Factory
          </span>
          <span className="gap" />
          <a className="btn quiet" href={SETUP}>
            Source
          </a>
          <button className="btn" type="button" onClick={onSignIn}>
            Sign in
          </button>
        </div>
      </header>

      <main className="wrap">
        <section className="lede">
          <h1>File an issue. Wake up to a pull request with a video of it working.</h1>
          <p className="rest">
            An agent that lives in your repository. It reads a request, asks you what it needs to know, writes the
            change, proves it runs, and opens a pull request you merge. It runs in your own GitHub Actions, on your own
            API key, under a monthly cap you set.
          </p>
          <div className="acts">
            <a className="btn go" href={SETUP}>
              Set it up
            </a>
            <button className="btn" type="button" onClick={onDemo}>
              Look around with a demo
            </button>
            <button className="btn quiet" type="button" onClick={onSignIn}>
              I already have one
            </button>
          </div>
        </section>

        <section className="showcase" aria-label="A morning with the factory">
          <p className="when">Wednesday, 8:40&#8239;am. You were last here at 11:10 last night.</p>
          <h2 className="show-h">Two things need you.</h2>
          <div className="cols">
            <div className="main-col needs">
              <article className="item ask">
                <div className="where">
                  <span className="tag you">Your answer moves this on</span>
                  <span>#42</span>
                  <span>asked before writing any code</span>
                </div>
                <h3>Let customers filter order history by date</h3>
                <p className="voice">Should a refund show under the date it happened, or under the date of the order it refunds?</p>
              </article>
              <article className="item proof">
                <div className="head">
                  <div className="where">
                    <span className="tag">Ready to merge</span>
                    <span>PR #59 for #45</span>
                  </div>
                  <h3>Export invoices to CSV</h3>
                </div>
                <div className="body">
                  <ul className="summary">
                    <li>Adds Export to CSV to the invoice list. Each amount stays in the customer&rsquo;s currency.</li>
                    <li>A new column carries the exchange rate on the invoice date, so totals reconcile.</li>
                    <li>A recording shows March&rsquo;s 212 invoices exporting and opening in a spreadsheet.</li>
                  </ul>
                  <div className="facts">
                    <span><Check /> Both gates passed</span>
                    <span><b>$2.48</b> to build</span>
                    <span>31 min start to finish</span>
                  </div>
                </div>
              </article>
            </div>
            <aside className="rail" aria-label="What else">
              <section>
                <h3 className="part">Landed overnight</h3>
                <ul className="mini-list">
                  <li>Show the order total on the receipt<span>Merged by you, $1.94</span></li>
                  <li>Split the 600-line checkout component<span>Merged itself, $0.47</span></li>
                </ul>
              </section>
              <section>
                <h3 className="part">This month</h3>
                <p className="muted"><b>$21.40</b> of a $35 budget. 84% of merges needed no edits.</p>
              </section>
            </aside>
          </div>
        </section>

        <section className="points" aria-labelledby="what-h">
          <h2 className="sect" id="what-h">What it actually does</h2>
          <div className="three">
            <div>
              <h3>Talks to you first</h3>
              <p>
                Most requests are a sentence, and the gap between what you wrote and what you meant is where wasted
                work comes from. It asks one question at a time until it can say your request back to you, then starts.
              </p>
            </div>
            <div>
              <h3>Proves it works</h3>
              <p>
                Every pull request carries evidence: what changed, the checks that ran, and a recording of it working in
                a sandbox. If the app did not render, it says so instead of attaching a picture of a blank page.
              </p>
            </div>
            <div>
              <h3>Learns from your corrections</h3>
              <p>
                Say what was wrong in a review and it turns that into a rule the codebase enforces, so the same mistake
                cannot come back. No prompt to update, no instructions to maintain.
              </p>
            </div>
          </div>
        </section>

        <section className="two plain">
          <div>
            <h2 className="sect">What it costs</h2>
            <p>
              Your own Anthropic API key, with a spend limit you set in their console, plus your repository&rsquo;s
              GitHub Actions minutes. The factory enforces a monthly cap of its own on top and stops when it hits it.
              There is nothing to pay for here: it is open source, Apache 2.0, and runs entirely in your account.
            </p>
          </div>
          <div>
            <h2 className="sect">What it does not do</h2>
            <p>
              It does not merge product work by itself unless you turn that on. It cannot edit its own workflows or the
              checks that judge it. And it is not magic on a large unfamiliar codebase: it is at its best on a
              repository that already has tests, and it tells you plainly what it could not verify.
            </p>
          </div>
        </section>

        <section className="setup">
          <h2 className="sect">Setting it up</h2>
          <p>
            Install the skill in whichever coding agent you use, open your repository, and tell it to set up the
            software factory. It takes you through the rest: a GitHub App, a key, and a couple of questions about what
            you are building.
          </p>
          <div className="acts">
            <a className="btn go" href={SETUP}>
              Read the setup guide
            </a>
          </div>
        </section>
      </main>
      <footer className="foot">
        <BrandCredit />
      </footer>
    </div>
  );
}
