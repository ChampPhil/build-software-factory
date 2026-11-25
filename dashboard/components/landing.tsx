"use client";

/**
 * The page a stranger lands on.
 *
 * Its job is to make somebody want this, honestly. So it leads with the four
 * things no other coding agent does together, each shown rather than claimed:
 * it works the night shift, it proves its work with recordings, it turns your
 * corrections into checks that cannot be argued with, and it keeps adding them.
 * Every visual is drawn from the same records the dashboard reads, in the
 * dashboard's own type, so what someone is sold is what they get.
 */

import { useEffect, useState } from "react";
import { BrandCredit } from "@/components/brand-credit";
import { Check, Mark, PlayIcon } from "@/components/ui";

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

      <main>
        <section className="lp-hero wrap">
          <div className="lp-pitch">
            <h1>Set up your automated software factory.</h1>
            <p className="lp-sub">
              File an issue tonight. Wake up to a pull request that&rsquo;s been built, checked, and recorded working. Every
              correction you make becomes a check it can never fail again.
            </p>
            <div className="acts">
              <a className="btn go big" href={SETUP}>
                Set it up
              </a>
              <button className="btn big" type="button" onClick={onDemo}>
                Look around with a demo
              </button>
              <button className="btn quiet" type="button" onClick={onSignIn}>
                I already have one
              </button>
            </div>
            <p className="lp-small">Open source. Runs in your own GitHub Actions, on your own API key, under a monthly cap you set.</p>
          </div>
          <NightShift />
        </section>

        <section className="lp-feature wrap" aria-labelledby="f-proof">
          <div className="lp-copy">
            <h2 id="f-proof">It proves its work.</h2>
            <p>
              Before you see a pull request, an agent drives your app in a sandbox and records what happens: the click, the
              page that loads, the file that downloads. You review a forty-second video, not four hundred lines of diff.
            </p>
            <p>If the app didn&rsquo;t render, it says so. It never hands you a screenshot of a blank page and calls it done.</p>
          </div>
          <ProofReel />
        </section>

        <section className="lp-feature flip wrap" aria-labelledby="f-learn">
          <div className="lp-copy">
            <h2 id="f-learn">Correct it once. It&rsquo;s a rule forever.</h2>
            <p>
              Every review comment, change request and fix you push is read as a correction. When the same kind comes up
              again, the factory turns it into a deterministic check: a lint rule, a test it must pass, a property it must
              hold.
            </p>
            <p>Not a line in a prompt it might forget. A check that fails the build.</p>
          </div>
          <Correction />
        </section>

        <section className="lp-feature wrap" aria-labelledby="f-grow">
          <div className="lp-copy">
            <h2 id="f-grow">It gets stricter every week.</h2>
            <p>
              Every few days it grades its own recent work, finds what it keeps getting wrong, and adds the guardrail that
              would have caught it. Static checks, written practices, runtime verification, formal specifications.
            </p>
            <p>Guardrails only ever go one way. Loosening one takes a person.</p>
          </div>
          <Ratchet />
        </section>

        <section className="lp-band">
          <div className="wrap lp-three">
            <div>
              <h3>It asks before it builds</h3>
              <p>One question at a time, until it can say back what you meant, in the words a specialist would use for it.</p>
            </div>
            <div>
              <h3>It costs what you allow</h3>
              <p>Your Anthropic key and your Actions minutes, under a monthly cap the factory enforces itself. Nothing to pay us.</p>
            </div>
            <div>
              <h3>It can&rsquo;t grade its own homework</h3>
              <p>It can&rsquo;t edit its workflows or the checks that judge it, and product work waits for you to merge it.</p>
            </div>
          </div>
        </section>

        <section className="lp-end wrap">
          <h2>Tonight, file an issue.</h2>
          <p>
            Install the skill in your coding agent, open your repository and ask it to set up the software factory. It walks
            you through the rest in about ten minutes.
          </p>
          <div className="acts">
            <a className="btn go big" href={SETUP}>
              Set it up
            </a>
            <a className="btn big" href={`${SETUP}#readme`}>
              Read how it works
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

