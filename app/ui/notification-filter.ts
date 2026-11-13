import { getDefaultSmallFont } from "../graphics/ui-fonts";
import { GrayImage } from "../graphics/image";
import { truncateText } from "../graphics/textwrap";
import { ALL_NOTIFICATIONS, readActiveNotifications } from "../native/notification-icons";
import {
  readNotificationSources,
  setNotificationSourceEnabled,
  setNotificationSourceStatusIconEnabled,
  shouldShowNotificationOnGlasses,
  shouldShowNotificationStatusIcon,
  type NotificationSource,
} from "../native/notification-sources";
import { type InputEvent } from "./gestures";
import { type Layer, type LayerContext, type PaintBelow } from "./layers";
import { drawToggleMenuItem, MenuLayer, type MenuItem } from "./menu";

/** Refresh rows as new sources arrive, keeping the current selection by package. */
export class NotificationFilterLayer implements Layer {
  private menu: MenuLayer | null = null;
  private menuWidth = 0;
  /** The package behind each current row, parallel to the menu's items. */
  private packages: string[] = [];

  private currentMenu(ctx: LayerContext): MenuLayer {
    readActiveNotifications(ALL_NOTIFICATIONS);
    const sources = readNotificationSources().sort((a, b) =>
      a.appName.localeCompare(b.appName) || a.packageName.localeCompare(b.packageName));
    const items: MenuItem[] = sources.map((source) => ({
      label: source.appName,
      onSelect: (innerCtx) => innerCtx.stack.push(this.sourceMenu(source, innerCtx.stack.getBaseSize().width)),
    }));
    if (!items.length) items.push({ label: "No notification sources discovered yet.", disabled: true, onSelect: () => {} });
    const selectedPackage = this.menu?.selectedIndex != null ? this.packages[this.menu.selectedIndex] : undefined;
    const index = sources.findIndex((source) => source.packageName === selectedPackage);
    this.packages = sources.map((source) => source.packageName);

    const width = ctx.stack.getBaseSize().width;
    if (!this.menu || width !== this.menuWidth) {
      this.menuWidth = width;
      this.menu = new MenuLayer("App notifications", items, {
        x: 8, y: 8, width: width - 16,
        opaque: true, showBorder: false,
        footer: "Select an app to configure",
      }).selectItem(Math.max(0, index));
    } else {
      this.menu.setItems(items, index >= 0 ? index : undefined);
    }
    return this.menu;
  }

  private sourceMenu(source: NotificationSource, width: number): MenuLayer {
    const toggle = (label: string, get: () => boolean, set: (enabled: boolean) => void): MenuItem => ({
      label,
      onSelect: () => set(!get()),
      render: ({ image, x, y, width: rowWidth, selected }) => {
        const font = getDefaultSmallFont();
        drawToggleMenuItem(image, font, x, y, rowWidth, truncateText(font, label, rowWidth - 48), get(), selected);
      },
    });
    return new MenuLayer(source.appName, [
      toggle("Popups", () => shouldShowNotificationOnGlasses(source.packageName),
        (enabled) => setNotificationSourceEnabled(source, enabled)),
      toggle("Status-bar icon", () => shouldShowNotificationStatusIcon(source.packageName),
        (enabled) => setNotificationSourceStatusIconEnabled(source, enabled)),
    ], {
      x: 8, y: 8, width: width - 16,
      opaque: true, showBorder: false,
      footer: "On = show on glasses",
    });
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    return this.currentMenu(ctx).paint(ctx, paintBelow);
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    await this.currentMenu(ctx).handleInput(event, ctx);
  }
}
