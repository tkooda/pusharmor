package com.pusharmor.app.push

import com.google.android.gms.common.ConnectionResult
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Play services that need an update, are updating, or are disabled count as present; a missing install does not. */
class PlayServicesStateTest {
    @Test fun presentStates() {
        assertTrue(FlavorPush.present(ConnectionResult.SUCCESS))
        assertTrue(FlavorPush.present(ConnectionResult.SERVICE_VERSION_UPDATE_REQUIRED))
        assertTrue(FlavorPush.present(ConnectionResult.SERVICE_DISABLED))
        assertTrue(FlavorPush.present(ConnectionResult.SERVICE_UPDATING))
        assertFalse(FlavorPush.present(ConnectionResult.SERVICE_MISSING))
    }

    @Test fun dialogFixesUpdateAndDisabledOnly() {
        assertTrue(FlavorPush.fixable(ConnectionResult.SERVICE_VERSION_UPDATE_REQUIRED))
        assertTrue(FlavorPush.fixable(ConnectionResult.SERVICE_DISABLED))
        assertFalse(FlavorPush.fixable(ConnectionResult.SERVICE_UPDATING))
        assertFalse(FlavorPush.fixable(ConnectionResult.SUCCESS))
    }
}
