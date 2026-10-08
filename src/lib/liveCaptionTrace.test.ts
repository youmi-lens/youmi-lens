import { afterEach, describe, expect, it, vi } from 'vitest'
import { traceEnInterim, traceEnFinal, traceView, traceReset } from './liveCaptionTrace'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('release caption trace privacy', () => {
  it('does not log transcript content by default in production', () => {
    vi.stubEnv('DEV', false)
    vi.stubGlobal('localStorage', { getItem: () => null })
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
    traceReset()
    traceEnInterim('segment', 1, 'private lecture content')
    traceEnFinal('segment', 'private lecture content')
    traceView({ primaryBlack: '', primaryGray: 'private', secondaryBlack: '', secondaryGray: '' })
    expect(consoleInfo).not.toHaveBeenCalled()
  })
  it('retains explicit per-device diagnostic opt-in', () => {
    vi.stubEnv('DEV', false)
    vi.stubGlobal('localStorage', { getItem: () => '1' })
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
    traceEnFinal('segment', 'diagnostic sample')
    expect(consoleInfo).toHaveBeenCalled()
  })
})
