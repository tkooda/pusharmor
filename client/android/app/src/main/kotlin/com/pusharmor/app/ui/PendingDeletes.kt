package com.pusharmor.app.ui

/** A History row's pending delete: the device ids asked (del_req) and those whose push service took it (del_ok). */
internal object PendingDeletes {
    fun ids(s: String?): Set<String> = s?.split(',')?.filter { it.isNotEmpty() }?.toSet() ?: emptySet()

    fun join(ids: Set<String>): String? = if (ids.isEmpty()) null else ids.joinToString(",")

    /** Devices asked that have not taken it and are still targets: empty means the row can go. */
    fun remaining(asked: Set<String>, ok: Set<String>, targets: Set<String>): Set<String> = (asked - ok).intersect(targets)
}
