import { describe, expect, it } from "vitest";
import { fillGeneratedScript, readPasswordFieldScript } from "../src/shared/credential-scripts";
import { passwordFieldFacts, passwordRoles, type PasswordFieldFacts, type PasswordInputElement } from "../src/shared/password-fields";

const field = (hints = "", autocomplete = ""): PasswordFieldFacts => ({ hints, autocomplete });

describe("passwordRoles", () => {
  it("names a lone field a sign-in's, unless it says it is for a new password", () => {
    expect(passwordRoles([field("password")])).toEqual(["current"]);
    expect(passwordRoles([field("", "current-password")])).toEqual(["current"]);
    expect(passwordRoles([field("password", "new-password")])).toEqual(["new"]);
    expect(passwordRoles([field("create a password")])).toEqual(["new"]);
  });

  it("takes a sign-up form's two fields for a new password and its confirmation", () => {
    expect(passwordRoles([field("password"), field("password")])).toEqual(["new", "confirm"]);
    expect(passwordRoles([field("", "new-password"), field("", "new-password")])).toEqual(["new", "confirm"]);
    expect(passwordRoles([field("password"), field("confirm password")])).toEqual(["new", "confirm"]);
    expect(passwordRoles([field("pass1"), field("password2")])).toEqual(["new", "confirm"]);
    expect(passwordRoles([field("contraseña"), field("repite la contraseña")])).toEqual(["new", "confirm"]);
  });

  it("takes a change form's three fields for the current password, the new one and its confirmation", () => {
    expect(passwordRoles([field("p1"), field("p2"), field("p3")])).toEqual(["current", "new", "confirm"]);
    expect(passwordRoles([field("", "current-password"), field("", "new-password"), field("", "new-password")])).toEqual(["current", "new", "confirm"]);
    expect(passwordRoles([field("oldpassword"), field("newpassword"), field("newpassword again")])).toEqual(["current", "new", "confirm"]);
    expect(passwordRoles([field("contraseña actual"), field("nueva contraseña"), field("confirmar")])).toEqual(["current", "new", "confirm"]);
    // A site that marks every field new-password (to stop autofill) still names the current one.
    expect(passwordRoles([field("current password", "new-password"), field("new password", "new-password"), field("repeat new password", "new-password")])).toEqual(["current", "new", "confirm"]);
  });

  it("places unnamed fields around the named ones", () => {
    expect(passwordRoles([field("", "current-password"), field("x"), field("y")])).toEqual(["current", "new", "confirm"]);
    expect(passwordRoles([field("", "current-password"), field("x")])).toEqual(["current", "new"]);
    expect(passwordRoles([field("x"), field("", "new-password")])).toEqual(["current", "new"]);
    expect(passwordRoles([field("x"), field("y"), field("verify password")])).toEqual(["current", "new", "confirm"]);
    expect(passwordRoles([field("x"), field("retype it")])).toEqual(["new", "confirm"]);
  });

  it("does not take words that only contain a hint", () => {
    expect(passwordRoles([field("placeholder holder")])).toEqual(["current"]);
    expect(passwordRoles([field("bold"), field("gold")])).toEqual(["new", "confirm"]);
  });
});

describe("passwordFieldFacts", () => {
  it("reads the autocomplete and every name and label of the field, lowercased", () => {
    const input: PasswordInputElement = {
      name: "pw_new",
      id: "Password",
      labels: [{ textContent: "  New\n password " }],
      ownerDocument: { getElementById: (id) => (id === "help" ? { textContent: "At least 12 characters" } : null) },
      getAttribute: (name) => (({ autocomplete: "New-Password", "aria-labelledby": "help missing", placeholder: "Choose one" }) as Record<string, string>)[name] ?? null,
    };
    expect(passwordFieldFacts(input)).toEqual({ autocomplete: "new-password", hints: "pw_new password choose one new password at least 12 characters" });
  });
});

describe("generated password scripts", () => {
  it("are valid JavaScript with the shared role test inside, and carry the password only as data", () => {
    const box = { x: 10, y: 20, width: 200, height: 30 };
    const fill = fillGeneratedScript('a"b\\c</script>', box);
    for (const script of [fill, readPasswordFieldScript(box)]) {
      expect(() => new Function(script)).not.toThrow();
      expect(script).toContain("passwordRoles");
    }
    expect(fill).toContain(JSON.stringify('a"b\\c</script>'));
  });
});