/* ------------------------------------------------------------------ the night shift */

const NIGHT: readonly { t: string; what: string; voice?: boolean; done?: boolean }[] = [
  { t: "11:42 pm", what: "You filed #45: Export invoices to CSV." },
  { t: "11:43 pm", what: "Keep each amount in the customer's currency, or convert everything to dollars?", voice: true },
  { t: "11:47 pm", what: "You answered, and went to bed." },
  { t: "12:06 am", what: "Wrote the spec. Building, try 1 of 3." },
  { t: "12:38 am", what: "Types, lint and 14 guardrails pass.", done: true },
  { t: "1:04 am", what: "Drove the app in a sandbox. Recorded 42 seconds.", done: true },
  { t: "1:09 am", what: "Verification passed. Pull request #59 opened.", done: true },
];

/**
 * The hero's one moment of motion: a night played back in a few seconds, from
 * the issue to the pull request waiting at breakfast. It plays once, and not
 * at all for someone who has asked for less motion.
 */
function NightShift() {
  const [shown, setShown] = useState(NIGHT.length + 1);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setShown(0);
    let n = 0;
    const id = window.setInterval(() => {
      n += 1;
      setShown(n);
      if (n > NIGHT.length) window.clearInterval(id);
    }, 650);
    return () => window.clearInterval(id);
  }, []);
  const morning = shown > NIGHT.length;
  return (
    <figure className="lp-night" aria-label="One night with the factory, from the issue to the pull request">
      <div className="lp-sky" aria-hidden="true">
        <span className={morning ? "lp-clock am" : "lp-clock"}>{morning ? "7:00 am" : (NIGHT[Math.max(0, shown - 1)]?.t ?? "11:42 pm")}</span>
        <span className="lp-while">{morning ? "Good morning." : "While you sleep"}</span>
      </div>
      <ol className="lp-log">
        {NIGHT.map((e, i) => (
          <li key={e.t} className={i < shown ? "on" : ""}>
            <time>{e.t}</time>
            <span className={e.voice === true ? "v" : ""}>
              {e.done === true && <Check />}
              {e.what}
            </span>
          </li>
        ))}
      </ol>
      <div className={morning ? "lp-ready on" : "lp-ready"}>
        <div className="lp-thumb" aria-hidden="true">
          <span className="disc">
            <PlayIcon />
          </span>
        </div>
        <div>
          <b>Ready to merge: Export invoices to CSV</b>
          <span>PR #59, a 0:42 recording, both gates passed, $2.48</span>
        </div>
      </div>
    </figure>
  );
}

/* ------------------------------------------------------------------ proof */

