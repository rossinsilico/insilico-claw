import { Application, Frame, Page } from '@nativescript/core'
declare const FaceclawConfigPort: any

// Apply transferred preferences before settings getters or app workers load.
FaceclawConfigPort.processPendingRequest()
require('./health/ring-session.ios').initializeIosRingBackground()

let frame: Frame | null = null
let interactiveLoaded = false
function showInteractive(): void {
  if (!frame || interactiveLoaded || UIApplication.sharedApplication.applicationState === UIApplicationState.Background) return
  interactiveLoaded = true
  try { require('./apps/evenhub/bundled-apps').ensureBundledEvenHubApps() }
  catch (error) { console.warn(`Bundled EvenHub app install failed: ${error}`) }
  require('./phone-ui/onboarding-register.ios')
  const { hasCompletedOnboarding } = require('./phone-ui/onboarding-state') as typeof import('./phone-ui/onboarding-state')
  frame.navigate({ moduleName: hasCompletedOnboarding() ? 'phone-ui/main-page' : 'phone-ui/onboarding-page', clearHistory: true })
  setTimeout(() => require('./analytics/analytics-sources').startAppAnalytics(), 0)
}
Application.on(Application.resumeEvent, showInteractive)
Application.run({ create: () => {
  frame = new Frame()
  if (UIApplication.sharedApplication.applicationState === UIApplicationState.Background)
    frame.navigate({ create: () => new Page() })
  else showInteractive()
  return frame
} })
