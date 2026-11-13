import { readUpcomingEventsAsync, type CalendarEvent } from "../native/calendar";
import { hasCalendarPermission } from "../native/calendar-permissions";
import { getCurrentLocation } from "../native/location";
import { mediaControllerBridge } from "../native/media-controller";
import { spotifyService } from "../native/spotify";
import {
  ALL_NOTIFICATIONS,
  dismissNotification,
  isNotificationRelayReady,
  notificationRelayMessage,
  readActiveNotifications,
} from "../native/notification-icons";
import { shell } from "../ui/shell/shell";
import { toolRegistry, type ToolRegistry, type ToolResult } from "./tool-registry";
import { registerHealthTools } from "./health-tools";

/**
 * Registers the always-available system tools into the registry. Called once at
 * startup. These wrap shell state and the existing native bridges (calendar,
 * media, notifications); nothing here needs an app window to be open.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let registered = false;

export function registerSystemTools(registry: ToolRegistry = toolRegistry): void {
  if (registered) return;
  registered = true;
  if (global.isIOS) registerHealthTools(registry);

  // Keep a media listener warm so "what's playing" works without opening Music.
  void mediaControllerBridge.start();

  registry.registerSystemTool(
    {
      name: "location.current",
      description: "Get one current location fix from this phone's GPS, including accuracy and timestamp.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      try {
        const location = await getCurrentLocation();
        return ok(JSON.stringify({ ...location, source: "phone-gps" }));
      } catch (error) {
        return err(`Phone location unavailable: ${String((error as Error)?.message ?? error)}`);
      }
    },
  );

  registry.registerSystemTool(
    {
      name: "glasses.get_state",
      description:
        "Get the current state of the glasses: display on/off, foreground app, headset battery, and the current local time.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    () => ok(describeState()),
  );

  registry.registerSystemTool(
    {
      name: "glasses.show_alert",
      description:
        "Show a short text popup on the glasses display. Use for a brief notice the user should see; keep it to a sentence or two.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "The message to display." } },
        required: ["text"],
        additionalProperties: false,
      },
      proactive: true,
    },
    (args) => {
      const text = String(args?.text ?? "").trim();
      if (!text) return err("show_alert requires non-empty text");
      shell.showAlert(text);
      return ok("Displayed.");
    },
  );

  registry.registerSystemTool(
    {
      name: "calendar.list_events",
      description:
        "List the user's upcoming calendar events. Returns events from now forward, ordered by start time.",
      inputSchema: {
        type: "object",
        properties: {
          within_hours: {
            type: "number",
            description: "Only include events starting within this many hours (default 168 = one week).",
          },
          max_events: { type: "number", description: "Maximum number of events to return (default 10)." },
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      if (!hasCalendarPermission()) return err("Calendar access is not granted. Open Calendar or Permissions on your phone to allow access.");
      const withinHours = clampNumber(args?.within_hours, 1, 24 * 60, 168);
      const maxEvents = clampNumber(args?.max_events, 1, 50, 10);
      try {
        const events = await readUpcomingEventsAsync(maxEvents, withinHours * 60 * 60 * 1000);
        if (!events.length) return ok("No upcoming events in that window.");
        return ok(events.map(formatEvent).join("\n"));
      } catch {
        return err("Calendar events could not be read. Check calendar access on your phone and try again.");
      }
    },
  );

  registry.registerSystemTool(
    {
      name: "media.now_playing",
      description: "What is currently playing (or paused) in the user's media app, if anything.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    async () => {
      // Spotify's state is polled only while something shows it.
      await mediaControllerBridge.refresh?.();
      return ok(describeNowPlaying());
    },
  );

  registry.registerSystemTool(
    {
      name: "media.play_pause",
      description: "Toggle play/pause for the user's current media session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      await mediaControllerBridge.refresh?.();
      const state = mediaControllerBridge.snapshot();
      if (!state.canPlayPause) return err("No media session can be controlled right now.");
      await mediaControllerBridge.playPause();
      return ok("Toggled play/pause.");
    },
  );

  registry.registerSystemTool(
    {
      name: "media.next",
      description: "Skip to the next track in the user's current media session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      await mediaControllerBridge.refresh?.();
      const state = mediaControllerBridge.snapshot();
      if (!state.canSkipNext) return err("The current media session can't skip to the next track.");
      await mediaControllerBridge.skipNext();
      return ok("Skipped to the next track.");
    },
  );

  const spotify = spotifyService();
  if (spotify) {
    registry.register({
      spec: {
        name: "media.spotify_play",
        description:
          "Search Spotify and start playing the best match on the user's Spotify (this phone or another of their Spotify devices). Use for requests like \"play Daft Punk\" (artist), \"play the album Discovery\" (album) or \"play Harder Better Faster Stronger\" (track).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for, e.g. an artist, album, song or playlist name." },
            kind: {
              type: "string",
              enum: ["track", "album", "artist", "playlist"],
              description: "What kind of thing to play (default track).",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        availability: "always",
        // Search, then play (with a device lookup when none is active).
        timeoutMs: 20_000,
      },
      handler: async (args) => {
        const query = String(args?.query ?? "").trim();
        if (!query) return err("media.spotify_play requires a query");
        const kind = ["track", "album", "artist", "playlist"].includes(args?.kind) ? args.kind : "track";
        try {
          return ok(`Playing ${await spotify.playSearch(query, kind)} on Spotify.`);
        } catch (error) {
          return err(String((error as Error)?.message ?? error));
        }
      },
      // Offered once signed in from the Music app menu.
      isAvailable: () => spotify.account() !== null,
    });
  }

  // iOS matches AncsClient's MAX_ACTIVE cache capacity; Android keeps its existing bound.
  const notificationLimit = global.isIOS ? 128 : 50;
  registry.registerSystemTool(
    {
      name: "notifications.list",
      description: global.isIOS
        ? "List the user's current iPhone notifications relayed to Faceclaw on the glasses, with listed/total counts and hasMore. When the user explicitly asks to hide all current notifications, use max 128 and pass all returned keys in one notifications.dismiss batch. For a subset request, target only that subset."
        : "List the user's current Android notifications mirrored to the glasses.",
      inputSchema: {
        type: "object",
        properties: { max: { type: "number", minimum: 1, maximum: notificationLimit,
          description: `Maximum notifications to return (default 10, limit ${notificationLimit}).` } },
        additionalProperties: false,
      },
    },
    (args) => {
      if (global.isIOS && !isNotificationRelayReady()) return err(notificationRelayMessage());
      const max = clampNumber(args?.max, 1, notificationLimit, 10);
      const all = readActiveNotifications(ALL_NOTIFICATIONS);
      const notifications = all.slice(0, max);
      const counts = JSON.stringify({ listed: notifications.length, total: all.length, hasMore: notifications.length < all.length });
      return ok(`${counts}\n${notifications.length ? notifications.map(formatNotification).join("\n") : "No current notifications."}`);
    },
  );

  registry.registerSystemTool(
    {
      name: "notifications.dismiss",
      description: global.isIOS
        ? "Hide iPhone notifications from Faceclaw on the glasses. When explicitly asked to hide all current notifications, list with max 128 and pass all returned keys in one keys array (up to 128). For a subset request, target only that subset. Use key for one notification. The batch receipt reports remaining current notifications; do not claim the tray is empty unless remaining is zero. This does not dismiss them from iPhone Notification Center or perform a notification action."
        : "Dismiss notifications by keys returned by notifications.list. For multiple notifications, pass all their listed keys in one keys array (up to 50), not separate tool calls. Use key for one notification. Reports completed and missing notifications.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", minLength: 1, description: "One notification key from notifications.list; omit when using keys." },
          keys: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: notificationLimit, uniqueItems: true,
            description: "All explicitly requested notification keys from notifications.list, in one batch; omit key." },
        },
        // Codex closes required-only oneOf branches; enforce key/keys exclusivity in the handler.
        additionalProperties: false,
      },
    },
    (args) => {
      if (!args || typeof args !== "object" || Array.isArray(args) ||
          Object.keys(args).some(name => name !== "key" && name !== "keys")) {
        return err("notifications.dismiss requires either key or keys");
      }
      const batch = Object.prototype.hasOwnProperty.call(args, "keys");
      if (batch === Object.prototype.hasOwnProperty.call(args, "key")) {
        return err("notifications.dismiss requires exactly one of key or keys");
      }
      const rawKeys = batch ? args.keys : [args.key];
      if (!Array.isArray(rawKeys) || rawKeys.length < 1 || rawKeys.length > notificationLimit ||
          rawKeys.some(key => typeof key !== "string" || !key.trim())) {
        return err(`notifications.dismiss requires 1 to ${notificationLimit} non-empty string keys`);
      }
      const keys: string[] = rawKeys.map(key => key.trim());
      if (new Set(keys).size !== keys.length) return err("notifications.dismiss requires unique keys");
      if (global.isIOS && !isNotificationRelayReady()) return err(notificationRelayMessage());
      if (batch) {
        const notFound = keys.filter(key => !dismissNotification(key));
        return ok(JSON.stringify({ action: global.isIOS ? "hidden_from_faceclaw" : "dismissed",
          requested: keys.length, completed: keys.length - notFound.length, notFound,
          remaining: readActiveNotifications(ALL_NOTIFICATIONS).length }));
      }
      const key = keys[0];
      if (!dismissNotification(key)) return err(global.isIOS
        ? "No notification with that key in Faceclaw."
        : "No notification with that key.");
      return ok(global.isIOS ? "Hidden from Faceclaw on the glasses." : "Dismissed.");
    },
  );
}

function describeState(): string {
  const parts: string[] = [];
  parts.push(`Display: ${shell.isScreenOn() ? "on" : "off"}.`);
  const fg = shell.getForegroundApp();
  parts.push(fg ? `Foreground app: ${fg.appId} ("${fg.title}").` : "Foreground: launcher (no app open).");
  const battery = shell.getBatteryLevels();
  if (battery.headset !== null) {
    const charging = battery.headsetCharging ? ", charging" : "";
    parts.push(`Headset battery: ${battery.headset}%${charging}.`);
  }
  if (battery.case !== null) {
    // caseCharging is null while the glasses are out of the case: the level is the last one seen.
    const detail = battery.caseCharging === null ? " (last reading, glasses not in the case)"
      : battery.caseCharging ? ", charging" : "";
    parts.push(`Charging case battery: ${battery.case}%${detail}.`);
  }
  parts.push(`Local time: ${formatDateTime(new Date())}.`);
  return parts.join(" ");
}

function describeNowPlaying(): string {
  const state = mediaControllerBridge.snapshot();
  if (!state.accessEnabled) return `Media state is unavailable (${mediaControllerBridge.accessLabel.toLowerCase()}).`;
  if (state.playbackState === "playing" || state.playbackState === "paused") {
    const verb = state.playbackState === "playing" ? "Playing" : "Paused";
    const title = state.title || "(unknown title)";
    const artist = state.artist ? ` by ${state.artist}` : "";
    const app = state.appName ? ` in ${state.appName}` : "";
    return `${verb}: ${title}${artist}${app}.`;
  }
  return "Nothing is currently playing.";
}

function formatEvent(event: CalendarEvent): string {
  const when = event.allDay ? `${formatDate(new Date(event.startMs))} (all day)` : formatDateTime(new Date(event.startMs));
  const location = event.location ? ` @ ${event.location}` : "";
  return `- ${event.title || "(untitled)"} — ${when}${location}`;
}

function formatNotification(notification: { key: string; appName: string; title: string; text: string; customText?: string[] }): string {
  const title = notification.title || notification.customText?.join(" ") || "(no title)";
  const body = notification.text ? `: ${notification.text}` : "";
  return `- [${notification.appName}] ${title}${body} (key: ${notification.key})`;
}

function formatDateTime(date: Date): string {
  return `${formatDate(date)}, ${formatTime(date)}`;
}

function formatDate(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

function formatTime(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const meridiem = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${meridiem}`;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function ok(content: string): ToolResult {
  return { ok: true, content };
}

function err(error: string): ToolResult {
  return { ok: false, error };
}
