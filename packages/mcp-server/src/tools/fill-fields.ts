import type { FieldValue, SnapshotElement } from "@corvus/shared";
import { z } from "zod";
import { truncate } from "../content.js";
import { spendGate } from "../spend-gate.js";
import { errorResult, need, optionalTabId, text, type ToolContext } from "./types.js";

const fieldValue = z.union([z.string().max(10000), z.boolean(), z.array(z.string().max(1000)).max(100)]);

const DEFAULT_SUBMIT_RE = /submit|continue|pay|save|sign\s?in|log\s?in|next|checkout|place order|confirm|send|apply|search/i;

/** Finds the element a field spec targets by role (optional) and accessible name, preferring exact matches. */
function matchField(elements: SnapshotElement[], f: { name: string; role?: string; index?: number }): SnapshotElement | undefined {
  const want = f.name.toLowerCase();
  const byRole = elements.filter((e) => !f.role || e.role === f.role);
  const exact = byRole.filter((e) => e.name.toLowerCase() === want);
  const partial = byRole.filter((e) => e.name.toLowerCase().includes(want));
  const pool = exact.length ? exact : partial;
  return pool[f.index ?? 0];
}

function submitButton(elements: SnapshotElement[], name?: string): SnapshotElement | undefined {
  const buttons = elements.filter((e) => e.role === "button" || e.role === "link");
  if (name) {
    const want = name.toLowerCase();
    return buttons.find((e) => e.name.toLowerCase() === want) ?? buttons.find((e) => e.name.toLowerCase().includes(want));
  }
  return buttons.find((e) => DEFAULT_SUBMIT_RE.test(e.name));
}

const clip = (err: unknown): string => truncate(err instanceof Error ? err.message : String(err), 200).text;

/**
 * Full access only. Fills several form fields in one call using semantic targeting (role + accessible
 * name, like click/type) instead of refs, then optionally submits. Filling and submitting go through
 * the same controller primitives as the other tools, and a submit that spends money asks the user in
 * the browser first (spendGate), so this tool adds no bypass.
 */
export function registerFillFieldsTools({ controller, register, resolveTab }: ToolContext): void {
  register(
    "fill_fields",
    {
      description: "Fill several form fields by role/name in one call; optionally submit. A submit that spends money asks the user first.",
      requires: "fill",
      inputSchema: {
        fields: z
          .array(
            z.object({
              name: z.string().min(1).max(200).describe("Accessible name/label of the field"),
              role: z.string().min(1).max(50).optional().describe("Narrow by role, e.g. textbox, checkbox, combobox"),
              index: z.number().int().min(0).max(1000).optional().describe("Which match when several share a name"),
              value: fieldValue.describe("string (text), boolean (checkbox/radio), or string[] (select)"),
            }),
          )
          .min(1)
          .max(100),
        submit: z.boolean().optional().describe("Click a submit button after filling (one that spends money asks the user first)"),
        submitName: z.string().min(1).max(200).optional().describe("Name of the button to submit with"),
        tabId: optionalTabId,
      },
    },
    async (a) => {
      const id = await resolveTab(a.tabId);
      const fill = need(controller.fill?.bind(controller), "fill_fields");
      const snap = await controller.snapshot(id, { maxChars: 0 });
      const failed: string[] = [];
      let filled = 0;
      for (const f of a.fields) {
        const el = matchField(snap.elements, f);
        if (!el) {
          failed.push(`${f.name}: no matching field`);
          continue;
        }
        try {
          await fill(id, el.ref, f.value as FieldValue);
          filled += 1;
        } catch (err) {
          failed.push(`${f.name}: ${clip(err)}`);
        }
      }

      let submitNote = "";
      if (a.submit) {
        const fresh = await controller.snapshot(id, { maxChars: 0 });
        const btn = submitButton(fresh.elements, a.submitName);
        if (!btn) {
          submitNote = "; submit skipped: no submit button found";
        } else {
          // A submit that spends money (a "Pay now" button, or any submit on a checkout page) asks first.
          const refused = await spendGate(controller, id, { kind: "form-button", name: btn.name, role: btn.role, url: fresh.url });
          if (refused) {
            const reason = refused.content.map((c) => (c.type === "text" ? c.text : "")).join("");
            return errorResult(`filled ${filled}/${a.fields.length}; not submitted. ${reason}`);
          }
          try {
            await controller.click(id, btn.ref);
            submitNote = `; submitted via "${truncate(btn.name, 60).text}"`;
          } catch (err) {
            submitNote = `; submit failed: ${clip(err)}`;
          }
        }
      }

      if (filled === 0 && a.fields.length > 0 && !a.submit) {
        return errorResult(`fill_fields filled 0/${a.fields.length}:\n${failed.join("\n")}`);
      }
      const base = `filled ${filled}/${a.fields.length}`;
      return text((failed.length ? `${base}; failed:\n${failed.join("\n")}` : base) + submitNote);
    },
  );
}
