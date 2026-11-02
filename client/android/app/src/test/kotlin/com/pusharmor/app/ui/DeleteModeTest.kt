package com.pusharmor.app.ui

import com.pusharmor.app.session.Session
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Delete mode survives only while the session is signed in, so a sign-in after OAuth is not a delete. */
class DeleteModeTest {
    @Test fun staysOnWhileSignedIn() = assertTrue(deletingAfter(Session.Start.READY, true))
    @Test fun endsWhenSignInStarts() = assertFalse(deletingAfter(Session.Start.SIGN_IN, true))
    @Test fun endsWhenSignedOut() = assertFalse(deletingAfter(Session.Start.SIGNED_OUT, true))
    @Test fun startingUpKeepsIt() = assertTrue(deletingAfter(null, true))
    @Test fun stayingOffStaysOff() = assertFalse(deletingAfter(Session.Start.READY, false))
}
