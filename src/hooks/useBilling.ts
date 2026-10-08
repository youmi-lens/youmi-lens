/**
 * React billing hook + testable controller (Commercialization V2 · Phase 2B-1).
 *
 * Loads authoritative subscription + quota, exposes upgrade/manage that only
 * open backend-returned URLs. Never activates entitlement from client signals.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../useAuth'
import {
  BillingApiError,
  createCheckout,
  getQuotaStatus,
  getSubscriptionStatus,
  openPortal,
  refreshSubscription,
  type BillingPlanCode,
  type QuotaStatusPayload,
  type SubscriptionRecord,
} from '../lib/billing/billingClient'
import { deriveBillingState, type BillingState } from '../lib/billing/billingState'
import { openExternalUrl } from '../lib/openExternalContact'
import { hasPendingBillingReturn } from '../lib/billing/billingReturnCoordinator'

/**
 * Regaining focus re-reads plan + quota (read-only GETs) so a purchase made elsewhere — e.g. on iPad while
 * Desktop stayed open — appears without a relaunch. Bounded: at most one focus-triggered read per window,
 * never while another read or a billing action is in flight.
 */
export const FOCUS_REFRESH_MIN_INTERVAL_MS = 30_000

export type BillingHookError = {
  kind: BillingApiError['kind'] | 'unknown'
  message: string
  code: string | null
  status: number | null
}

export type BillingActions = {
  load: () => Promise<void>
  refresh: () => Promise<void>
  upgrade: (planCode: BillingPlanCode) => Promise<void>
  manage: () => Promise<void>
}

export type UseBillingResult = {
  state: BillingState
  loading: boolean
  error: BillingHookError | null
  actions: BillingActions
  /** Sync read of normalized status from the controller (post-await safe). */
  getStatus: () => BillingState['status']
}

export type BillingControllerDeps = {
  getSubscriptionStatus?: typeof getSubscriptionStatus
  getQuotaStatus?: typeof getQuotaStatus
  refreshSubscription?: typeof refreshSubscription
  createCheckout?: typeof createCheckout
  openPortal?: typeof openPortal
  openExternalUrl?: typeof openExternalUrl
  /** Test seam for the focus-refresh throttle. */
  now?: () => number
}

function toHookError(err: unknown): BillingHookError {
  if (err instanceof BillingApiError) {
    return {
      kind: err.kind,
      message: err.message,
      code: err.code,
      status: err.status,
    }
  }
  return {
    kind: 'unknown',
    message: err instanceof Error ? err.message : 'Billing request failed.',
    code: null,
    status: null,
  }
}

function toDeriveError(err: BillingHookError): BillingApiError {
  return new BillingApiError(err.kind === 'unknown' ? 'http' : err.kind, err.message, {
    status: err.status,
    code: err.code,
  })
}

/**
 * Framework-agnostic controller used by useBilling and unit tests.
 * Call `setSignedIn` / `setAuthLoading` when auth changes; call `dispose` on unmount.
 */
