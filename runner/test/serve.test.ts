import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDashboard, resolveFile, serveDashboard } from "../src/commands/serve.js";

let root: string;
let outside: string;
let server: Awaited<ReturnType<typeof serveDashboard>>;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "bsf-serve-"));
  root = join(dir, "out");
  mkdirSync(join(root, "live"), { recursive: true });
  mkdirSync(join(root, "_next"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Home</title>");
  writeFileSync(join(root, "404.html"), "<!doctype html><title>Not found</title>");
  writeFileSync(join(root, "live", "index.html"), "<!doctype html><title>Live</title>");
  writeFileSync(join(root, "dashboard.html"), "<!doctype html><title>Dashboard</title>");
  writeFileSync(join(root, "_next", "app.js"), "console.log(1)");

  // A secret next to the served directory, to prove it cannot be reached.
  outside = join(dir, "secret.txt");
  writeFileSync(outside, "a token");

  server = await serveDashboard({ root, port: 0 });
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const get = async (path: string, method = "GET") => {
  const res = await fetch(`${server.url}${path}`, { method, redirect: "manual" });
  return { status: res.status, body: await res.text(), headers: res.headers };
};

describe("resolveFile", () => {
  it("serves a file directly", async () => {
    expect(await resolveFile(root, "/index.html")).toBe(join(root, "index.html"));
  });

  it("finds a directory's index.html, which is how the export is laid out", async () => {
    expect(await resolveFile(root, "/live")).toBe(join(root, "live", "index.html"));
  });

  it("finds the .html next's export wrote for a route", async () => {
    expect(await resolveFile(root, "/dashboard")).toBe(join(root, "dashboard.html"));
  });

  it("refuses a path that climbs out of the served directory", async () => {
    expect(await resolveFile(root, "/../secret.txt")).toBeNull();
    expect(await resolveFile(root, "/../../../../etc/passwd")).toBeNull();
  });

  it("refuses an encoded climb, which is the one a naive check misses", async () => {
    expect(await resolveFile(root, "/%2e%2e%2fsecret.txt")).toBeNull();
    expect(await resolveFile(root, "/live/..%2f..%2fsecret.txt")).toBeNull();
  });

  it("refuses a path with a NUL byte, which truncates in some filesystem calls", async () => {
    expect(await resolveFile(root, "/index.html%00.png")).toBeNull();
  });

  it("ignores a query string", async () => {
    expect(await resolveFile(root, "/live?id=run_1")).toBe(join(root, "live", "index.html"));
  });

  it("returns null for a directory with no index", async () => {
    expect(await resolveFile(root, "/_next")).toBeNull();
  });
});

describe("the served dashboard", () => {
  it("serves the home page", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Home");
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("serves a route's page", async () => {
    expect((await get("/live")).body).toContain("Live");
  });

  it("serves javascript with the right type, so the browser will run it", async () => {
    const res = await get("/_next/app.js");
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  it("answers an unknown path with the export's own 404 page", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toContain("Not found");
  });

  it("does not serve a file outside the directory", async () => {
    const res = await fetch(`${server.url}/../secret.txt`, { redirect: "manual" });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("a token");
  });

  it("sends the headers that matter for a page holding a GitHub token", async () => {
    const res = await get("/");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // A cached build after an upgrade is a confusing bug.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers HEAD with the headers and no body", async () => {
    const res = await get("/", "HEAD");
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
  });

  it("refuses anything but GET and HEAD", async () => {
    const res = await get("/", "POST");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("listens on the loopback interface only", () => {
    // The page holds a token that can write to the repo; a dashboard
    // reachable from the network would hand it to anyone on that network.
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("findDashboard", () => {
  it("finds the build in a checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-find-"));
    mkdirSync(join(dir, "dashboard/out"), { recursive: true });
    writeFileSync(join(dir, "dashboard/out/index.html"), "x");
    expect(findDashboard(dir)).toBe(join(dir, "dashboard/out"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null rather than a directory with no dashboard in it", () => {
    expect(findDashboard(mkdtempSync(join(tmpdir(), "bsf-find-")))).toBeNull();
  });
});
