export interface AdvancedSettings {
  soulPrompt: string
  customApiEnabled: boolean
  customBaseUrl: string
  customApiKey: string
  customModel: string
}

export interface AdvancedSettingsInput {
  soulPrompt?: string
  customApiEnabled?: boolean
  customBaseUrl?: string
  customApiKey?: string
  customModel?: string
  tavilyApiKey?: string
  braveApiKey?: string
}

export interface AdvancedSettingsView {
  soulPrompt: string
  customApiEnabled: boolean
  customBaseUrl: string
  customModel: string
  customApiKeyMasked?: string
  customApiKeyConfigured: boolean
  tavilyApiKeyMasked?: string
  braveApiKeyMasked?: string
}

export interface ApiTestResult {
  ok: boolean
  detail: string
}
