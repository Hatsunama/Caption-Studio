package app.captionstudio.translation;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class AndroidTranslationEnvironmentTest {
  private static final long GIBIBYTE = 1024L * 1024L * 1024L;

  @Test
  public void admitsCapableHardwareRegardlessOfTransientAvailableMemory() {
    assertTrue(AndroidTranslationEnvironment.hasHardwareCapacity(true, false, 8L * GIBIBYTE));
    assertTrue(AndroidTranslationEnvironment.hasHardwareCapacity(true, false, 4L * GIBIBYTE));
  }

  @Test
  public void rejectsOnlyPermanentHardwareConstraints() {
    assertFalse(AndroidTranslationEnvironment.hasHardwareCapacity(false, false, 8L * GIBIBYTE));
    assertFalse(AndroidTranslationEnvironment.hasHardwareCapacity(true, true, 8L * GIBIBYTE));
    assertFalse(AndroidTranslationEnvironment.hasHardwareCapacity(true, false, 4L * GIBIBYTE - 1L));
  }

  @Test
  public void selectsInferenceThreadsFromStableDeviceCapacity() {
    assertEquals(1, AndroidTranslationEnvironment.selectRuntimeThreadCount(8, 512, true));
    assertEquals(1, AndroidTranslationEnvironment.selectRuntimeThreadCount(2, 512, false));
    assertEquals(1, AndroidTranslationEnvironment.selectRuntimeThreadCount(8, 192, false));
    assertEquals(2, AndroidTranslationEnvironment.selectRuntimeThreadCount(4, 512, false));
    assertEquals(2, AndroidTranslationEnvironment.selectRuntimeThreadCount(8, 384, false));
    assertEquals(4, AndroidTranslationEnvironment.selectRuntimeThreadCount(8, 512, false));
  }
}
