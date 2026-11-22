package app.captionstudio.media

import java.io.File
import java.util.Properties
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.internal.dependency.DependencyJar
import org.robolectric.plugins.LegacyDependencyResolver

class RobolectricRuntimeRepositoryTest {
  private fun localResolver(): Pair<File, LegacyDependencyResolver> {
    val path = System.getProperty("robolectric.dependency.dir")
    assertNotNull("Gradle must prepare the verified local SDK directory", path)
    val directory = File(requireNotNull(path)).canonicalFile
    assertTrue("Prepared SDK directory must exist", directory.isDirectory)
    val properties = Properties().apply {
      setProperty("robolectric.dependency.dir", directory.path)
      setProperty("robolectric.dependency.repo.url", "http://127.0.0.1:1/not-used")
    }
    return directory to LegacyDependencyResolver(properties)
  }

  @Test fun allRequiredSdkJarsResolveFromThePreparedLocalDirectory() {
    val (directory, resolver) = localResolver()
    val versions = listOf(
      "7.0.0_r1-robolectric-r1-i7",
      "9-robolectric-4913185-2-i7",
      "10-robolectric-5803371-i7",
      "14-robolectric-10818077-i7",
      "16-robolectric-13921718-i7",
    )
    versions.forEach { version ->
      val resolved = resolver.getLocalArtifactUrl(
        DependencyJar("org.robolectric", "android-all-instrumented", version),
      )
      val expected = File(directory, "android-all-instrumented-$version.jar")
      assertEquals(expected.toURI().toURL(), resolved)
      assertTrue(expected.isFile && expected.canRead() && expected.length() > 0L)
    }
  }

  @Test fun missingSdkFailsLocallyWithoutNetworkFallback() {
    val (_, resolver) = localResolver()
    val failure = assertThrows(IllegalArgumentException::class.java) {
      resolver.getLocalArtifactUrl(
        DependencyJar("org.robolectric", "android-all-instrumented", "missing-fixture-sdk"),
      )
    }
    assertTrue(failure.message.orEmpty().contains("android-all-instrumented-missing-fixture-sdk.jar"))
  }
}
