"use client";

import Link from "next/link";
import { useState } from "react";
import { useApp } from "@/components/app";
import { useWaitingSettings, type WaitingSetting } from "@/lib/data";
import { sealEnv } from "@/lib/secret";

/**
 * The same screen the first setup uses, opened from the dashboard later.
 *
 * A new name in the code shows up here. The person uses it, fakes it, or
 * ignores it. Ignoring can be undone. The file and line are shown. Values
 * stay in the browser until they are sealed into the GitHub secret.
 */
export default function EnvScreen() {
  const app = useApp();
  const settings = useWaitingSettings(app.client, app.version);
  const rows = settings.state === "ready" ? (settings.data?.names ?? []) : [];
  const dynamic = settings.state === "ready" ? (settings.data?.dynamic ?? []) : [];
  const signIn = settings.state === "ready" ? (settings.data?.sign_in ?? []) : [];
  const [choice, setChoice] = useState<Record<string, "use" | "fake" | "ignore" | "undo">>({});
  const [note, setNote] = useState("");
  const [fileText, setFileText] = useState("");

  const pick = (name: string, value: "use" | "fake" | "ignore" | "undo") => {
    setChoice((current) => ({ ...current, [name]: value }));
  };

  const save = async () => {
    const use = Object.entries(choice).filter(([, v]) => v === "use").map(([k]) => k);
    const fake = Object.entries(choice).filter(([, v]) => v === "fake").map(([k]) => k);
    const ignore = Object.entries(choice).filter(([, v]) => v === "ignore").map(([k]) => k);
    const undo = Object.entries(choice).filter(([, v]) => v === "undo").map(([k]) => k);
    if (app.demo) {
      setNote("This sample does not save a secret. On your repository the file stays in the browser and is stored as the GitHub secret.");
      return;
    }
    if (fileText !== "" && (use.length > 0 || rows.some((row) => row.decision === "replace"))) {
      const key = await app.client.actionsPublicKey();
      await app.client.putActionsSecret("FACTORY_SANDBOX_ENV", sealEnv(fileText, key.key), key.key_id);
    }
    const branch = await app.client.defaultBranch();
    await app.client.dispatchWorkflow("factory-env-decide.yml", branch, {
      decisions: JSON.stringify({ use, fake, ignore, undo }),
    });
    setFileText("");
    setNote("Saved. Queued work starts once every name has a decision.");
  };

  return (
    <main className="wrap">
      <p><Link href="/">Back</Link></p>
      <h1>Settings the factory is waiting on</h1>
      <p>Use it pastes the value into the GitHub secret FACTORY_SANDBOX_ENV. Fake it is for a real production credential. Ignore this key remembers the name, and you can undo it here.</p>
      {settings.state === "loading" && <p>Loading the list.</p>}
      {rows.map((row) => (
        <SettingRow key={row.name} row={row} chosen={choice[row.name]} onPick={pick} />
      ))}
      {dynamic.length > 0 && (
        <section>
          <h2>Unknown</h2>
          {dynamic.map((file) => <p key={file}>{file} reads configuration under a name computed at runtime. This does not pause the factory.</p>)}
        </section>
      )}
      {signIn.length > 0 && (
        <section>
          <h2>Sign-in on someone else's site</h2>
          <p>{signIn.join(", ")}. Connect the test account, or skip it and that journey comes off the finish line.</p>
        </section>
      )}
      <label>
        The local env file, if you are adding values. It is not shown again.
        <input type="file" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file === undefined) return;
          void file.text().then(setFileText);
        }} />
      </label>
      <button className="btn" type="button" onClick={() => void save()}>Save these decisions</button>
      {note !== "" && <p>{note}</p>}
    </main>
  );
}

/**
 * One name, with the file it came from and the three choices.
 *
 * row: the name, the file and line, and the decision already on record.
 * chosen: the choice on this screen, if the person has picked one.
 * onPick: records that choice. It does not see the value.
 */
function SettingRow({ row, chosen, onPick }: {
  row: WaitingSetting;
  chosen: "use" | "fake" | "ignore" | "undo" | undefined;
  onPick: (name: string, value: "use" | "fake" | "ignore" | "undo") => void;
}) {
  return (
    <article className="item">
      <h2><code>{row.name}</code></h2>
      <p>{row.where}{row.client ? " — the browser bundle reads this, so it has to be present at build" : ""}</p>
      <p>Current decision: {row.decision}</p>
      <div className="acts">
        <button className="btn" type="button" aria-pressed={chosen === "use"} onClick={() => onPick(row.name, "use")}>Use it</button>
        <button className="btn" type="button" aria-pressed={chosen === "fake"} onClick={() => onPick(row.name, "fake")}>Fake it</button>
        <button className="btn" type="button" aria-pressed={chosen === "ignore"} onClick={() => onPick(row.name, "ignore")}>Ignore this key</button>
        {row.decision === "ignore" && (
          <button className="btn quiet" type="button" aria-pressed={chosen === "undo"} onClick={() => onPick(row.name, "undo")}>Undo ignore</button>
        )}
      </div>
    </article>
  );
}
