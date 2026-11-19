import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./helpers.js";
import { build } from "./fixtures/scenario.js";

const buildRoute = { match: /_apis\/build\/builds\/120\?/, json: build(120, "failed") };
const listRoute = {
  match: /_apis\/build\/builds\/120\/artifacts\?api-version/,
  json: {
    value: [
      { id: 1, name: "test-results", resource: { type: "Container", properties: { artifactsize: "2048" } } },
      { id: 2, name: "monocart-report", resource: { type: "Container" } },
    ],
  },
};

describe("run artifacts", () => {
  it("lists artifacts", async () => {
    const { code, stdout } = await runCli(["run", "artifacts", "120"], [buildRoute, listRoute]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ buildId: 120, count: 2 });
    expect(out.artifacts[0]).toEqual({ id: 1, name: "test-results", type: "Container", sizeBytes: 2048 });
  });

  it("downloads an artifact zip by name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adopipe-"));
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const zipRoute = {
      match: /_apis\/build\/builds\/120\/artifacts\?.*artifactName=test-results.*format=zip/,
      body: bytes,
      headers: { "content-type": "application/zip" },
    };
    const { code, stdout, calls } = await runCli(["run", "artifacts", "120", "--download", "test-results", "--out", dir], [buildRoute, zipRoute]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ buildId: 120, artifact: "test-results", bytes: 7 });
    expect(out.extractedTo).toBeUndefined();
    expect(new Uint8Array(readFileSync(out.zip))).toEqual(bytes);
    expect(calls.some((c) => c.includes("artifactName=test-results"))).toBe(true);
  });

  it.runIf(process.platform === "win32")("extracts the zip with --extract", async () => {
    const src = mkdtempSync(join(tmpdir(), "adopipe-src-"));
    mkdirSync(join(src, "test-results", "spec-a"), { recursive: true });
    writeFileSync(join(src, "test-results", "spec-a", "error-context.md"), "# boom");
    const zipFile = join(src, "a.zip");
    const tar = join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe");
    execFileSync(tar, ["-a", "-c", "-f", zipFile, "-C", src, "test-results"]);
    const zipRoute = {
      match: /_apis\/build\/builds\/120\/artifacts\?.*artifactName=test-results/,
      body: new Uint8Array(readFileSync(zipFile)),
      headers: { "content-type": "application/zip" },
    };
    const out = mkdtempSync(join(tmpdir(), "adopipe-out-"));
    const { code, stdout } = await runCli(["run", "artifacts", "120", "--download", "test-results", "--out", out, "--extract"], [buildRoute, zipRoute]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).extractedTo).toBe(out);
    expect(existsSync(join(out, "test-results", "spec-a", "error-context.md"))).toBe(true);
  });

  it("unknown artifact is exit code 3", async () => {
    const { code, stderr } = await runCli(
      ["run", "artifacts", "120", "--download", "nope"],
      [buildRoute, { match: /artifactName=nope/, status: 404, json: { message: "Artifact nope not found for build 120" } }],
    );
    expect(code).toBe(3);
    expect(JSON.parse(stderr).error.code).toBe("NOT_FOUND");
  });

  it("rejects a JSON answer where a zip was expected", async () => {
    const { code, stderr } = await runCli(
      ["run", "artifacts", "120", "--download", "test-results", "--out", mkdtempSync(join(tmpdir(), "adopipe-"))],
      [buildRoute, { match: /artifactName=test-results/, json: { id: 1, name: "test-results" }, headers: { "content-type": "application/json" } }],
    );
    expect(code).toBe(2);
    expect(JSON.parse(stderr).error.message).toMatch(/Expected a zip/);
  });

  it("--out without --download is a usage error", async () => {
    const { code } = await runCli(["run", "artifacts", "120", "--out", "x"], [buildRoute]);
    expect(code).toBe(1);
  });
});
