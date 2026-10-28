package dev.mpgd.capacitor.playbilling

/**
 * Sheet facts for one Play purchase flow at a time, from activity lifecycle
 * observations only, never from a purchase result:
 *
 * - `open` when a Billing Library activity
 *   (`com.android.billingclient.api.ProxyBillingActivity` or `...V2`, the
 *   translucent activity `launchBillingFlow` starts in this process once it
 *   returns OK) is created during the flow;
 * - `closed` when an activity of the app that is not a billing activity
 *   resumes after that: the host sits below the billing activities in the
 *   same task, so it resumes only once the Play sheet is gone;
 * - `not-started` when the flow ended without a billing activity (a launch
 *   failure, or a refusal before the launch).
 *
 * `onPurchasesUpdated`, a pending purchase, or the plugin's call timeout are
 * not observations of the sheet. Every `open` is followed by exactly one
 * `closed`: the activity that resumes, or teardown (`interrupted`); the
 * TypeScript provider adds a safety timeout. Pure Kotlin, driven on the main
 * thread by the plugin, so the JVM tests can run it.
 */
internal class PurchasePresentationTracker(
    private val emit: (presentationId: String, state: String, reason: String?) -> Unit,
) {
    private enum class State { REQUESTED, OPEN }

    private var presentationId: String? = null
    private var state = State.REQUESTED
    private var launchAttempted = false

    /** The last fact of the flow that has ended, for its call's answer. */
    private var lastFact: Pair<String, String>? = null

    val active: Boolean get() = presentationId != null

    /** The id of the flow whose sheet is open now, if any. */
    val openPresentationId: String? get() = if (state == State.OPEN) presentationId else null

    fun begin(id: String) {
        presentationId = id
        state = State.REQUESTED
        launchAttempted = false
        lastFact = null
    }

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
            emit(id, OPEN, null)
        }
    }

    fun onActivityResumed(className: String) {
        if (state == State.OPEN && !isBillingActivity(className)) {
            end(CLOSED, null)
        }
    }

    /**
     * True while a launch was attempted and no billing activity was seen: the
     * activity `launchBillingFlow` started may not be created yet, so the
     * plugin waits briefly before it calls the flow `not-started`.
     */
    fun awaitsLaunchObservation(id: String): Boolean =
        presentationId == id && state == State.REQUESTED && launchAttempted

    /** The OpenIAP flow of [id] returned (or never started). Decides `not-started` when nothing opened. */
    fun onFlowEnded(id: String) {
        if (presentationId == id && state == State.REQUESTED) {
            end(NOT_STARTED, null)
        }
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

    /** The plugin is torn down: nothing will be observed any more. */
    fun onTeardown() {
        if (presentationId == null) return
        if (state == State.OPEN || launchAttempted) {
            end(CLOSED, INTERRUPTED)
        } else {
            end(NOT_STARTED, null)
        }
    }

    /**
     * What the call's answer reports for [id]: `open` or `closed` or
     * `not-started` for the current or just ended flow, and `requested` while
     * the flow runs without a fact yet (facts follow as events).
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
