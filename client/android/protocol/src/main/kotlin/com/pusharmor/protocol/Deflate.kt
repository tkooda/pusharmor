package com.pusharmor.protocol

import java.io.ByteArrayOutputStream
import java.util.zip.DataFormatException
import java.util.zip.Deflater
import java.util.zip.Inflater

object DeflateRaw {
    fun deflate(data: ByteArray): ByteArray {
        val d = Deflater(9, true)
        try {
            d.setInput(data)
            d.finish()
            val out = ByteArrayOutputStream()
            val buf = ByteArray(4096)
            while (!d.finished()) {
                val n = d.deflate(buf)
                out.write(buf, 0, n)
            }
            return out.toByteArray()
        } finally {
            d.end()
        }
    }

    /**
     * Inflates raw deflate data. Returns null when the stream is invalid, incomplete, has
     * trailing bytes, or the output exceeds [cap] bytes.
     */
    fun inflate(data: ByteArray, cap: Int = SizeCap.INFLATE_CAP): ByteArray? {
        val inf = Inflater(true)
        try {
            // nowrap needs one extra dummy byte after the input (java.util.zip.Inflater docs).
            inf.setInput(data + byteArrayOf(0))
            val out = ByteArrayOutputStream()
            val buf = ByteArray(4096)
            var lastRemaining = -1
            while (!inf.finished()) {
                val n = inf.inflate(buf)
                if (n == 0) {
                    if (inf.needsInput() || inf.needsDictionary()) return null
                    if (inf.remaining == lastRemaining) return null // no progress
                    lastRemaining = inf.remaining
                }
                out.write(buf, 0, n)
                if (out.size() > cap) return null
            }
            // Only the dummy byte may remain.
            if (inf.remaining > 1) return null
            return out.toByteArray()
        } catch (e: DataFormatException) {
            return null
        } finally {
            inf.end()
        }
    }
}
