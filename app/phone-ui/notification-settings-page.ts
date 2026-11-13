import { Frame, Observable, type ItemEventData, type NavigatedData, type Page } from '@nativescript/core'
import { readNotificationSources, type NotificationSource } from '../native/notification-sources'

export type NotificationSourceRow = NotificationSource & {
  summary: string
  packageLabel: string
  packageVisibility: 'visible' | 'collapse'
  accessibilityLabel: string
}

export function notificationSourceSummary(source: NotificationSource): string {
  if (source.showOnGlasses) return source.showStatusIcon ? 'Popups and icon' : 'Popups only'
  return source.showStatusIcon ? 'Icon only' : 'Off'
}

export function notificationSourceRows(sources: NotificationSource[]): NotificationSourceRow[] {
  const nameCounts = new Map<string, number>()
  for (const source of sources) nameCounts.set(source.appName, (nameCounts.get(source.appName) ?? 0) + 1)
  return sources.map(source => {
    const summary = notificationSourceSummary(source)
    const duplicateName = (nameCounts.get(source.appName) ?? 0) > 1
    const packageVisibility = duplicateName ? 'visible' as const : 'collapse' as const
    return {
      ...source,
      summary,
      packageLabel: duplicateName ? source.packageName : '',
      packageVisibility,
      accessibilityLabel: [source.appName, duplicateName ? source.packageName : '', summary].filter(Boolean).join(', '),
    }
  }).sort((a, b) => a.appName.localeCompare(b.appName) || a.packageName.localeCompare(b.packageName))
}

export class NotificationSettingsViewModel extends Observable {
  sources: NotificationSourceRow[] = []
  emptyVisibility = 'collapse'

  constructor() {
    super()
    this.refresh()
  }

  refresh(): void {
    const sources = notificationSourceRows(readNotificationSources())
    this.set('sources', sources)
    this.set('emptyVisibility', sources.length ? 'collapse' : 'visible')
  }

  onSourceTap = (args: ItemEventData): void => {
    const source = this.sources[args.index]
    if (source) Frame.topmost()?.navigate({
      moduleName: 'phone-ui/notification-source-settings-page',
      context: { packageName: source.packageName },
    })
  }
}

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page
  const model = page.bindingContext as NotificationSettingsViewModel | undefined
  if (model) model.refresh()
  else page.bindingContext = new NotificationSettingsViewModel()
}
