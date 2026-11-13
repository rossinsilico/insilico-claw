import { Dialogs, Frame, knownFolders } from '@nativescript/core'
import { listInstalledFonts } from '../graphics/installed-fonts'
import { FONT_SIZE_CHOICES } from '../ui/font-picker'
import { fontSelectionLabel, getUiFontSelection, setUiFontSelection, uiFontSizeAllowed } from '../graphics/ui-fonts'
import { readNotificationSources } from '../native/notification-sources'
import { discoverOpenAiCompatibleModels } from '../native/openai-chat-models'
import { headUpAngleValue, headUpSettingsGeneration, refreshHeadUpAngle, setHeadUpAngle } from '../native/head-up-settings'
import { copyRemoteToken, remoteInterfaces } from '../native/remote-input'
import { isTunnelInterface } from '../remote/listeners'
import { PERMISSIONS, type Permission } from '../remote/protocol'
import { remoteInputStatus, remoteTokens } from '../remote/service'
import { remoteInterfaceSelection, selectRemoteInterface } from '../remote/service'
import { assistantOpenAiCompatibleKeySetting, assistantOpenAiCompatibleModelSetting,
  assistantOpenAiCompatibleUrlSetting } from '../ui/dashboard-settings'
import type { MenuItem } from '../ui/menu'

type Actions = { openDevices(): Promise<void>; openAdvanced(): void }

export function phoneSettingsValue(item: MenuItem): string {
  switch (item.phone?.kind) {
    case 'font': return fontSelectionLabel(getUiFontSelection())
    case 'notification-filter': {
      const count = readNotificationSources().length
      return `${count} app${count === 1 ? '' : 's'}`
    }
    case 'model-discovery': return assistantOpenAiCompatibleModelSetting.get() || 'Choose'
    case 'head-up-angle': return headUpAngleValue()
    case 'remote-input': return `${remoteTokens.list().length} token${remoteTokens.list().length === 1 ? '' : 's'}`
    case 'document': return 'Read'
    case 'devices': return 'Manage'
    case 'status': return item.phone.value()
    default: return ''
  }
}

export async function runPhoneSettingsAction(item: MenuItem, actions: Actions): Promise<boolean> {
  switch (item.phone?.kind) {
    case 'font': return editFont()
    case 'notification-filter':
      Frame.topmost()?.navigate({ moduleName: 'phone-ui/notification-settings-page' })
      return false
    case 'model-discovery': return discoverModel()
    case 'head-up-angle': return editHeadUpAngle()
    case 'remote-input': return editRemoteInput()
    case 'document': {
      let message: string
      try { message = knownFolders.currentApp().getFile(`about/${item.phone.fileName}`).readTextSync() || 'This document is missing from this build.' }
      catch { message = 'This document is missing from this build.' }
      await Dialogs.alert({ title: item.label, message, okButtonText: 'Done' })
      return false
    }
    case 'devices': await actions.openDevices(); return false
    default: return false
  }
}

async function editFont(): Promise<boolean> {
  const installed = listInstalledFonts()
  const labels = ['Terminus', 'TerminusV', ...installed.map(font => `${font.family}${font.style ? ` ${font.style}` : ''}`)]
  const picked = await Dialogs.action({ title: 'UI font', actions: labels, cancelButtonText: 'Cancel' })
  if (picked === 'Cancel' || !labels.includes(picked)) return false
  if (picked === 'Terminus' || picked === 'TerminusV') {
    setUiFontSelection({ kind: 'bitmap', face: picked === 'TerminusV' ? 'terminusv' : 'terminus' })
    return true
  }
  const font = installed[labels.indexOf(picked) - 2]
  if (!font) return false
  const sizes = FONT_SIZE_CHOICES.filter(size => uiFontSizeAllowed(font.path, size))
  const size = await Dialogs.action({ title: `${picked} size`, actions: sizes.map(String), cancelButtonText: 'Cancel' })
  const selectedSize = Number(size)
  if (!sizes.includes(selectedSize as (typeof FONT_SIZE_CHOICES)[number])) return false
  setUiFontSelection({ kind: 'ttf', file: font.fileName, size: selectedSize })
  return true
}

