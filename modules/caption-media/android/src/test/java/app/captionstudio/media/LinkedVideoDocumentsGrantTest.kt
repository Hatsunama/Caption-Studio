package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class LinkedVideoDocumentsGrantTest {
  @Test
  fun metadataFailureReleasesOnlyGrantsAcquiredByThisSelection() {
    val retained = mutableSetOf("existing")
    val released = mutableListOf<String>()
    assertThrows(IllegalStateException::class.java) {
      withRetainedDocumentResults(
        listOf("existing", "new", "broken"),
        isRetained = { it in retained },
        retain = { retained += it },
        release = { released += it; retained -= it },
        details = { if (it == "broken") error("metadata unavailable") else it },
      )
    }
    assertEquals(setOf("existing"), retained)
    assertEquals(listOf("broken", "new"), released)
  }

  @Test
  fun laterGrantFailureRollsBackEarlierNewGrant() {
    val retained = mutableSetOf<String>()
    assertThrows(SecurityException::class.java) {
      withRetainedDocumentResults(
        listOf("first", "denied"),
        isRetained = { it in retained },
        retain = { if (it == "denied") throw SecurityException("denied") else retained += it },
        release = { retained -= it },
        details = { it },
      )
    }
    assertEquals(emptySet<String>(), retained)
  }
}
