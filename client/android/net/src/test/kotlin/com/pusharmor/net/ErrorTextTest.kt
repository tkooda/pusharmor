package com.pusharmor.net

import com.pusharmor.protocol.engine.ApiResult
import org.junit.Assert.assertEquals
import org.junit.Test

/** Every reply maps to the approved reason line, and an error reads as two lines. */
class ErrorTextTest {
    @Test fun everyReplyGivesItsReason() {
        val rows: List<Pair<ApiResult<*>, String>> = listOf(
            ApiResult.Network to "The relay server could not be reached. Check your internet connection and try again.",
            ApiResult.Http(500, null) to "The relay server is not working right now. Try again later.",
            ApiResult.Http(503, "unavailable") to "The relay server is not working right now. Try again later.",
            ApiResult.Http(429, "rate limited", 120) to "Too many tries. Try again in 2 minutes.",
            ApiResult.Http(429, "rate limited") to "Too many tries. Try again in 60 seconds.",
            ApiResult.Http(426, "update required") to "This version of PushArmor is too old. Update PushArmor to continue.",
            ApiResult.Http(401, "unknown peer") to "This device was removed from the account. Log in again.",
            ApiResult.Http(401, "logged out") to "This device is logged out. Log in to resume.",
            ApiResult.Http(401, "ticket expired") to "The login expired. Log in again.",
            ApiResult.Http(401, "invalid ticket") to "The login link is not valid. Request a new code and try again.",
            ApiResult.Http(401, "bad ticket") to "The login link is not valid. Request a new code and try again.",
            ApiResult.Http(401, "clock skew") to "This device's clock is off by more than 5 minutes. Fix the clock and try again.",
            ApiResult.Http(403, "banned") to "This account is blocked.",
            ApiResult.Http(401, "wrong code") to "The code is not correct. Check the newest email from PushArmor and try again.",
            ApiResult.Http(401, "code expired") to "The code expired. Request a new code to continue.",
            ApiResult.Http(403, "turnstile failed") to "The security check did not finish. Try again.",
            ApiResult.Http(502, "email send failed") to "The relay server could not send the email. Try again.",
            ApiResult.Http(502, null) to "The relay server is not working right now. Try again later.",
            ApiResult.Http(502, "bad gateway") to "The relay server is not working right now. Try again later.",
            ApiResult.Http(400, "bad email") to "Only email addresses with plain ASCII characters are supported.",
            ApiResult.Http(401, "email not verified") to "This Google account has no verified email address.",
            ApiResult.Http(401, "invalid id_token") to "Google did not confirm the login. Try again.",
            ApiResult.Http(200, "bad reply") to "The relay server sent a reply this device cannot use. Try again.",
            ApiResult.Http(503, "bad reply") to "The relay server sent a reply this device cannot use. Try again.",
            ApiResult.Ok(Unit) to "The relay server sent a reply this device cannot use. Try again.",
            ApiResult.Http(400, "bad request") to "The relay server did not accept the request. Update PushArmor and try again.",
            ApiResult.Http(404, null) to "The relay server did not accept the request. Update PushArmor and try again.",
            ApiResult.Http(405, null) to "The relay server did not accept the request. Update PushArmor and try again.",
            ApiResult.Http(401, "invalid client signature") to "The relay server did not accept the request. Update PushArmor and try again.",
            ApiResult.Http(413, "too large") to "The message is longer than 2048 characters.",
            ApiResult.Http(400, "push endpoint not allowed") to "This device's push service is not supported yet.",
            ApiResult.Http(401, "bad id") to "Try again.",
            ApiResult.Http(409, "some code") to "Try again.",
            ApiResult.Http(400, null) to "Try again.",
        )
        for ((r, want) in rows) assertEquals(r.toString(), want, ErrorText.reason(r))
    }

    @Test fun actionLineThenReason() {
        assertEquals("Unable to send.\nThe relay server could not be reached. Check your internet connection and try again.",
            ErrorText.of("Unable to send.", ApiResult.Network))
        assertEquals("Unable to refresh the device list.\nTry again.", ErrorText.of("Unable to refresh the device list.", ApiResult.Http(401, "bad id")))
        assertEquals("Unable to send.\nThis device's push service is not supported yet.\n(push.example.com)",
            ErrorText.of("Unable to send.", ApiResult.Http(400, "push endpoint not allowed"), pushHost = "push.example.com"))
        // the host goes only on the push service line
        assertEquals("Unable to send.\nTry again.", ErrorText.of("Unable to send.", ApiResult.Http(400, "bad id"), pushHost = "push.example.com"))
    }
}