let modelDiscoveryGeneration = 0
let headUpEditGeneration = 0

export function cancelPhoneSettingsActions(): void {
  modelDiscoveryGeneration++
  headUpEditGeneration++
}

async function editHeadUpAngle(): Promise<boolean> {
  const edit = ++headUpEditGeneration, connection = headUpSettingsGeneration()
  const current = () => edit === headUpEditGeneration && connection === headUpSettingsGeneration()
  const angle = await refreshHeadUpAngle()
  if (!current()) return false
  if (angle === null) throw new Error('The current angle could not be read from both lenses. Reconnect and try again.')
  const answer = await Dialogs.prompt({ title: 'Head-up angle',
    message: 'Choose 0–60 degrees. A larger angle requires raising your head farther.',
    defaultText: String(angle), inputType: 'number', okButtonText: 'Save', cancelButtonText: 'Cancel' })
  if (!answer.result || !current()) return false
  const text = answer.text.trim(), value = Number(text)
  if (!/^\d+$/.test(text) || !Number.isInteger(value) || value < 0 || value > 60) {
    await Dialogs.alert({ title: 'Check this value', message: 'Choose a whole number from 0 to 60 degrees.', okButtonText: 'OK' })
    return false
  }
  await setHeadUpAngle(value, connection)
  return current()
}

async function discoverModel(): Promise<boolean> {
  const generation = ++modelDiscoveryGeneration
  const baseUrl = assistantOpenAiCompatibleUrlSetting.get(), apiKey = assistantOpenAiCompatibleKeySetting.get()
  const current = () => generation === modelDiscoveryGeneration &&
    baseUrl === assistantOpenAiCompatibleUrlSetting.get() && apiKey === assistantOpenAiCompatibleKeySetting.get()
  let showOffline = false, forceRefresh = false
  while (current()) {
    let models
    try {
      models = await discoverOpenAiCompatibleModels({ baseUrl, apiKey, ...(forceRefresh ? { forceRefresh: true } : {}) })
    } catch (error) {
      if (current()) await Dialogs.alert({ title: 'Model discovery failed', message: error instanceof Error ? error.message : String(error), okButtonText: 'OK' })
      return false
    }
    if (!current()) return false
    forceRefresh = false
    while (current()) {
      const saved = assistantOpenAiCompatibleModelSetting.get().trim()
      const listed = models.filter(model => showOffline || !model.offline || model.id === saved)
      const choices = listed.map(model => ({ model, label: modelChoiceLabel(model) }))
      if (saved && !models.some(model => model.id === saved)) {
        choices.unshift({ model: { id: saved, name: saved, supportsTools: null, offline: false, deprecated: false, beta: false },
          label: `${saved} [tools? / saved only]` })
      }
      const offlineCount = models.filter(model => model.offline).length
      const offline = showOffline ? 'Hide offline models' : `Show offline (${offlineCount})`
      const actions = [...choices.map(choice => choice.label), ...(offlineCount ? [offline] : []), 'Refresh models', 'Cancel']
      const picked = await Dialogs.action({ title: 'Discover models',
        message: 'Choose an exact model ID. Capability labels come from the provider catalog.', actions, cancelButtonText: 'Cancel' })
      if (!current()) return false
      if (picked === 'Cancel' || !picked) return false
      if (picked === offline) { showOffline = !showOffline; continue }
      if (picked === 'Refresh models') { forceRefresh = true; break }
      const choice = choices.find(candidate => candidate.label === picked)
      if (!choice) return false
      assistantOpenAiCompatibleModelSetting.set(choice.model.id)
      return true
    }
  }
  return false
}

