# Taking the factory out

Someone asks to remove, uninstall, disable or get rid of the software factory.
This is a supported thing to do and you do it without talking them out of it.

**What it means: the factory stops running. Everything it built stays.** The
merged pull requests, the commits, the issues, the branches, the run history —
all of that is the repository's, not the factory's, and none of it is removed.
What goes is the machinery: the workflows that run agents, `.factory/`, the
issue forms, the labels, and the required checks the factory added.

## Steps

1. **Show them what will happen first.** From the repository root:

   ```
   .factory/bin/bsf uninstall
   ```

   (On Windows: `.\.factory\bin\bsf.cmd uninstall`.) It changes nothing and
   prints the plan: the files, the labels, which required checks it will drop,
   and what is left for them to do.

2. **Do it, on a branch.**

   ```
   git checkout -b factory/uninstall
   ```

   ```
   .factory/bin/bsf uninstall --apply
   ```

   That deletes the files in the checkout and does the API work — labels and
   branch protection. It does not commit.

3. **Commit and open a pull request.** The workflows sit under protected
   paths, so removing them is a change a person should see and merge, exactly
   like installing them was.

4. **Tell them the two things only they can do**, which the command also
   prints:
   - **Uninstall the GitHub App.** Only a repository admin can, at the
     settings page the command names. Until they do, the App is installed but
     has nothing to run.
   - **Revoke the Anthropic API key** if they made one for this repository and
     use it nowhere else. Removing the secret from the repository does not
     revoke the key.

## `refs/factory/data`

Kept by default. It is the record of the work the factory did — every run,
what it cost, what was decided — and it is not part of the machinery. Nobody's
history should disappear because they turned a tool off.

If they want it gone, say what it is first, then:

```
.factory/bin/bsf uninstall --apply --purge-data
```

Or afterwards, on their own: `git push origin :refs/factory/data`.

## Branch protection

The factory only ever *added* required checks, so uninstall removes exactly
those and leaves every other rule alone. If the factory was also what created
the protection in the first place, and nothing else is relying on it, it is
removed entirely — the command knows which, from a record written at setup.

If that record is missing — an old install, or a purged data ref — the command
says so and identifies the factory's checks by name. Tell them to look at the
branch's protection settings themselves afterwards.

## If they are removing it because something went wrong

Ask what happened, once, after it is removed and not before. A person who
wants this out of their repository gets it out first. If they tell you, it is
worth more than a survey: it is the only honest signal this project gets about
why someone left.
