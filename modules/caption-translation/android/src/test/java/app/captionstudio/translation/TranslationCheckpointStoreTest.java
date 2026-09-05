package app.captionstudio.translation;

import static org.junit.Assert.*;

import java.io.File;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class TranslationCheckpointStoreTest {
  @Rule public TemporaryFolder temporary = new TemporaryFolder();

  @Test public void completeCheckpointSurvivesNewInstanceAndRejectsCorruption() throws Exception {
    File directory = temporary.newFolder();
    String key = TranslationCheckpointStore.key("model|prompt|source|context|target");
    TranslationCheckpointStore store = new TranslationCheckpointStore(directory);
    store.write(key, "[{\"id\":\"c1\",\"text\":\"\u4f60\u597d\"}]");
    assertEquals(store.read(key), new TranslationCheckpointStore(directory).read(key));
    assertNotNull(store.read(key));
    try (RandomAccessFile corrupt = new RandomAccessFile(new File(directory, key + ".checkpoint"), "rw")) {
      corrupt.seek(40);
      corrupt.write(0);
    }
    assertNull(store.read(key));
  }

  @Test public void incompleteWritesDoNotReplaceLastCompleteCheckpoint() throws Exception {
    File directory = temporary.newFolder();
    String key = TranslationCheckpointStore.key("original");
    TranslationCheckpointStore store = new TranslationCheckpointStore(directory);
    store.write(key, "completed");
    Files.write(new File(directory, key + ".writing").toPath(), "partial".getBytes(StandardCharsets.UTF_8));
    assertEquals("completed", new TranslationCheckpointStore(directory).read(key));
    assertNull(store.read(TranslationCheckpointStore.key("changed source, language, context, or profile")));
    assertThrows(java.io.IOException.class, () -> store.read("../outside"));
  }

  @Test public void pruningIsBoundedAndNeverTouchesUnownedFiles() throws Exception {
    File directory = temporary.newFolder();
    File unrelated = new File(directory, "signing-key.keep");
    Files.write(unrelated.toPath(), new byte[] { 1 });
    for (int index = 0; index < TranslationCheckpointStore.MAX_ENTRIES + 2; index++) {
      Files.write(new File(directory, TranslationCheckpointStore.key("entry-" + index) + ".checkpoint").toPath(), new byte[] { 1 });
    }
    new TranslationCheckpointStore(directory);
    assertTrue(unrelated.isFile());
    assertEquals(TranslationCheckpointStore.MAX_ENTRIES + 1, directory.list().length);
  }
}