export function createBillingController(deps: BillingControllerDeps = {}) {
  const api = {
    getSubscriptionStatus: deps.getSubscriptionStatus ?? getSubscriptionStatus,
    getQuotaStatus: deps.getQuotaStatus ?? getQuotaStatus,
    refreshSubscription: deps.refreshSubscription ?? refreshSubscription,
    createCheckout: deps.createCheckout ?? createCheckout,
    openPortal: deps.openPortal ?? openPortal,
    openExternalUrl: deps.openExternalUrl ?? openExternalUrl,
  }
  const now = deps.now ?? Date.now

  let disposed = false
  let signedIn = false
  let authLoading = true
  let loadInFlight: Promise<void> | null = null
  let upgradeInFlight: Promise<void> | null = null
  let manageInFlight: Promise<void> | null = null
  let actionLoading = false
  /** Bumped whenever the signed-in identity changes: a response that started before cannot apply after. */
  let epoch = 0
  let loadSeq = 0
  let lastLoadStartedAt = 0

  let subscription: SubscriptionRecord | null = null
  let quota: QuotaStatusPayload | null = null
  /** Authoritative load/refresh error — drives unavailable. */
  let loadError: BillingHookError | null = null
  /** Transient action error — exposed but does not rewrite authoritative entitlement. */
  let actionError: BillingHookError | null = null

  const listeners = new Set<() => void>()

  function emit() {
    if (disposed) return
    for (const listener of listeners) listener()
  }

  function snapshot(): UseBillingResult {
    const loading = Boolean(authLoading || loadInFlight || actionLoading)
    const deriveError = loadError ? toDeriveError(loadError) : null
    const state = deriveBillingState({
      signedIn,
      loading: Boolean(authLoading || (signedIn && loadInFlight && !subscription && !loadError)),
      subscription,
      quota,
      error: deriveError,
    })
    return {
      state,
      loading,
      error: actionError ?? loadError,
      actions: {
        load: () => load(),
        refresh,
        upgrade,
        manage,
      },
      getStatus: () => snapshot().state.status,
    }
  }

  async function load(opts: { silent?: boolean } = {}): Promise<void> {
    if (disposed) return
    if (!signedIn) {
      subscription = null
      quota = null
      loadError = null
      actionError = null
      emit()
      return
    }
    if (loadInFlight) return loadInFlight

    const myEpoch = epoch
    const seq = ++loadSeq
    lastLoadStartedAt = now()
    loadInFlight = (async () => {
      actionError = null
      emit()
      try {
        const [subRes, quotaRes] = await Promise.all([api.getSubscriptionStatus(), api.getQuotaStatus()])
        // A different identity (sign-out / account switch) or an unmount happened while this was in flight:
        // this answer belongs to the previous user and must not touch the new one's state.
        if (disposed || myEpoch !== epoch) return
        subscription = subRes.subscription
        quota = quotaRes.plan
        loadError = null
      } catch (err) {
        if (disposed || myEpoch !== epoch) return
        // A background (focus) refresh that fails keeps the last good answer instead of flashing
        // "unavailable"; the next real load surfaces the problem.
        if (opts.silent && subscription) return
        loadError = toHookError(err)
        // Preserve previous authoritative subscription/quota on transient failure.
      } finally {
        if (seq === loadSeq) loadInFlight = null
        if (!disposed) emit()
      }
    })()

    return loadInFlight
  }

  /** Focus-triggered refresh: silent, throttled, and never racing another read or billing action. */
  async function loadOnFocus(): Promise<void> {
    if (disposed || !signedIn || authLoading) return
    if (loadInFlight || actionLoading || upgradeInFlight || manageInFlight) return
    if (hasPendingBillingReturn()) return // the return-from-Checkout/Portal refresh owns this focus event
    if (lastLoadStartedAt > 0 && now() - lastLoadStartedAt < FOCUS_REFRESH_MIN_INTERVAL_MS) return
    await load({ silent: true })
  }

  async function refresh(): Promise<void> {
    if (disposed) return
    if (!signedIn) {
      await load()
      return
    }
    actionLoading = true
    actionError = null
    emit()
    try {
      // refreshed:true alone must never activate entitlement — always reload status+quota.
      await api.refreshSubscription()
      if (disposed) return
      loadInFlight = null
      await load()
      if (disposed) return
      // If authoritative reload failed, surface as refresh failure.
      if (loadError) {
        throw new BillingApiError(
          loadError.kind === 'unknown' ? 'http' : loadError.kind,
          loadError.message,
          { status: loadError.status, code: loadError.code },
        )
      }
    } catch (err) {
      if (disposed) return
      actionError = toHookError(err)
      emit()
      throw err
    } finally {
      actionLoading = false
      if (!disposed) emit()
    }
  }

  async function upgrade(planCode: BillingPlanCode): Promise<void> {
    if (disposed) return
    if (manageInFlight) return
    if (upgradeInFlight) return upgradeInFlight

    upgradeInFlight = (async () => {
      actionLoading = true
      actionError = null
      emit()
      try {
        const { url } = await api.createCheckout(planCode)
        if (disposed) return
        await api.openExternalUrl(url)
      } catch (err) {
        if (disposed) return
        actionError = toHookError(err)
        // Do not mutate subscription toward active on checkout failure or success.
        emit()
        throw err
      } finally {
        actionLoading = false
        upgradeInFlight = null
        if (!disposed) emit()
      }
    })()

    return upgradeInFlight
  }

  async function manage(): Promise<void> {
    if (disposed) return
    if (upgradeInFlight) return
    if (manageInFlight) return manageInFlight

    manageInFlight = (async () => {
      actionLoading = true
      actionError = null
      emit()
      try {
        const { url } = await api.openPortal()
        if (disposed) return
        await api.openExternalUrl(url)
      } catch (err) {
        if (disposed) return
        actionError = toHookError(err)
        emit()
        throw err
      } finally {
        actionLoading = false
        manageInFlight = null
        if (!disposed) emit()
      }
    })()

    return manageInFlight
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: snapshot,
    setSignedIn(next: boolean) {
      if (disposed) return
      const changed = signedIn !== next
      signedIn = next
      if (changed) {
        epoch += 1
        loadInFlight = null
        lastLoadStartedAt = 0
      }
      if (!next) {
        subscription = null
        quota = null
        loadError = null
        actionError = null
      }
      if (changed) emit()
    },
    setAuthLoading(next: boolean) {
      if (disposed) return
      if (authLoading === next) return
      authLoading = next
      emit()
    },
    load: () => load(),
    loadOnFocus,
    refresh,
    upgrade,
    manage,
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}

export type BillingController = ReturnType<typeof createBillingController>

export function useBilling(): UseBillingResult {
  const { session, loading: authLoading } = useAuth()
  const signedIn = Boolean(session)
  const controllerRef = useRef<BillingController | null>(null)

  const [state, setState] = useState<BillingState>({ status: 'signed_out' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<BillingHookError | null>(null)

  const publish = useCallback((controller: BillingController) => {
    const snap = controller.getSnapshot()
    setState(snap.state)
    setLoading(snap.loading)
    setError(snap.error)
  }, [])

  useEffect(() => {
    const controller = createBillingController()
    controllerRef.current = controller
    const unsub = controller.subscribe(() => publish(controller))
    controller.setAuthLoading(authLoading)
    controller.setSignedIn(signedIn)
    if (!authLoading) {
      void controller.load()
    }
    publish(controller)
    return () => {
      unsub()
      controller.dispose()
      controllerRef.current = null
    }
    // Mount-only: auth sync is handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount lifecycle
  }, [publish])

  useEffect(() => {
    const controller = controllerRef.current
    if (!controller) return
    controller.setAuthLoading(authLoading)
    controller.setSignedIn(signedIn)
    if (!authLoading) {
      void controller.load()
    }
    publish(controller)
  }, [signedIn, authLoading, publish])

  // Refresh when the app regains focus (window focus or tab/app becoming visible).
  useEffect(() => {
    const onFocus = () => void controllerRef.current?.loadOnFocus()
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') onFocus()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const load = useCallback(async () => {
    await controllerRef.current?.load()
  }, [])
  const refresh = useCallback(async () => {
    await controllerRef.current?.refresh()
  }, [])
  const upgrade = useCallback(async (planCode: BillingPlanCode) => {
    await controllerRef.current?.upgrade(planCode)
  }, [])
  const manage = useCallback(async () => {
    await controllerRef.current?.manage()
  }, [])
  const getStatus = useCallback((): BillingState['status'] => {
    return controllerRef.current?.getSnapshot().state.status ?? 'signed_out'
  }, [])

  return {
    state,
    loading,
    error,
    actions: { load, refresh, upgrade, manage },
    getStatus,
  }
}
