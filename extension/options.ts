import { DEFAULT_HELPER_ENDPOINT, type StoredHelperSettings } from './shared/types'
import {
  parseOptionsFormState,
  toRuntimeCandidateSearchSettings,
  toRuntimeDisplaySettings,
  toRuntimeSettings,
  type StoredSettingsBundle,
} from './options/settings'
import './options.css'

const endpointInput = document.querySelector<HTMLInputElement>('#endpoint')!
const tokenInput = document.querySelector<HTMLInputElement>('#token')!
const enabledInput = document.querySelector<HTMLInputElement>('#enabled')!
const manualOnlyInput = document.querySelector<HTMLInputElement>('#manualOnly')!
const candidateSearchEnabledInput = document.querySelector<HTMLInputElement>('#candidateSearchEnabled')!
const resultDisplayModeInput = document.querySelector<HTMLSelectElement>('#resultDisplayMode')!
const openBehaviorInput = document.querySelector<HTMLSelectElement>('#openBehavior')!
const inlineOverlayEnabledInput = document.querySelector<HTMLInputElement>('#inlineOverlayEnabled')!
const grayQrOnResultInput = document.querySelector<HTMLInputElement>('#grayQrOnResult')!
const showHelperStatusInResultInput = document.querySelector<HTMLInputElement>('#showHelperStatusInResult')!
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
    'smartExtractCandidateSearchEnabled',
    'resultDisplayMode',
    'openBehavior',
    'inlineOverlayEnabled',
    'grayQrOnResult',
    'showHelperStatusInResult',
  ])) as Partial<Record<string, unknown>> as Partial<StoredSettingsBundle>
  const settings = toRuntimeSettings(stored)
  const displaySettings = toRuntimeDisplaySettings(stored)
  const candidateSearch = toRuntimeCandidateSearchSettings(stored)
  endpointInput.value = settings.endpoint || DEFAULT_HELPER_ENDPOINT
  tokenInput.value = settings.token
  enabledInput.checked = settings.enabled
  manualOnlyInput.checked = settings.manualOnly
  candidateSearchEnabledInput.checked = candidateSearch.candidateSearchEnabled
  resultDisplayModeInput.value = displaySettings.resultDisplayMode
  openBehaviorInput.value = displaySettings.openBehavior
  inlineOverlayEnabledInput.checked = displaySettings.inlineOverlayEnabled
  grayQrOnResultInput.checked = displaySettings.grayQrOnResult
  showHelperStatusInResultInput.checked = displaySettings.showHelperStatusInResult
  setStatus('已载入设置')
}

async function save() {
  const parsed = parseOptionsFormState({
    endpoint: endpointInput.value,
    token: tokenInput.value,
    enabled: enabledInput.checked,
    manualOnly: manualOnlyInput.checked,
    resultDisplayMode: resultDisplayModeInput.value as 'inline' | 'toast' | 'both',
    openBehavior: openBehaviorInput.value as 'new-tab' | 'same-tab',
    inlineOverlayEnabled: inlineOverlayEnabledInput.checked,
    grayQrOnResult: grayQrOnResultInput.checked,
    showHelperStatusInResult: showHelperStatusInResultInput.checked,
    candidateSearchEnabled: candidateSearchEnabledInput.checked,
  })
  await chrome.storage.local.set(parsed as StoredSettingsBundle)
  endpointInput.value = parsed.smartExtractEndpoint
  tokenInput.value = parsed.smartExtractToken
  resultDisplayModeInput.value = parsed.resultDisplayMode
  openBehaviorInput.value = parsed.openBehavior
  inlineOverlayEnabledInput.checked = parsed.inlineOverlayEnabled
  grayQrOnResultInput.checked = parsed.grayQrOnResult
  showHelperStatusInResultInput.checked = parsed.showHelperStatusInResult
  candidateSearchEnabledInput.checked = parsed.smartExtractCandidateSearchEnabled
  setStatus('已保存')
}

async function testConnection() {
  const parsed = parseOptionsFormState({
    endpoint: endpointInput.value,
    token: tokenInput.value,
    enabled: enabledInput.checked,
    manualOnly: manualOnlyInput.checked,
    resultDisplayMode: resultDisplayModeInput.value as 'inline' | 'toast' | 'both',
    openBehavior: openBehaviorInput.value as 'new-tab' | 'same-tab',
    inlineOverlayEnabled: inlineOverlayEnabledInput.checked,
    grayQrOnResult: grayQrOnResultInput.checked,
    showHelperStatusInResult: showHelperStatusInResultInput.checked,
    candidateSearchEnabled: candidateSearchEnabledInput.checked,
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
