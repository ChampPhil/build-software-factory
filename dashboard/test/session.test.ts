import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSession, connectRepo, looksLikeToken, readSession, reloadSession, selectRepo, validRepo, writeSession, type Session } from "../lib/session.js";

describe("repo validation", () => {
  it("accepts owner/name", () => {
    expect(validRepo("ChampPhil/trinsports")).toBe(true);
    expect(validRepo("bsf-fixtures/ts-webapp")).toBe(true);
    expect(validRepo("  owner/name  ")).toBe(true);
  });

  it("rejects a URL, a bare name, or a path with extra segments", () => {
    expect(validRepo("https://github.com/owner/name")).toBe(false);
    expect(validRepo("name")).toBe(false);
    expect(validRepo("owner/name/tree/main")).toBe(false);
    expect(validRepo("")).toBe(false);
  });
});

describe("which repository the pages show", () => {
  it("starts the list with the first connection and appends the next", () => {
    const first = connectRepo([], "acme/widgets");
    expect(first).toEqual(["acme/widgets"]);
    expect(connectRepo(first, "other/name")).toEqual(["acme/widgets", "other/name"]);
    expect(connectRepo(first, "acme/widgets")).toEqual(["acme/widgets"]);
    expect(connectRepo(first, "not a repo")).toEqual(["acme/widgets"]);
  });

  it("switches only to a repository that is already connected", () => {
    const repos = ["acme/widgets", "other/name"];
    expect(selectRepo(repos, "acme/widgets", "other/name")).toBe("other/name");
    expect(selectRepo(repos, "acme/widgets", "missing/repo")).toBe("acme/widgets");
    expect(selectRepo(repos, "acme/widgets", "acme/widgets")).toBe("acme/widgets");
  });
});

/**
 * A document.cookie that understands one cookie at a time, including deletion
 * by Max-Age=0, which is how the sitting marker is cleared.
 */
function cookieJar() {
  let raw = "";
  return {
    get cookie(): string {
      return raw;
    },
    set cookie(value: string) {
      const pieces = value.split(";").map((part) => part.trim());
      const pair = pieces[0] ?? "";
      const eq = pair.indexOf("=");
      const name = eq === -1 ? pair : pair.slice(0, eq);
      const maxAge = pieces.find((part) => part.toLowerCase().startsWith("max-age="));
      const kept = raw.split("; ").filter((part) => part !== "" && !part.startsWith(`${name}=`));
      if (maxAge !== undefined && Number(maxAge.slice("max-age=".length)) <= 0) {
        raw = kept.join("; ");
        return;
      }
      kept.push(pair);
      raw = kept.join("; ");
    },
  };
}

/** localStorage and sessionStorage, each a plain map, plus a cookie jar. */
function fakeBrowser() {
  const store = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  const win = {
    sessionStorage: store(),
    localStorage: store(),
    location: { protocol: "https:" },
  };
  const doc = cookieJar();
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  return { win, doc };
}

const signedIn = (remembered: boolean): Session => ({
  token: "ghu_shared_token_value",
  repo: "acme/widgets",
  remembered,
  refreshToken: "ghr_shared",
  expiresAt: 1_800_000_000_000,
});

describe("one sign-in across tabs", () => {
  beforeEach(() => {
    clearSession();
  });
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it("is visible to a second tab in the same browser sitting", () => {
    const { win, doc } = fakeBrowser();
    writeSession(signedIn(false));
    // The second tab has its own memory and reads what the first one stored.
    const other = reloadSession();
    expect(other?.token).toBe("ghu_shared_token_value");
    expect(other?.repo).toBe("acme/widgets");
    expect(win.localStorage.getItem("bsf.token")).toBe("ghu_shared_token_value");
    expect(doc.cookie).toContain("bsf.sitting=1");
    expect(doc.cookie).not.toContain("ghu_shared_token_value");
  });

  it("ends when the browser quits, unless it was remembered", () => {
    const { win, doc } = fakeBrowser();
    writeSession(signedIn(false));
    doc.cookie = "bsf.sitting=; Path=/; Max-Age=0";
    expect(reloadSession()).toBeNull();
    expect(win.localStorage.getItem("bsf.token")).toBeNull();

    writeSession(signedIn(true));
    doc.cookie = "bsf.sitting=; Path=/; Max-Age=0";
    expect(reloadSession()?.token).toBe("ghu_shared_token_value");
    expect(win.localStorage.getItem("bsf.token")).toBe("ghu_shared_token_value");
  });

  it("signs every tab out", () => {
    const { win, doc } = fakeBrowser();
    writeSession(signedIn(false));
    clearSession();
    expect(readSession()).toBeNull();
    expect(win.localStorage.getItem("bsf.token")).toBeNull();
    expect(win.sessionStorage.getItem("bsf.token")).toBeNull();
    expect(doc.cookie).not.toContain("bsf.sitting=");
  });

  it("picks up a sign-in an older version left in this tab only", () => {
    const { win } = fakeBrowser();
    win.sessionStorage.setItem("bsf.token", "ghu_legacy_token_value");
    win.sessionStorage.setItem("bsf.repo", "acme/widgets");
    win.sessionStorage.setItem("bsf.remember", "false");
    expect(readSession()?.token).toBe("ghu_legacy_token_value");
    expect(win.localStorage.getItem("bsf.token")).toBe("ghu_legacy_token_value");
    expect(win.sessionStorage.getItem("bsf.token")).toBeNull();
    expect(reloadSession()?.repo).toBe("acme/widgets");
  });
});

describe("token shape", () => {
  it("recognises a fine-grained token", () => {
    expect(looksLikeToken(`github_pat_${"a".repeat(40)}`)).toBe(true);
  });

  it("recognises a classic token", () => {
    expect(looksLikeToken(`ghp_${"b".repeat(36)}`)).toBe(true);
  });

  it("rejects something obviously not a token, so the user is told before a 401", () => {
    expect(looksLikeToken("")).toBe(false);
    expect(looksLikeToken("my password")).toBe(false);
    expect(looksLikeToken("short")).toBe(false);
  });
});
