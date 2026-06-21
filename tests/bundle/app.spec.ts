import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import app from "../../app.json" with { type: "json" };
import manifest from "../../manifest.json" with { type: "json" };

const readProjectFile = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("policygate app package", () => {
  it("declares the installable Anna app and bundled dispatcher", () => {
    expect(app.slug).toBe("policygate");
    expect(app.bundled_executas).toEqual({
      "policygate-case": { path: "./executas/policygate-case-python" },
    });
  });

  it("ships a static main view for the Anna host", () => {
    expect(manifest.ui.bundle).toMatchObject({
      format: "static-spa",
      entry: "index.html",
    });
    expect(manifest.ui.views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "main", default: true, entry: "index.html" }),
      ]),
    );
  });

  it("requires the bundled approval case dispatcher", () => {
    expect(manifest.required_executas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool_id: "bundled:policygate-case" }),
      ]),
    );
  });

  it("exposes only the host APIs used by the bundle", () => {
    expect(manifest.permissions).toEqual(
      expect.arrayContaining([
        "tools.invoke",
        "storage.read",
        "storage.write",
        "chat.write_message",
      ]),
    );
    expect(manifest.ui.host_api.tools).toEqual(["required:bundled:policygate-case"]);
    expect(manifest.ui.host_api.storage).toEqual(["get", "set"]);
    expect(manifest.ui.host_api.chat).toEqual(["write_message"]);
    expect(manifest.ui.host_api.llm).toEqual([]);
    expect(manifest.ui.host_api.fs).toEqual([]);
  });

  it("keeps the Skill playbook bound to the local Executa tool id", () => {
    const skill = readProjectFile("executas/policygate-ops/SKILL.md");
    const executa = JSON.parse(
      readProjectFile("executas/policygate-case-python/executa.json"),
    ) as { tool_id: string };

    expect(skill).toContain(`- ${executa.tool_id}`);
    expect(skill).toContain("A human approval, rejection, or escalation must be recorded");
    expect(skill).not.toContain("CHANGEME");
  });

  it("documents production publishing and the chat mention trigger", () => {
    const readme = readProjectFile("README.md");

    expect(readme).toContain("anna.partners/developers");
    expect(readme).toContain("#policygate");
    expect(readme).toContain("pnpm validate");
  });
});
