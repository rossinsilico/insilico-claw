import { Observable, type NavigatedData, type Page, type PropertyChangeData } from '@nativescript/core'
import { readNotificationSources, setNotificationSourceEnabled, setNotificationSourceStatusIconEnabled,
  type NotificationSource } from '../native/notification-sources'
import { newNotificationDisplaySetting } from '../ui/dashboard-settings'

type NotificationSourceContext = { packageName?: string } | undefined

export class NotificationSourceSettingsViewModel extends Observable {
  readonly appName: string
  readonly packageName: string
  readonly popupAccessibilityLabel: string
  readonly iconAccessibilityLabel: string
  readonly globalPopupNote: string
  readonly globalPopupNoteVisibility: 'visible' | 'collapse'
  popupsEnabled: boolean
  statusIconEnabled: boolean
  private source: NotificationSource

  constructor(source: NotificationSource) {
    super()
    this.source = source
    this.appName = source.appName
    this.packageName = source.packageName
    this.popupsEnabled = source.showOnGlasses
    this.statusIconEnabled = source.showStatusIcon
    this.popupAccessibilityLabel = `Popups for ${source.appName}`
    this.iconAccessibilityLabel = `Status-bar icon for ${source.appName}`
    const globallyOff = newNotificationDisplaySetting.get() === 'off'
    this.globalPopupNote = globallyOff
      ? 'Popups are off for all apps in Display new notifications. This choice applies when popups are turned back on.'
      : ''
    this.globalPopupNoteVisibility = globallyOff ? 'visible' : 'collapse'
  }

  onPopupsChanged = (args: PropertyChangeData): void => {
    const enabled = Boolean(args.value)
    if (enabled === this.source.showOnGlasses) return
    setNotificationSourceEnabled(this.source, enabled)
    this.source = { ...this.source, showOnGlasses: enabled }
  }

  onStatusIconChanged = (args: PropertyChangeData): void => {
    const enabled = Boolean(args.value)
    if (enabled === this.source.showStatusIcon) return
    setNotificationSourceStatusIconEnabled(this.source, enabled)
    this.source = { ...this.source, showStatusIcon: enabled }
  }
}

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page
  if (page.bindingContext) return
  const packageName = (args.context as NotificationSourceContext)?.packageName
  const source = readNotificationSources().find(item => item.packageName === packageName)
  if (source) page.bindingContext = new NotificationSourceSettingsViewModel(source)
}
