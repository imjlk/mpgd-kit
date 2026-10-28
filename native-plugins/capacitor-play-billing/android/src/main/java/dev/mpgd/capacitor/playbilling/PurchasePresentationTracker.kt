package dev.mpgd.capacitor.playbilling

/**
 * Sheet facts for one Play purchase flow at a time, from activity lifecycle
 * observations only, never from a purchase result:
 *
 * - `open` when a Billing Library activity
 *   (`com.android.billingclient.api.ProxyBillingActivity` or `...V2`, the
 *   translucent activity `launchBillingFlow` starts in this process once it
 *   returns OK) is created during the flow, however late;
 * - `closed` when an activity of the app that is not a billing activity
 *   resumes after that: the host sits below the billing activities in the
 *   same task, so it resumes only once the Play sheet is gone;
 * - `not-started` when the flow ended without a billing activity: a refusal
 *   before the launch, or a launch that brought nothing over the game. After
 *   a launch attempt the verdict waits while the game's activity is paused
 *   (something is coming over it, a billing activity that is slow to be
 *   created included) until it resumes, a billing activity appears, or the
 *   plugin's bound passes.
 *
 * `onPurchasesUpdated`, a pending purchase, or the plugin's call timeout are
 * not observations of the sheet. Every `open` is followed by exactly one
 * `closed`: the activity that resumes, teardown (`interrupted`), or the
 * plugin's safety bound (`timeout`). The flow stays [active] (the plugin
 * answers `PLAY_BILLING_BUSY`) until its terminal fact. Pure Kotlin, driven
 * on the main thread by the plugin, so the JVM tests can run it.
 */
internal class PurchasePresentationTracker(
    private val emit: (presentationId: String, state: String, reason: String?) -> Unit,
) {
    private enum class State { REQUESTED, OPEN }

    private var presentationId: String? = null
    private var state = State.REQUESTED
    private var launchAttempted = false
    private var flowEnded = false

    /** A non-billing activity paused after the launch attempt, with no billing activity seen yet. */
    private var hostPaused = false

    /** The last fact of the flow that has ended, for its call's answer. */
    private var lastFact: Pair<String, String>? = null

    val active: Boolean get() = presentationId != null

    /** The id of the flow whose sheet is open now, if any. */
    val openPresentationId: String? get() = if (state == State.OPEN) presentationId else null

    fun begin(id: String) {
        presentationId = id
        state = State.REQUESTED
        launchAttempted = false
        flowEnded = false
        hostPaused = false
        lastFact = null
    }

    /** Whether [id] is the flow being tracked; a flow ended early must not launch. */
    fun isTracking(id: String): Boolean = presentationId == id

    /** The flow of [id] is about to call `launchBillingFlow` (through OpenIAP). */
    fun onLaunchAttempted(id: String) {
        if (presentationId == id) {
            launchAttempted = true
        }
    }

    fun onActivityCreated(className: String) {
        val id = presentationId ?: return
        if (state == State.REQUESTED && isBillingActivity(className)) {
            state = State.OPEN
            hostPaused = false
            emit(id, OPEN, null)
        }
    }

    fun onActivityPaused(className: String) {
        if (presentationId != null && state == State.REQUESTED && launchAttempted &&
            !isBillingActivity(className)
        ) {
            hostPaused = true
        }
    }

    fun onActivityResumed(className: String) {
        if (presentationId == null || isBillingActivity(className)) return
        if (state == State.OPEN) {
            end(CLOSED, null)
            return
        }
        // Back without a billing activity: whatever covered the game was not
        // the sheet. An ended flow is decided now.
        hostPaused = false
        if (flowEnded) {
            end(NOT_STARTED, null)
        }
    }

    /**
     * True while a launch was attempted, the flow is still running, and no
     * billing activity was seen: the activity `launchBillingFlow` started may
     * not be created yet (the game's activity may not even be paused yet), so
     * the plugin waits briefly before it ends the flow.
     */
    fun awaitsLaunchObservation(id: String): Boolean =
        presentationId == id && state == State.REQUESTED && launchAttempted && !flowEnded

    /**
     * The OpenIAP flow of [id] returned (or never started). Decides
     * `not-started` when nothing opened, unless a launch was attempted and
     * the game's activity is still paused: then the verdict waits for it to
     * resume (`not-started`), a billing activity (`open`), or [onLateBound].
     */
    fun onFlowEnded(id: String) {
        if (presentationId != id || state != State.REQUESTED) return
        flowEnded = true
        if (!launchAttempted || !hostPaused) {
            end(NOT_STARTED, null)
        }
    }

    /** The plugin's bound on a deferred verdict passed: nothing opened. */
    fun onLateBound(id: String) {
        if (presentationId == id && state == State.REQUESTED && flowEnded) {
            end(NOT_STARTED, null)
        }
    }

    /**
     * The plugin's call timeout for [id] before `launchBillingFlow` was ever
     * called: the flow is ended `not-started` (the plugin cancels it, and a
     * flow no longer tracked never launches). True when it ended the flow.
     */
    fun cancelBeforeLaunch(id: String): Boolean {
        if (presentationId != id || state != State.REQUESTED || launchAttempted) return false
        end(NOT_STARTED, null)
        return true
    }

    /**
     * The sheet of [id] stayed open past the plugin's safety bound without the
     * host resuming: report it closed (`timeout`) so a new flow can start.
     */
    fun onSafetyTimeout(id: String) {
        if (presentationId == id && state == State.OPEN) {
            end(CLOSED, TIMEOUT)
        }
    }

    /**
     * The plugin is torn down: nothing will be observed any more. When the
     * activity is only recreated ([reportClosed] false, a configuration
     * change), the sheet may still be up, so no `closed` is claimed: the
     * flow is forgotten and the TypeScript provider's safety timeout ends it
     * for a web view that survives.
     */
    fun onTeardown(reportClosed: Boolean = true) {
        if (presentationId == null) return
        if (!reportClosed) {
            presentationId = null
            return
        }
        if (state == State.OPEN || launchAttempted) {
            end(CLOSED, INTERRUPTED)
        } else {
            end(NOT_STARTED, null)
        }
    }

    /**
     * What the call's answer reports for [id]: `open` or `closed` or
     * `not-started` for the current or just ended flow, and `requested` while
     * the flow runs without a verdict yet (facts follow as events).
     */
    fun answerState(id: String): String {
        if (presentationId == id) {
            return if (state == State.OPEN) OPEN else REQUESTED_STATE
        }
        val last = lastFact
        return if (last != null && last.first == id) last.second else REQUESTED_STATE
    }

    private fun end(fact: String, reason: String?) {
        val id = presentationId ?: return
        presentationId = null
        lastFact = id to fact
        emit(id, fact, reason)
    }

    companion object {
        const val OPEN = "open"
        const val CLOSED = "closed"
        const val NOT_STARTED = "not-started"
        const val REQUESTED_STATE = "requested"
        const val INTERRUPTED = "interrupted"
        const val TIMEOUT = "timeout"

        /** The protocol version `getPresentationSupport` declares. */
        const val PROTOCOL_VERSION = 1

        private const val BILLING_ACTIVITY_PREFIX = "com.android.billingclient."
        private val presentationIdPattern = Regex("^[A-Za-z0-9-]{1,64}$")

        fun isBillingActivity(className: String): Boolean =
            className.startsWith(BILLING_ACTIVITY_PREFIX)

        fun isValidPresentationId(value: String?): Boolean =
            value != null && presentationIdPattern.matches(value)
    }
}