function modelChoiceLabel(model: { id: string; name: string; supportsTools: boolean | null; offline: boolean; deprecated: boolean; beta: boolean }): string {
  const flags = [model.supportsTools === true ? 'tools' : model.supportsTools === false ? 'no tools' : 'tools?']
  if (model.offline) flags.push('offline')
  if (model.deprecated) flags.push('deprecated')
  if (model.beta) flags.push('beta')
  return `${model.name === model.id ? model.id : `${model.name} (${model.id})`} [${flags.join(' / ')}]`
}

async function editRemoteInput(): Promise<boolean> {
  const records = remoteTokens.list()
  const create = 'Create input token', interfaces = 'Listening interfaces', info = 'Connection information'
  const recordChoices = records.map(record => ({ record, label: `${record.name} · ${record.id}` }))
  const picked = await Dialogs.action({ title: 'Input tokens',
    actions: [create, interfaces, info, ...recordChoices.map(choice => choice.label), 'Cancel'], cancelButtonText: 'Cancel' })
  if (picked === create) {
    const name = await Dialogs.prompt({ title: create, message: 'This token can provide ring/watch input. Save the secret now; it cannot be recovered later.',
      defaultText: 'My app', okButtonText: 'Create', cancelButtonText: 'Cancel' })
    if (!name.result || !name.text.trim()) return false
    const { token } = remoteTokens.create(name.text.trim().slice(0, 80), ['input'])
    copyRemoteToken(token)
    await Dialogs.alert({ title: 'Save your token now', message: `${token}\n\nCopied to the phone clipboard. The secret cannot be recovered after closing this message.`, okButtonText: 'Done' })
    return true
  }
  if (picked === interfaces) return editRemoteInterfaces()
  if (picked === info) {
    await Dialogs.alert({ title: info, message: remoteInputStatus(), okButtonText: 'Done' })
    return false
  }
  if (picked === 'Cancel') return false
  const record = recordChoices.find(choice => choice.label === picked)?.record
  if (!record) return false
  const labels: Record<Permission, string> = { input: 'Provide input', text: 'Text to foreground window', assistant: 'Text to voice assistant' }
  const permissionRows = PERMISSIONS.map(permission => `${record.permissions.includes(permission) ? 'On' : 'Off'} · ${labels[permission]}`)
  const revoke = 'Revoke token'
  const change = await Dialogs.action({ title: record.name, actions: [...permissionRows, revoke, 'Cancel'], cancelButtonText: 'Cancel' })
  if (change === 'Cancel') return false
  if (change === revoke) {
    if (!await Dialogs.confirm({ title: `Revoke ${record.name}?`, message: 'The token will stop working on its next request.', okButtonText: 'Revoke', cancelButtonText: 'Cancel' })) return false
    remoteTokens.revoke(record.id)
    return true
  }
  const permission = PERMISSIONS[permissionRows.indexOf(change)]
  if (!permission) return false
  remoteTokens.permissions(record.id, record.permissions.includes(permission)
    ? record.permissions.filter(value => value !== permission) : [...record.permissions, permission])
  return true
}

async function editRemoteInterfaces(): Promise<boolean> {
  const names = [...new Set(remoteInterfaces().filter(isTunnelInterface).map(item => item.name))]
  const choices = [
    { value: 'tailscale', label: 'Localhost + Tailscale (auto)' },
    { value: 'localhost', label: 'Localhost / USB only' },
    ...names.map(name => ({ value: `interface:${name}`, label: name })),
  ]
  const labels = choices.map(choice => `${remoteInterfaceSelection() === choice.value ? 'Selected' : 'Use'} · ${choice.label}`)
  const picked = await Dialogs.action({ title: 'Listening interfaces', actions: labels, cancelButtonText: 'Cancel' })
  const choice = choices[labels.indexOf(picked)]
  if (!choice) return false
  selectRemoteInterface(choice.value)
  return true
}
