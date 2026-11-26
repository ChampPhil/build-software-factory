# Taking the factory out

Someone asks to remove, uninstall, disable, or get rid of the software
factory. Do it. Do not talk them out of it. Do not ask why first.

**What the machinery removal means: the factory stops running. Commits
already on the default branch stay.** Merged work stays either way. What
goes, once they merge the uninstall pull request, is the machinery: the
workflows that run agents, `.factory/`, the issue forms, the labels, and
the required checks the factory added.

## Ask before you delete anything else

Before you delete anything beyond that machinery, ask these three questions.
You may ask them in one message. Each defaults to no. If they skip one, or
do not answer, that delete is no.

Say, with the questions, that commits already on the default branch stay
either way.

1. **Does this include all factory run history?** The history is the record
   of every run, what it cost, and what was decided. It is not part of the
   machinery. Default: no.
2. **Delete the factory's branches?** These are branches the factory opened.
   Not the default branch. Not a branch the person opened. If you are not
   sure who opened a branch, do not delete it. Deleting a branch closes a
   pull request that is still open on it. Say that in the question.
   Default: no.
3. **Delete the factory's issues?** These are issues the factory filed. Not
   issues the person filed. If you are not sure who filed an issue, do not
   delete it. Default: no.

Yes means that delete is part of the commands you run. No, or no answer,
means that delete is absent. Do not end by telling them to run the delete
themselves. Do not print the command as an optional follow-up.

## Steps

1. **Show them what the machinery removal will do.** From the repository
   root, before you change anything:

   ```
   .factory/bin/bsf uninstall
   ```

   (On Windows: `.\.factory\bin\bsf.cmd uninstall`.) It changes nothing and
   prints the plan: the files, the labels, which required checks it will
   drop.

2. **Do the machinery removal, on a branch.** Include the history delete
   only when they said yes to the first question.

   ```
   git checkout -b factory/uninstall
   ```

   When history stays (no, or no answer):

   ```
   .factory/bin/bsf uninstall --apply
   ```

   When they said yes to history, the history delete is part of the command
   you run:

   ```
   .factory/bin/bsf uninstall --apply --purge-data
   ```

   That deletes the machinery files in the checkout and does the API work
   for labels and branch protection. It does not commit. If the history
   ref is still there after a yes, you delete it yourself:

   ```
   git push origin :refs/factory/data
   ```

   You run that. You do not hand it to them. When the answer was no, that
   command is absent. Do not mention it.

3. **Branches, only on a yes.** Delete each branch the factory opened.
   Never the default branch. Never a branch the person opened. Deleting the
   branch closes a pull request still open on it. You run the delete:

   ```
   git push origin --delete <branch>
   ```

   When the answer was no, that command is absent. Do not delete any
   branch, and do not tell them how to.

4. **Issues, only on a yes.** Delete each issue the factory filed. Not an
   issue the person filed. You run the delete:

   ```
   gh issue delete <number> --yes
   ```

   When the answer was no, that command is absent. Do not delete any
   issue, and do not tell them how to.

5. **Commit and open a pull request.** The workflows sit under protected
   paths, so removing them is a change a person should see and merge,
   exactly like installing them was. Start
   `node scripts/wait-for.mjs pr-merged <number>` when you ask them to
   merge it. Do not tell them to come back and say they merged.

6. **Tell them the two things only they can do**, which the uninstall
   command also prints:
   - **Uninstall the GitHub App.** Only a repository admin can, at the
     settings page the command names. Until they do, the App is installed
     but has nothing to run.
   - **Revoke the Anthropic API key** if they made one for this repository
     and use it nowhere else. Removing the secret from the repository does
     not revoke the key.

   Those two are not the three questions. Do not add a fourth item that
   tells them to delete history, branches, or issues.

## Branch protection

The factory only ever added required checks, so uninstall removes exactly
those and leaves every other rule alone. If the factory was also what
created the protection in the first place, and nothing else is relying on
it, it is removed entirely. The command knows which, from a record written
at setup.

If that record is missing, an old install or a history ref that was
deleted, the command says so and identifies the factory's checks by name.
Tell them to look at the branch's protection settings themselves afterwards.

## If they are removing it because something went wrong

Ask what happened, once, after it is removed and not before. A person who
wants this out of their repository gets it out first. If they tell you, it
is worth more than a survey: it is the only honest signal this project gets
about why someone left.
