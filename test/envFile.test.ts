import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadEnvFiles, parseEnvText } from "../src/envFile.js";

describe("parseEnvText", () => {
  it("handles comments, export, quotes and inline comments", () => {
    const text = [
      "﻿# comment",
      "",
      "AZURE_DEVOPS_PAT=abc123 # trailing comment",
      "export AZURE_DEVOPS_ORG = https://tfs.corp/tfs/DefaultCollection",
      'AZURE_DEVOPS_PROJECT="My #1 Project"',
      "SINGLE='a\\nb'",
      'DOUBLE="a\\nb \\"q\\""',
      "not a line",
    ].join("\r\n");
    expect(parseEnvText(text)).toEqual({
      AZURE_DEVOPS_PAT: "abc123",
      AZURE_DEVOPS_ORG: "https://tfs.corp/tfs/DefaultCollection",
      AZURE_DEVOPS_PROJECT: "My #1 Project",
      SINGLE: "a\\nb",
      DOUBLE: 'a\nb "q"',
    });
  });
});

describe("loadEnvFiles", () => {
  const cwd = "/work";
  const home = "/home/me";
  const local = join(cwd, ".env");
  const global = join(home, ".adopipe.env");

  it("uses shell env first, then ./.env, then ~/.adopipe.env, and ignores other keys", () => {
    const files: Record<string, string> = {
      [local]: "AZURE_DEVOPS_ORG=local-org\nAZURE_DEVOPS_PROJECT=local-proj\nNODE_OPTIONS=--evil",
      [global]: "AZURE_DEVOPS_PAT=global-pat\nAZURE_DEVOPS_ORG=global-org",
    };
    const env: NodeJS.ProcessEnv = { AZURE_DEVOPS_PROJECT: "shell-proj" };
    const used = loadEnvFiles(env, { cwd, home, read: (p) => files[p] });
    expect(env).toEqual({
      AZURE_DEVOPS_PROJECT: "shell-proj",
      AZURE_DEVOPS_ORG: "local-org",
      AZURE_DEVOPS_PAT: "global-pat",
    });
    expect(used).toEqual([local, global]);
  });

  it("does nothing when no files exist", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnvFiles(env, { cwd, home, read: () => undefined })).toEqual([]);
    expect(env).toEqual({});
  });
});
