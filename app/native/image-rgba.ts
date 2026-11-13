import { toUint8Array } from '../util/array-util'
import { copyToJavaByteBuffer } from './java-direct-buffer'
import { rgbaFromPacket } from './image-rgba-packet'
export { rgbaFromPacket } from './image-rgba-packet'
declare const com: any

/** Decoded RGBA (not premultiplied) of encoded image bytes, or null when undecodable. */
export function decodeImageRgba(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
  try {
    return rgbaFromPacket(toUint8Array(com.faceclaw.app.ImageFileLoader.decodeRgbaFromBytes(copyToJavaByteBuffer(bytes))))
  } catch (error) {
    console.warn(`decodeImageRgba failed: ${error}`)
    return null
  }
}
