import { describe, it, expect } from "vitest";
import { getPromptDescription } from "./skill-prompts.js";
import { createTestSkill, createTestSkillState } from "./__test-helpers__/helpers.js";

describe("getPromptDescription", () => {
  it("lists user-invocable skills", () => {
    const state = createTestSkillState([
      createTestSkill({ name: "my-skill", description: "Does things", effectiveUserInvocable: true }),
    ]);
    const desc = getPromptDescription(state);
    expect(desc).toContain("Load a skill by name");
    expect(desc).toContain("<name>my-skill</name>");
    expect(desc).toContain("<description>Does things</description>");
  });

  it("excludes skills with effectiveUserInvocable false", () => {
    const state = createTestSkillState([
      createTestSkill({ name: "visible", effectiveUserInvocable: true }),
      createTestSkill({ name: "hidden", effectiveUserInvocable: false }),
    ]);
    const desc = getPromptDescription(state);
    expect(desc).toContain("<name>visible</name>");
    expect(desc).not.toContain("<name>hidden</name>");
  });
});
