import { Note } from "@/components/primitives";

const README = "https://github.com/ChampPhil/build-software-factory#readme";

/**
 * What a page with no factory data says, by what is true of the repository.
 *
 * Two different situations look the same in the data (no records), and the
 * right words differ: a repository that never had a factory needs to be told
 * how to get one, and one that has a factory and no runs needs to be told what
 * starts the first.
 */
export function EmptyFactoryNote({ installed }: { installed: boolean | null }) {
  // Not known yet: say nothing rather than the wrong thing.
  if (installed === null) return null;
  if (installed) {
    return (
      <Note>
        The factory is set up here and has not run yet. It starts when an issue is filed, when a
        review comment lands on one of its pull requests, or on the nightly cleanup. This page fills
        in from the first run.
      </Note>
    );
  }
  return (
    <Note>
      There is no factory on this repository yet. Setup is done by Claude Code, from your own
      machine: give it the setup skill and ask it to set up the software factory on this repository.
      The steps are in the{" "}
      <a href={README} target="_blank" rel="noopener noreferrer">
        project README
      </a>
      . This page fills in once setup has run.
    </Note>
  );
}
