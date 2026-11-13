import { isAppleHealthAvailable, readAppleHealthSummary } from '../native/apple-health'
import { isHealthSharingAllowed } from './health-access'
import type { ToolRegistry } from './tool-registry'

export function registerHealthTools(registry: ToolRegistry): void {
  if (!isAppleHealthAvailable()) return
  registry.registerSystemTool({
    name: 'health.apple_summary',
    description: 'Read a limited Apple Health summary for today or yesterday after the user has enabled health sharing in Pilot on their iPhone. Missing metrics do not establish that no measurements exist. HRV is SDNN. Use only when asked about health.',
    inputSchema: { type: 'object', properties: { day: { type: 'string', enum: ['today', 'yesterday'] } }, required: ['day'], additionalProperties: false },
    timeoutMs: 10_000,
  }, async (args, context) => {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 ||
      (args.day !== 'today' && args.day !== 'yesterday')) return { ok: false, error: 'Specify only day: today or yesterday.' }
    if (!isHealthSharingAllowed(context?.healthDestination)) return { ok: false, error: 'Enable health sharing for this assistant in Pilot’s Health tab on your iPhone first.' }
    try {
      const summary = await readAppleHealthSummary(args.day, context?.signal)
      // Consent may have been revoked while the native query was running.
      if (context?.signal?.aborted || !isHealthSharingAllowed(context?.healthDestination)) return { ok: false, error: 'Health access was cancelled or sharing was disabled.' }
      return { ok: true, content: JSON.stringify(summary) }
    } catch {
      return { ok: false, error: 'Apple Health could not be read. Check Health permissions and unlock your iPhone, then try again.' }
    }
  })
}
