import { DEFAULT_HELPER_ENDPOINT, type StoredHelperSettings } from './shared/types'
import { parseOptionsFormState, toRuntimeSettings } from './options/settings'
import './options.css'

const endpointInput = document.querySelector<HTMLInputElement>('#endpoint')!
const tokenInput = document.querySelector<HTMLInputElement>('#token')!
const enabledInput = document.querySelector<HTMLInputElement>('#enabled')!
const manualOnlyInput = document.querySelector<HTMLInputElement>('#manualOnly')!
const saveButton = document.querySelector<HTMLButtonElement>('#save')!
const testButton = document.querySelector<HTMLButtonElement>('#test')!
const statusBox = document.querySelector<HTMLPreElement>('#status')!

void load()
saveButton.addEventListener('click', () => void save())
testButton.addEventListener('click', () => void testConnection())

async function load() {
  const stored = (await chrome.storage.local.get([
    'smartExtractEndpoint',
    'smartExtractToken',
    'smartExtractEnabled',
    'smartExtractManualOnly',
  ])) as Partial<StoredHelperSettings>
  const settings = toRuntimeSettings(stored)
  endpointInput.value = settings.endpoint || DEFAULT_HELPER_ENDPOINT
  tokenInput.value = settings.token
  enabledInput.checked = settings.enabled
  manualOnlyInput.checked = settings.manualOnly
  setStatus('已载入设置')
}

async function save() {
  const parsed = parseOptionsFormState({
    endpoint: endpointInput.value,
    token: tokenInput.value,
    enabled: enabledInput.checked,
    manualOnly: manualOnlyInput.checked,
  })
  await chrome.storage.local.set(parsed)
  endpointInput.value = parsed.smartExtractEndpoint
  tokenInput.value = parsed.smartExtractToken
  setStatus('已保存')
}

async function testConnection() {
  const parsed = parseOptionsFormState({
    endpoint: endpointInput.value,
    token: tokenInput.value,
    enabled: enabledInput.checked,
    manualOnly: manualOnlyInput.checked,
  })
  const headers: Record<string, string> = {}
  if (parsed.smartExtractToken) headers.authorization = `Bearer ${parsed.smartExtractToken}`
  try {
    const response = await fetch(`${parsed.smartExtractEndpoint}/healthz`, { headers })
    const text = await response.text()
    setStatus(response.ok ? `连接成功: HTTP ${response.status}\n${text}` : `连接失败: HTTP ${response.status}\n${text}`)
  } catch (err) {
    setStatus(`连接失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function setStatus(text: string) {
  statusBox.textContent = text
}
