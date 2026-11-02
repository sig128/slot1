import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLEARABLE_SETTINGS, SettingsPatch, settingsEntries, settingValueOk, SETTING_KEYS, type SettingKey } from "@slot1/contracts";
import { encodeSettingsRequest } from "../../apps/api/src/lib/settings-inbox";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/server-setup.sh");

/**
 * The server's own check (setting_ok and setting_clearable in scripts/server-setup.sh), run in
 * bash exactly as `slot1 tick` runs it: under systemd, so in the C locale. One bash call checks
 * every case and prints one line per case.
 */
function serverChecks(cases: [SettingKey, string][], locale = "C"): boolean[] {
  const fns = execFileSync("bash", ["-c", `sed -n '/^setting_ok() {/,/^}/p;/^setting_clearable() {/,/^}/p' "$1"`, "_", SCRIPT], { encoding: "utf8" });
  const prog = `${fns}\nwhile IFS= read -r k && IFS= read -r b; do v="$(printf '%s' "$b" | base64 -d)"; if setting_ok "$k" "$v"; then echo 1; else echo 0; fi; done`;
  const input = cases.map(([k, v]) => `${k}\n${Buffer.from(v, "utf8").toString("base64")}`).join("\n") + "\n";
  const out = execFileSync("bash", ["-c", prog], { input, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: locale } });
  return out.trim().split("\n").map((l) => l === "1");
}

function serverClearable(keys: readonly string[]): boolean[] {
  const fns = execFileSync("bash", ["-c", `sed -n '/^setting_clearable() {/,/^}/p' "$1"`, "_", SCRIPT], { encoding: "utf8" });
  const out = execFileSync("bash", ["-c", `${fns}\nfor k in "$@"; do if setting_clearable "$k"; then echo 1; else echo 0; fi; done`, "_", ...keys], { encoding: "utf8" });
  return out.trim().split("\n").map((l) => l === "1");
}

const LONG = (n: number, c = "a") => c.repeat(n);
const CASES: [SettingKey, string][] = [
  ["TWITCH_CLIENT_ID", "ob9huq12suxo9zpbxmjgsfpukdequg"],
  ["TWITCH_CLIENT_ID", "OB9HUQ12SUXO9ZPBXMJGSFPUKDEQUG"],
  ["TWITCH_CLIENT_ID", "short"],
  ["TWITCH_CLIENT_ID", LONG(64)],
  ["TWITCH_CLIENT_ID", LONG(65)],
  ["TWITCH_CLIENT_SECRET", "abcdefghij0123456789abcdefghij"],
  ["TWITCH_CLIENT_SECRET", "abcdefghij0123456789 bcdefghij"],
  ["SLOT1_OPERATOR_TWITCH_LOGINS", "ketchupclan"],
  ["SLOT1_OPERATOR_TWITCH_LOGINS", "ketchupclan,second_admin"],
  ["SLOT1_OPERATOR_TWITCH_LOGINS", "KetchupClan"],
  ["SLOT1_OPERATOR_TWITCH_LOGINS", "a,b,c,d,e,f,g,h,i,j"],
  ["SLOT1_OPERATOR_TWITCH_LOGINS", "a,b,c,d,e,f,g,h,i,j,k"],
  ["SLOT1_OPERATOR_TWITCH_LOGINS", "ketchupclan,"],
  ["SLOT1_BOT_TWITCH_LOGIN", "slot1bot"],
  ["SLOT1_BOT_TWITCH_LOGIN", "slot1 bot"],
  ["ANTHROPIC_API_KEY", `sk-ant-api03-${LONG(40, "x")}_A-9`],
  ["ANTHROPIC_API_KEY", "sk-ant-short"],
  ["ANTHROPIC_API_KEY", `sk-ant-${LONG(20)}$`],
  ["VISION_PROVIDER", "anthropic"],
  ["VISION_PROVIDER", "none"],
  ["VISION_PROVIDER", "openai"],
  ["SLOT1_AUTODEPLOY", "true"],
  ["SLOT1_AUTODEPLOY", "false"],
  ["SLOT1_AUTODEPLOY", "yes"],
  ["SLOT1_GOOGLE_SITE_VERIFICATION", "abc-DEF_123"],
  ["SLOT1_GOOGLE_SITE_VERIFICATION", 'content="abc"'],
  ["SLOT1_BING_SITE_VERIFICATION", LONG(120, "B")],
  ["SLOT1_BING_SITE_VERIFICATION", LONG(121, "B")],
  ["SLOT1_CONTACT_EMAIL", "hello@slot1.fun"],
  ["SLOT1_CONTACT_EMAIL", "hello.slot1.fun"],
  ["SLOT1_CONTACT_EMAIL", "not an@email.com"],
  ["SLOT1_CONTACT_EMAIL", "a@b@c"],
  ["SLOT1_CONTACT_EMAIL", "a$b@c.com"],
  ["SLOT1_CONTACT_EMAIL", `${LONG(64)}@x.com`],
  ["SLOT1_CONTACT_EMAIL", `${LONG(65)}@x.com`],
  ["SLOT1_LEGAL_NAME", "SLOT1 Studios AS"],
  ["SLOT1_LEGAL_NAME", "a$b"],
  ["SLOT1_LEGAL_NAME", 'a"b'],
  ["SLOT1_LEGAL_NAME", "a'b"],
  ["SLOT1_LEGAL_NAME", "a`b"],
  ["SLOT1_LEGAL_NAME", "a\\b"],
  ["SLOT1_LEGAL_NAME", "a#b"],
  ["SLOT1_LEGAL_NAME", "two\nlines"],
  ["SLOT1_LEGAL_NAME", "tab\there"],
  ["SLOT1_LEGAL_ADDRESS", "Øvre gate 1, 0150 Oslo"],
  ["SLOT1_LEGAL_ADDRESS", LONG(200)],
  ["SLOT1_LEGAL_ADDRESS", LONG(201)],
  ["SLOT1_LEGAL_ADDRESS", LONG(100, "Ø")],
  ["SLOT1_LEGAL_ADDRESS", LONG(101, "Ø")],
  ["SLOT1_GOVERNING_LAW", "Norway"],
  ["SLOT1_ADMIN_PASSWORD_HASH", "scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaA=="],
  ["SLOT1_ADMIN_PASSWORD_HASH", "plain-password-123"],
];

