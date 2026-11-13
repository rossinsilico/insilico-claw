import { getStringSetting, setStringSetting } from '../native/settings-store'

const SHARING_DESTINATION = 'health.assistant.destination'

export function isHealthSharingAllowed(destination?: string | null): boolean {
  return !!destination && getStringSetting(SHARING_DESTINATION, '') === destination
}

export function setHealthSharingDestination(destination: string | null): void {
  setStringSetting(SHARING_DESTINATION, destination ?? '')
}
