import type { OllamaStatus } from '../shared/contracts'

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

export async function checkOllama(): Promise<OllamaStatus> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2_500),
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) {
      return { connected: false, baseUrl: OLLAMA_BASE_URL, models: [], message: `Ollama returned HTTP ${response.status}.` }
    }
    const payload = await response.json() as { models?: Array<{ name?: string }> }
    const models = (payload.models ?? []).map((model) => model.name).filter((name): name is string => Boolean(name))
    return {
      connected: true,
      baseUrl: OLLAMA_BASE_URL,
      models,
      message: models.length ? `${models.length} local model${models.length === 1 ? '' : 's'} available.` : 'Ollama is running, but no models are installed yet.',
    }
  } catch {
    return {
      connected: false,
      baseUrl: OLLAMA_BASE_URL,
      models: [],
      message: 'Ollama is not reachable on this computer. Start Ollama, then retry.',
    }
  }
}
