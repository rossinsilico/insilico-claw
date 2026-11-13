/**
 * Credential-free identity of the model destination allowed to receive a
 * session's health-derived context. Null means this backend cannot receive
 * local tools or its remote endpoint is not safe to identify.
 */
export function healthDestinationForModel(llm: {
  provider: string
  model: string
  baseUrl?: string
}): string | null {
  if (typeof llm.provider !== "string" || typeof llm.model !== "string") return null
  const provider = llm.provider.trim()
  const model = llm.model.trim()
  if (!model) return null
  if (provider === "hermes") return null
  if (provider === "local" || provider === "openai" || provider === "anthropic") {
    return `${provider}:${encodeURIComponent(model)}`
  }
  if (provider !== "openai-compatible") return null
  const rawUrl = llm.baseUrl?.trim()
  if (!rawUrl) return null
  try {
    const url = new URL(rawUrl)
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null
    const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")
    return `openai-compatible:${encodeURIComponent(model)}@${url.origin}${pathname}`
  } catch {
    return null
  }
}
