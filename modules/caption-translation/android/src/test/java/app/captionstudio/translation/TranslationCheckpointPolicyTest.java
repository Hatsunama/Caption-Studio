package app.captionstudio.translation;

import static org.junit.Assert.*;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class TranslationCheckpointPolicyTest {
  @Rule public TemporaryFolder temporary = new TemporaryFolder();

  private static TranslationCheckpointStore freshStore(File directory) throws Exception {
    try {
      return TranslationCheckpointStore.class.getDeclaredConstructor(File.class, boolean.class)
          .newInstance(directory, false);
    } catch (InvocationTargetException error) {
      throw (Exception) error.getCause();
    }
  }

  @Test public void refreshDoesNotReadOldTextButDurablyReplacesIt() throws Exception {
    File directory = temporary.newFolder();
    String key = TranslationCheckpointStore.key("same source and context");
    TranslationCheckpointStore resumable = new TranslationCheckpointStore(directory);
    resumable.write(key, "accepted old text");
    TranslationCheckpointStore fresh = freshStore(directory);
    assertNull(fresh.read(key));
    fresh.write(key, "accepted new text");
    assertNull(fresh.read(key));
    assertEquals("accepted new text", new TranslationCheckpointStore(directory).read(key));
  }

  @Test public void refreshFailureKeepsPreviouslyAcceptedCheckpoint() throws Exception {
    File directory = temporary.newFolder();
    String key = TranslationCheckpointStore.key("same source and context");
    new TranslationCheckpointStore(directory).write(key, "accepted old text");
    TranslationCheckpointStore fresh = freshStore(directory);
    assertThrows(IOException.class, () -> fresh.write(key,
        "x".repeat(TranslationCheckpointStore.MAX_RESPONSE_BYTES + 1)));
    assertEquals("accepted old text", new TranslationCheckpointStore(directory).read(key));
  }

  @Test public void disabledReadsDoNotWeakenPrivatePathValidation() throws Exception {
    TranslationCheckpointStore fresh = freshStore(temporary.newFolder());
    assertThrows(IOException.class, () -> fresh.read("../outside"));
    assertThrows(IOException.class, () -> fresh.write("../outside", "text"));
  }

  @Test public void unavailableTelemetryDoesNotReduceEstablishedRetryAllowance() {
    assertEquals(135, NaturalCaptionTranslator.outputTokenLimit("Hello", true));
  }
}
