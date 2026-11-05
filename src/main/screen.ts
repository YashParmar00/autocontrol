import { BrowserWindow, desktopCapturer, screen } from 'electron'

/**
 * Captures the display under the mouse cursor as JPEG base64.
 * Our own windows use setContentProtection(true), so on Windows/macOS the app itself
 * (chat, approvals, vault) shows up black in the capture instead of being sent to the model.
 * Screenshots are kept in memory only and never written to disk.
 */
export async function captureScreen(maxWidth = 1600): Promise<string> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const scale = Math.min(1, maxWidth / (display.size.width * display.scaleFactor))
  const width = Math.round(display.size.width * display.scaleFactor * scale)
  const height = Math.round(display.size.height * display.scaleFactor * scale)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
  const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('Screen capture failed. On macOS allow Screen Recording; on Windows check privacy settings.')
  }
  return source.thumbnail.toJPEG(72).toString('base64')
}

export function protectWindowsFromCapture(): void {
  for (const window of BrowserWindow.getAllWindows()) window.setContentProtection(true)
}
