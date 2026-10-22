import { z } from "zod";
import { compactJson } from "../content.js";
import { need, OK, optionalTabId, text, untrusted, type ToolContext } from "./types.js";

export function registerTabTools({ controller, register, resolveTab }: ToolContext): void {
  register(
    "tab_wait_load",
    {
      description: "Wait until a tab finishes loading.",
      inputSchema: { timeoutMs: z.number().int().min(100).max(120_000).default(15_000), tabId: optionalTabId },
      readOnly: true,
    },
    async (a) => {
      const id = await resolveTab(a.tabId);
      const tab = await need(controller.waitForLoad?.bind(controller), "tab_wait_load")(id, a.timeoutMs);
      return untrusted(tab.url, compactJson({ id: tab.id, url: tab.url, title: tab.title, loading: tab.loading }));
    },
  );

  register(
    "zoom",
    { description: "Set page zoom (1 = 100%).", inputSchema: { factor: z.number().min(0.25).max(5), tabId: optionalTabId } },
    async (a) => {
      const zoom = await need(controller.setZoom?.bind(controller), "zoom")(await resolveTab(a.tabId), a.factor);
      return text(`zoom: ${zoom}`);
    },
  );

  register(
    "set_viewport",
    {
      description: "Emulate a viewport size (e.g. mobile 390x844), or reset to the window size.",
      inputSchema: {
        width: z.number().int().min(200).max(4000).optional(),
        height: z.number().int().min(200).max(4000).optional(),
        deviceScaleFactor: z.number().min(0.5).max(4).optional(),
        mobile: z.boolean().optional(),
        reset: z.boolean().optional().describe("Remove the emulation"),
        tabId: optionalTabId,
      },
    },
    async (a) => {
      const set = need(controller.setViewport?.bind(controller), "set_viewport");
      const id = await resolveTab(a.tabId);
      if (a.reset) {
        await set(id, null);
        return OK;
      }
      if (!a.width || !a.height) throw new Error("Pass width and height, or reset: true");
      await set(id, {
        width: a.width,
        height: a.height,
        ...(a.deviceScaleFactor !== undefined ? { deviceScaleFactor: a.deviceScaleFactor } : {}),
        ...(a.mobile !== undefined ? { mobile: a.mobile } : {}),
      });
      return OK;
    },
  );
}
