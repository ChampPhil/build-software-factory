/**
 * How the repository name fits in the top bar.
 *
 * Purpose:
 *   The top bar shows the repository name, the owner, and the Briefing
 *   link side by side. A long name such as vibecoding-for-marketing draws
 *   on one line and covers the owner and that link. This module picks a
 *   shorter label before that happens. The bar itself keeps the name on
 *   its own line; this function is the truncation.
 *
 * Key terms:
 *   - Repository name: the part after the slash in owner/name. The owner
 *     is not abbreviated here.
 *   - Separator: a hyphen, underscore, dot, or space between words.
 *   - Initials: the first letter of each word, in capitals. Separators
 *     become those letters, so vibecoding-for-marketing becomes VFM.
 *   - Collision: the name is long enough that, beside the owner and the
 *     Briefing link, it would overlap them. Short names are left as written.
 *
 * Exports:
 *   - REPO_NAME_FITS: how many characters fit before the name collides.
 *   - repoBarLabel: the text to show for a repository name.
 */

/** Characters of a repository name that fit before it covers the owner and Briefing. */
export const REPO_NAME_FITS = 18;

/**
 * The repository name to show in the top bar.
 *
 * A name that fits is returned unchanged, so the owner and the Briefing
 * link keep their places. A longer name is shortened: words split on
 * separators become initials, and a single word keeps its first five letters.
 *
 * name: the repository name, without the owner.
 */
export function repoBarLabel(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= REPO_NAME_FITS) return trimmed;

  // Drop the separators. What remains is one word, or several.
  const parts = trimmed.split(/[^A-Za-z0-9]+/).filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!.slice(0, 5);

  // One capital from each word: vibecoding-for-marketing -> VFM.
  return parts.map((part) => part.charAt(0).toUpperCase()).join("");
}
