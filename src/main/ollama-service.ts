import type { OllamaStatus } from '../shared/contracts'

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

export async function checkOllama(): Promise<OllamaStatus> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2_500),
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) {
      return { connected: false, baseUrl: OLLAMA_BASE_URL, models: [], visionModels: [], message: `Ollama returned HTTP ${response.status}.` }
    }
    const payload = await response.json() as { models?: Array<{ name?: string }> }
    const models = (payload.models ?? []).map((model) => model.name).filter((name): name is string => Boolean(name))
    const visionModels = (await Promise.all(models.map(async (name) => ((await supportsVision(name)) ? name : null)))).filter((name): name is string => Boolean(name))
    return {
      connected: true,
      baseUrl: OLLAMA_BASE_URL,
      models,
      visionModels,
      message: models.length ? `${models.length} local model${models.length === 1 ? '' : 's'} available.` : 'Ollama is running, but no models are installed yet.',
    }
  } catch {
    return {
      connected: false,
      baseUrl: OLLAMA_BASE_URL,
      models: [],
      visionModels: [],
      message: 'Ollama is not reachable on this computer. Start Ollama, then retry.',
    }
  }
}

const VISION_NAME = /(vl|vision|llava|moondream|minicpm-v|bakllava|gemma3:(4|12|27)b|qwen2\.5vl|granite3\.2-vision|llama4|mistral-small3\.1)/i

/** Ask Ollama for model capabilities (newer versions report "vision"); fall back to the name. */
export async function supportsVision(model: string): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(2_500),
    })
    if (response.ok) {
      const info = await response.json() as { capabilities?: string[] }
      if (Array.isArray(info.capabilities)) return info.capabilities.includes('vision')
    }
  } catch { /* fall through */ }
  return VISION_NAME.test(model)
}