describe("Settings saved in /admin: the same rules as the server", () => {
  it("accepts and refuses exactly what the server's check does", () => {
    const server = serverChecks(CASES);
    expect(server).toHaveLength(CASES.length);
    CASES.forEach(([k, v], i) => {
      expect(settingValueOk(k, v), `${k} = ${JSON.stringify(v)}`).toBe(server[i]);
    });
  });

  it("never lets something through that the server would refuse in a UTF-8 terminal either", () => {
    const utf8 = serverChecks(CASES, "C.UTF-8");
    CASES.forEach(([k, v], i) => {
      if (settingValueOk(k, v)) expect(utf8[i], `${k} = ${JSON.stringify(v)}`).toBe(true);
    });
  });

  it("empties only what the server lets /admin empty", () => {
    expect(serverClearable(SETTING_KEYS)).toEqual(SETTING_KEYS.map((k) => CLEARABLE_SETTINGS.has(k)));
  });

  it("turns a patch into settings, tidying what people paste", () => {
    const patch = SettingsPatch.parse({
      adminTwitchLogins: " @KetchupClan, Second_Admin ,",
      googleVerification: '<meta name="google-site-verification" content="abc-DEF_123" />',
      contactEmail: "",
      aiEnabled: true,
      autodeploy: false,
    });
    expect(settingsEntries(patch)).toEqual({
      ok: true,
      entries: [
        { key: "SLOT1_OPERATOR_TWITCH_LOGINS", value: "ketchupclan,second_admin" },
        { key: "VISION_PROVIDER", value: "anthropic" },
        { key: "SLOT1_AUTODEPLOY", value: "false" },
        { key: "SLOT1_GOOGLE_SITE_VERIFICATION", value: "abc-DEF_123" },
        { key: "SLOT1_CONTACT_EMAIL", value: null },
      ],
    });
  });

  it("says which field is wrong, and refuses emptying what can only be replaced", () => {
    const r = settingsEntries(SettingsPatch.parse({ legalAddress: "a$b", twitchClientSecret: "", contactEmail: "nope" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["contactEmail", "legalAddress", "twitchClientSecret"]);
    expect(r.errors.twitchClientSecret).toMatch(/can't be emptied/);
    expect(() => SettingsPatch.parse({ databasePassword: "x" })).toThrow();
  });

  it("writes the request in the exact format the server reads", () => {
    expect(
      encodeSettingsRequest([
        { key: "SLOT1_LEGAL_ADDRESS", value: "Øvre gate 1, 0150 Oslo" },
        { key: "SLOT1_CONTACT_EMAIL", value: null },
      ]),
    ).toBe(`slot1-settings v1\nset SLOT1_LEGAL_ADDRESS ${Buffer.from("Øvre gate 1, 0150 Oslo").toString("base64")}\nclear SLOT1_CONTACT_EMAIL\n`);
  });
});
