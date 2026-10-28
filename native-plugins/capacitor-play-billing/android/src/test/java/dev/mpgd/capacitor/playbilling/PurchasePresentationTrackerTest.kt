package dev.mpgd.capacitor.playbilling

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Sheet facts from activity observations only: `open` on a Billing Library
 * activity, `closed` when the host resumes after it, `not-started` when the
 * flow ended without one, and exactly one terminal fact per flow.
 */
class PurchasePresentationTrackerTest {
    private val host = "com.getcapacitor.BridgeActivity"
    private val proxy = "com.android.billingclient.api.ProxyBillingActivity"
    private val proxyV2 = "com.android.billingclient.api.ProxyBillingActivityV2"

    private val facts = mutableListOf<String>()
    private val tracker = PurchasePresentationTracker { id, state, reason ->
        facts += listOfNotNull(id, state, reason).joinToString(":")
    }

    @Test
    fun opensOnTheBillingActivityAndClosesWhenTheHostResumes() {
        tracker.begin("p1")
        tracker.onLaunchAttempted("p1")
        // The host resuming before the sheet (another pause) proves nothing.
        tracker.onActivityResumed(host)
        tracker.onActivityCreated(proxy)
        tracker.onActivityCreated(proxyV2)
        assertEquals("open", tracker.answerState("p1"))
        // The billing activity resuming is the sheet itself.
        tracker.onActivityResumed(proxy)
        // A result arriving (the flow ending) is not closure.
        tracker.onFlowEnded("p1")
        assertEquals(listOf("p1:open"), facts)
        tracker.onActivityResumed(host)
        tracker.onActivityResumed(host)
        assertEquals(listOf("p1:open", "p1:closed"), facts)
        assertEquals("closed", tracker.answerState("p1"))
        assertFalse(tracker.active)
    }

    @Test
    fun reportsNotStartedWhenTheFlowEndsWithoutTheSheet() {
        tracker.begin("p1")
        assertFalse(tracker.awaitsLaunchObservation("p1"))
        tracker.onLaunchAttempted("p1")
        assertTrue(tracker.awaitsLaunchObservation("p1"))
        assertEquals("requested", tracker.answerState("p1"))
        tracker.onFlowEnded("p1")
        // A billing activity after the decision is not this flow's.
        tracker.onActivityCreated(proxy)
        tracker.onActivityResumed(host)
        assertEquals(listOf("p1:not-started"), facts)
        assertEquals("not-started", tracker.answerState("p1"))
    }

    @Test
    fun opensWhenTheBillingActivityAppearsDuringTheLaunchGrace() {
        tracker.begin("p1")
        tracker.onLaunchAttempted("p1")
        tracker.onActivityCreated(proxy)
        assertFalse(tracker.awaitsLaunchObservation("p1"))
        tracker.onFlowEnded("p1")
        tracker.onActivityResumed(host)
        assertEquals(listOf("p1:open", "p1:closed"), facts)
    }

    @Test
    fun ignoresAnotherFlowsIdAndActivitiesOutsideAFlow() {
        tracker.onActivityCreated(proxy)
        tracker.onActivityResumed(host)
        tracker.begin("p2")
        tracker.onLaunchAttempted("p1")
        assertFalse(tracker.awaitsLaunchObservation("p2"))
        tracker.onFlowEnded("p1")
        assertTrue(tracker.active)
        tracker.onFlowEnded("p2")
        assertEquals(listOf("p2:not-started"), facts)
        assertEquals("requested", tracker.answerState("unknown"))
    }

    @Test
    fun closesAnOpenOrLaunchedFlowAsInterruptedOnTeardown() {
        tracker.begin("p1")
        tracker.onLaunchAttempted("p1")
        tracker.onActivityCreated(proxy)
        tracker.onTeardown()
        tracker.onActivityResumed(host)
        tracker.begin("p2")
        tracker.onLaunchAttempted("p2")
        tracker.onTeardown()
        tracker.begin("p3")
        tracker.onTeardown()
        tracker.onTeardown()
        assertEquals(
            listOf("p1:open", "p1:closed:interrupted", "p2:closed:interrupted", "p3:not-started"),
            facts,
        )
    }

    @Test
    fun acceptsOnlyBoundedPresentationIds() {
        assertTrue(PurchasePresentationTracker.isValidPresentationId("0f8fad5b-d9cb-469f-a165-70867728950e"))
        assertFalse(PurchasePresentationTracker.isValidPresentationId(null))
        assertFalse(PurchasePresentationTracker.isValidPresentationId(""))
        assertFalse(PurchasePresentationTracker.isValidPresentationId("a".repeat(65)))
        assertFalse(PurchasePresentationTracker.isValidPresentationId("id with space"))
        assertTrue(PurchasePresentationTracker.isBillingActivity(proxyV2))
        assertFalse(PurchasePresentationTracker.isBillingActivity(host))
    }
}
