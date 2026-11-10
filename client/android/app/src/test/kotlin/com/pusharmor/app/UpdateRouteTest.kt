package com.pusharmor.app

import com.pusharmor.app.ui.UPDATE_URL
import com.pusharmor.app.ui.UpdateRoute
import com.pusharmor.app.ui.updateRoute
import org.junit.Assert.assertEquals
import org.junit.Test

class UpdateRouteTest {
    private val pkg = "com.pusharmor.app"
    private val market = "market://details?id=$pkg"
    private val web = UpdateRoute(UPDATE_URL, null, emptyList())

    @Test fun playWithVendingGoesToPlay() = assertEquals(
        UpdateRoute(market, "com.android.vending", listOf("https://play.google.com/store/apps/details?id=$pkg", UPDATE_URL)),
        updateRoute("com.android.vending", true, pkg))
    @Test fun fossWithVendingNeverGoesToPlay() = assertEquals(web, updateRoute("com.android.vending", false, pkg))
    @Test fun fdroid() = assertEquals(UpdateRoute(market, "org.fdroid.fdroid", listOf(UPDATE_URL)), updateRoute("org.fdroid.fdroid", false, pkg))
    @Test fun fdroidBasic() = assertEquals(UpdateRoute(market, "org.fdroid.basic", listOf(UPDATE_URL)), updateRoute("org.fdroid.basic", false, pkg))
    @Test fun noInstallerGoesToDownloadPage() = assertEquals(web, updateRoute(null, true, pkg))
    @Test fun otherInstallerGoesToDownloadPage() = assertEquals(web, updateRoute("com.example.store", true, pkg))
    @Test fun playFlavorWithFdroidInstaller() = assertEquals(UpdateRoute(market, "org.fdroid.fdroid", listOf(UPDATE_URL)), updateRoute("org.fdroid.fdroid", true, pkg))
}
