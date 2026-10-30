package com.pusharmor.app.ui.theme

/** The Theme setting: System (default), Light or Dark. Stored as "system" | "light" | "dark". */
enum class ThemePref(val key: String, val label: String) {
    SYSTEM("system", "System default"), LIGHT("light", "Light"), DARK("dark", "Dark");

    /** Dark or light for this choice; [system] is the device setting. */
    fun isDark(system: Boolean): Boolean = when (this) { SYSTEM -> system; LIGHT -> false; DARK -> true }

    companion object {
        /** Absent or unknown values mean System. */
        fun parse(value: String?): ThemePref = entries.firstOrNull { it.key == value } ?: SYSTEM

        /** Sets the app night mode (API 31+, our minSdk). The system keeps it for the next cold start. */
        fun applyToSystem(ctx: android.content.Context, t: ThemePref) {
            val mode = when (t) {
                SYSTEM -> android.app.UiModeManager.MODE_NIGHT_AUTO
                LIGHT -> android.app.UiModeManager.MODE_NIGHT_NO
                DARK -> android.app.UiModeManager.MODE_NIGHT_YES
            }
            ctx.getSystemService(android.app.UiModeManager::class.java)?.setApplicationNightMode(mode)
        }
    }
}
