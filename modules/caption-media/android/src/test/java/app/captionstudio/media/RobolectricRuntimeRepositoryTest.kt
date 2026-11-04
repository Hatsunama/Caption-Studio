package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Test

class RobolectricRuntimeRepositoryTest {
  @Test fun androidSdkJarsUseTheCanonicalMavenCentralEndpoint() {
    assertEquals(
      "https://repo.maven.apache.org/maven2",
      System.getProperty("robolectric.dependency.repo.url"),
    )
  }
}
