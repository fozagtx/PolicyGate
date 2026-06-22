import { existsSync, readFileSync } from "node:fs";
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
    expect(manifest.required_executas).toHaveLength(1);
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

  it("keeps the Skill playbook bound to the bundled case tool", () => {
    const skill = readProjectFile("executas/policygate-ops/SKILL.md");
    const executa = JSON.parse(
      readProjectFile("executas/policygate-case-python/executa.json"),
    ) as {
      tool_id: string;
      distribution: {
        type: string;
        executable_name: string;
        supports_protocol: boolean;
        binary_urls: Record<string, unknown>;
      };
    };

    expect(executa.tool_id).toBe("tool-zanbuilds-policygate-case-rveqx8hp");
    expect(executa.distribution).toMatchObject({
      type: "binary",
      executable_name: "tool-zanbuilds-policygate-case-rveqx8hp",
      supports_protocol: true,
    });
    expect(Object.keys(executa.distribution.binary_urls)).toEqual([
      "darwin-arm64",
      "darwin-x86_64",
      "linux-x86_64",
    ]);
    expect(skill).toContain("- bundled:policygate-case");
    expect(skill).toContain("A human approval, rejection, or escalation must be recorded");
    expect(skill).not.toContain("CHANGEME");
  });

  it("uses Anna host LLM sampling instead of external model credentials", () => {
    const plugin = readProjectFile("executas/policygate-case-python/policygate_case_plugin.py");
    const pyproject = readProjectFile("executas/policygate-case-python/pyproject.toml");
    const readme = readProjectFile("README.md");

    expect(plugin).toContain("\"host_capabilities\": [\"llm.sample\"]");
    expect(plugin).toContain("sampling/createMessage");
    expect(pyproject).not.toMatch(/openai|pydantic/i);
    expect(readme).not.toMatch(/OPENAI_API_KEY|OpenAI API Key/);
  });

  it("does not ship the standalone SDK bridge inside the production bundle", () => {
    const bundledBridge = new URL(
      "../../bundle/static/anna-apps/_sdk/latest/index.js",
      import.meta.url,
    );

    expect(existsSync(bundledBridge)).toBe(false);
  });

  it("documents production publishing and the chat mention trigger", () => {
    const readme = readProjectFile("README.md");

    expect(readme).toContain("anna.partners/developers");
    expect(readme).toContain("#policygate");
    expect(readme).toContain("pnpm validate");
  });
});
