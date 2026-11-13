import { type CurrentLocation } from './location-types'
export { type CurrentLocation } from './location-types'
declare const FaceclawLocation: any, FaceclawLocationUpdates: any, UIApplication: any, UIApplicationState: any

/** Main-thread one-shot lookup, independent of navigation and compass managers. */
export async function getCurrentLocation(): Promise<CurrentLocation> {
  const permission = FaceclawLocation.shared()
  if (!permission.hasPermission()) {
    if (UIApplication.sharedApplication.applicationState !== UIApplicationState.Active) {
      throw new Error('Open Faceclaw on the iPhone to allow Location access, then retry.')
    }
    const granted = await new Promise<boolean>(resolve => permission.requestPermission(resolve))
    if (!granted) throw new Error("Allow Location access in the iPhone's Settings, then retry.")
  }
  return new Promise((resolve, reject) => {
    const provider = FaceclawLocationUpdates.new()
    provider.eventHandler = (json: string) => {
      try {
        const event = JSON.parse(json)
        if (event.error) reject(new Error(event.error))
        else resolve(event)
      } catch (error) { reject(error) }
      finally { provider.stop() }
    }
    try { provider.startOnce() }
    catch (error) { provider.stop(); reject(error) }
  })
}
