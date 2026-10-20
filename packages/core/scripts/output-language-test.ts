import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("output-language");
import { defineDomain, assertDomainsValid, type Domain } from "../agent/memory/domain.js";
import { registerConfig } from "../agent/access/config.js";
import { defineSettings, languageTagProblem, overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";
import { renderLanguageSection, resolveOutputLanguage } from "../agent/instructions/language.js";
import { renderScopeMarkdown } from "../agent/instructions/access.js";
import { classifySessionId, taskWindowId } from "../agent/channels/window-key.js";
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { _resetDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

registerSlackFixtureMapper();
_resetDeploymentIdentityForTest();

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throws(fn: () => unknown, needle: string, label: string): void {
  try {
    fn();
  } catch (err) {
    ok(String(err).includes(needle), `${label} (message mentions "${needle}", got: ${String(err)})`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

ok(languageTagProblem("") === undefined, "empty is legal: no language rule");
for (const tag of ["fr", "de", "pt-BR", "ja", "zh-Hant"]) ok(languageTagProblem(tag) === undefined, `"${tag}" is a known tag`);
for (const bad of [" fr", "fr ", "pt BR", "french", "zz", "123"]) ok(languageTagProblem(bad) !== undefined, `"${bad}" is refused`);
throws(() => defineSettings({ language: { output: "french" } }), "language.output", "defineSettings fails the boot on an unknown tag");
ok(defineSettings({ language: { output: "fr" } }).language?.output === "fr", "defineSettings accepts a known tag");
throws(
  () => assertDomainsValid([defineDomain({ name: "org", match: "org" }), defineDomain({ name: "eng", reach: ["slack/T1/C1"], language: "klingon-ish" })]),
  "sets language",
  "assertDomainsValid refuses a domain with a bad tag",
);

const org = defineDomain({ name: "org", match: "org", language: "de" });
const dm = defineDomain({ name: "dm", match: "dm" });
const fr = defineDomain({ name: "paris", reach: ["slack/T1/C1"], language: "fr" });
const plain = defineDomain({ name: "plain", reach: ["slack/T1/C2"] });
const all: Domain[] = [org, dm, fr, plain];
ok(resolveOutputLanguage(fr, all, "es") === "fr", "an explicit domain's own tag wins");
ok(resolveOutputLanguage(plain, all, "es") === "de", "an explicit domain without one inherits the org pseudo-domain's");
ok(resolveOutputLanguage(plain, [dm, fr, plain], "es") === "es", "with no org tag, it falls to the setting");
ok(resolveOutputLanguage(dm, all, "es") === "es", "the dm scope does NOT inherit the org pseudo-domain's tag");
ok(resolveOutputLanguage(undefined, all, "") === "", "no scope and no setting: no rule");

ok(renderLanguageSection("") === "", "no tag renders nothing");
const section = renderLanguageSection("pt-BR");
ok(section.startsWith("## Output language") && section.includes("Brazilian Portuguese (`pt-BR`)"), "the section names the language and the tag");
ok(section.includes("writes in another language") && section.includes("asks for another language"), "the section keeps the person's own language and request");

const seamDomains: Domain[] = [defineDomain({ name: "org", match: "org" }), defineDomain({ name: "paris", reach: ["slack/T1/C1"], language: "fr" })];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => seamDomains,
  loadSilos: () => [],
  domainsForSurface: () => [],
});
const slackCtx = (channelId: string) => ({
  channel: { kind: "slack" },
  session: {
    auth: {
      current: {
        attributes: { team_id: "T1", channel_id: channelId, channel_type: "channel", is_private: "false", is_ext_shared: "false", trust_checked: "true" },
        principalId: "U1",
        principalType: "slack-user",
      },
    },
  },
});

resetSettingsForTest();
ok(!(await renderScopeMarkdown(slackCtx("C9"))).includes("## Output language"), "SEAM: nothing set ⇒ no section (byte-identical to before)");
const overridden = await renderScopeMarkdown(slackCtx("C1"));
ok(overridden.includes("## Output language") && overridden.includes("French (`fr`)"), "SEAM: the domain override reaches the session's prompt");
overrideSettingsForTest({ language: { output: "ja" } });
const orgDefault = await renderScopeMarkdown(slackCtx("C9"));
ok(orgDefault.includes("Japanese (`ja`)"), "SEAM: the org default reaches a channel no domain overrides");
ok((await renderScopeMarkdown(slackCtx("C1"))).includes("French (`fr`)"), "SEAM: the domain override beats the org default");
resetSettingsForTest();

{
  const taskToken = `oe-dom:paris:win:${taskWindowId("slack/T1/C1", "1700.5")}:oe-sup:g1`;
  ok(classifySessionId(taskToken).kind === "task", "fixture guard: the worker token classifies task-grain");
  const workerCtx = {
    channel: { kind: "channel:unified", continuationToken: taskToken },
    session: { auth: { current: { attributes: { oe_platform: "slack", oe_grain: "task" } } } },
  };
  const seatMd = await renderScopeMarkdown(slackCtx("C1"));
  const workerMd = await renderScopeMarkdown(workerCtx as never);
  ok(workerMd.includes("French (`fr`)"), "WORKER: a task-grain worker of the paris domain reads the domain's language");
  const section = (md: string) => md.slice(md.indexOf("## Output language")).split("\n\n")[0];
  ok(section(workerMd) === section(seatMd), "WORKER: the worker's section is byte-identical to its seat's");
  overrideSettingsForTest({ language: { output: "ja" } });
  ok((await renderScopeMarkdown(workerCtx as never)).includes("French (`fr`)"), "WORKER: the domain override still beats the org default for the worker");
  resetSettingsForTest();
}

console.log(`✓ output-language: ${passed} assertions passed`);
