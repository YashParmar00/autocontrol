import type { DevCompanionApi } from '../../shared/contracts'

declare global {
  interface Window {
    devCompanion: DevCompanionApi
  }
}

export {}