/** A recording of a change working, drawn in the app's own shapes, with the stills the verifier kept. */
function ProofReel() {
  const rows = [
    ["INV-2031", "Halden & Co", "€1,240.00", "EUR"],
    ["INV-2032", "Moreno Studio", "$860.00", "USD"],
    ["INV-2033", "Okafor Design", "£2,115.50", "GBP"],
    ["INV-2034", "Lindqvist AB", "kr 9,800", "SEK"],
  ];
  return (
    <figure className="lp-proof">
      <div className="lp-screen">
        <div className="lp-browser" aria-hidden="true">
          <i />
          <i />
          <i />
          <span>ledgerline.test/invoices?month=2026-03</span>
        </div>
        <div className="lp-app" aria-hidden="true">
          <div className="lp-app-head">
            <b>Invoices, March</b>
            <span className="lp-export">
              Export to CSV
              <span className="lp-cursor" />
            </span>
          </div>
          {rows.map((r) => (
            <div className="lp-row" key={r[0]}>
              {r.map((c, i) => (
                <span key={i}>{c}</span>
              ))}
            </div>
          ))}
          <div className="lp-toast">invoices-2026-03.csv downloaded, 212 rows</div>
        </div>
        <div className="lp-bar" aria-hidden="true">
          <span>0:31</span>
          <span className="track">
            <i />
          </span>
          <span>0:42</span>
        </div>
      </div>
      <figcaption>
        <span>The recording on pull request #59: March&rsquo;s invoices, four currencies, exported and opened.</span>
        <span className="lp-stills">
          <span>
            <Check /> The button appears
          </span>
          <span>
            <Check /> 212 rows, amounts unconverted
          </span>
          <span>
            <Check /> Opens in a spreadsheet
          </span>
        </span>
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ corrections */

/** One correction, followed from a review comment to the rule that now enforces it. */
function Correction() {
  return (
    <figure className="lp-learn" aria-label="A review comment becoming a lint rule">
      <div className="lp-said">
        <span className="who">You, reviewing #48</span>
        <p>&ldquo;This rounds down here but up on the receipt.&rdquo;</p>
      </div>
      <div className="lp-seen">
        <span>Seen again on #52 and #55</span>
        <b>3 times. That&rsquo;s a pattern.</b>
      </div>
      <pre className="lp-rule">
        <span className="c">{"// added by the factory, approved by you"}</span>
        {"\n"}
        <b>money/no-raw-rounding</b>
        {"\n\n"}
        <span className="x">{"✗ src/cart/total.ts:14"}</span>
        {"\n  Math.round(price * 100) / 100\n  Round money only through formatMoney()."}
      </pre>
      <div className="lp-since">
        <b>11</b>
        <span>times it has stopped a change since. Not once has it reached you.</span>
      </div>
    </figure>
  );
}

/* ------------------------------------------------------------------ the ratchet */

const WEEKS: readonly (readonly [number, number, number, number])[] = [
  [6, 1, 2, 0],
  [8, 2, 2, 0],
  [9, 3, 3, 0],
  [11, 3, 4, 1],
  [13, 4, 5, 1],
  [14, 5, 7, 1],
  [17, 6, 8, 2],
  [19, 7, 9, 2],
];
const LAYERS = ["Static checks", "Written practices", "Runtime verification", "Formal specs"] as const;

/** Guardrails over eight weeks, stacked by kind. A line that only climbs. */
function Ratchet() {
  const W = 560;
  const H = 260;
  const max = 40;
  const x = (i: number): number => (i / (WEEKS.length - 1)) * W;
  const y = (v: number): number => H - (v / max) * H;
  const tops = WEEKS.map((w) => w.reduce<number[]>((acc, v) => [...acc, (acc[acc.length - 1] ?? 0) + v], []));
  const area = (k: number): string => {
    const upper = tops.map((t, i) => `${x(i).toFixed(1)},${y(t[k]!).toFixed(1)}`);
    const lower = tops.map((t, i) => `${x(i).toFixed(1)},${y(k === 0 ? 0 : t[k - 1]!).toFixed(1)}`).reverse();
    return [...upper, ...lower].join(" ");
  };
  const total = tops[tops.length - 1]![3]!;
  return (
    <figure className="lp-ratchet">
      <div className="lp-total">
        <b>{total}</b>
        <span>guardrails, up from 9 in week one</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 28}`} role="img" aria-label={`Guardrails grew from 9 to ${total} over eight weeks`}>
        {[0, 1, 2, 3].map((k) => (
          <polygon key={k} className={`l${k}`} points={area(k)} />
        ))}
        {WEEKS.map((_, i) => (
          <text key={i} x={x(i)} y={H + 20} textAnchor={i === 0 ? "start" : i === WEEKS.length - 1 ? "end" : "middle"}>
            {i === 0 ? "Week 1" : i === WEEKS.length - 1 ? "Week 8" : ""}
          </text>
        ))}
      </svg>
      <ul className="lp-key">
        {LAYERS.map((l, k) => (
          <li key={l}>
            <i className={`l${k}`} />
            {l}
            <b>{WEEKS[WEEKS.length - 1]![k]}</b>
          </li>
        ))}
      </ul>
    </figure>
  );
}
