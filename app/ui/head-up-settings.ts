import { TextViewerLayer } from "../apps/files/text-viewer";
import { getDefaultSmallFont } from "../graphics/ui-fonts";
import {
  headUpAngleValue,
  headUpSettingsGeneration,
  isHeadUpSettingsAvailable,
  refreshHeadUpAngle,
  setHeadUpAngle,
} from "../native/head-up-settings";
import { type LayerContext } from "./layers";
import { drawRightValueMenuItem, openModalMenu, type MenuItem } from "./menu";

function showHeadUpError(ctx: LayerContext, error: unknown): void {
  const message = String((error as Error)?.message || error || "Could not update Head-up angle.");
  ctx.stack.push(new TextViewerLayer(message, "Head-up angle"));
}

export function headUpAngleMenuItem(): MenuItem {
  return {
    label: "Angle",
    description: "The upward head angle that turns the display on, from 0\u00b0 to 60\u00b0.",
    disabled: () => !isHeadUpSettingsAvailable(),
    phone: { kind: "head-up-angle" },
    onSelect: async (ctx) => {
      const generation = headUpSettingsGeneration();
      let current: number | null;
      try {
        current = await refreshHeadUpAngle();
      } catch (error) {
        showHeadUpError(ctx, error);
        return;
      }
      if (current === null) {
        showHeadUpError(ctx, "Could not read the Head-up angle from the glasses.");
        return;
      }
      const items = Array.from({ length: 61 }, (_, angle): MenuItem => ({
        label: `${angle}\u00b0`,
        onSelect: async (pickerCtx) => {
          try {
            await setHeadUpAngle(angle, generation);
            pickerCtx.stack.pop();
          } catch (error) {
            showHeadUpError(pickerCtx, error);
          }
        },
      }));
      openModalMenu(ctx, "Angle", items, current);
    },
    render: ({ image, x, y, width }) => {
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, "Angle", headUpAngleValue());
    },
  };
}
