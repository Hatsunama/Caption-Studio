package app.captionstudio.translation;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Comparator;

/** Private, bounded, crash-safe checkpoints, never model or project storage. */
final class TranslationCheckpointStore {
  static final int MAX_RESPONSE_BYTES = 262_144;
  static final long MAX_BYTES = 32L * 1024L * 1024L;
  static final int MAX_ENTRIES = 512;
  static final long RETENTION_MS = 30L * 24L * 60L * 60L * 1000L;
  private static final int MAGIC = 0x43535431;
  private final File directory;

  TranslationCheckpointStore(File directory) throws IOException {
    this.directory = directory.getCanonicalFile();
    if ((!this.directory.isDirectory() && !this.directory.mkdirs()) || !this.directory.canWrite()) {
      throw new IOException("Checkpoint directory unavailable");
    }
    prune();
  }

  static String key(String identity) {
    byte[] digest = digest(identity.getBytes(StandardCharsets.UTF_8));
    StringBuilder hex = new StringBuilder(64);
    for (byte item : digest) {
      hex.append(Character.forDigit((item & 255) >>> 4, 16));
      hex.append(Character.forDigit(item & 15, 16));
    }
    return hex.toString();
  }

  String read(String key) throws IOException {
    File file = ownedFile(key, ".checkpoint");
    if (!file.isFile()) return null;
    if (file.length() < 40 || file.length() > MAX_RESPONSE_BYTES + 40L) return null;
    try (DataInputStream input = new DataInputStream(new FileInputStream(file))) {
      if (input.readInt() != MAGIC) return null;
      int length = input.readInt();
      if (length <= 0 || length > MAX_RESPONSE_BYTES || file.length() != length + 40L) return null;
      byte[] expected = new byte[32];
      input.readFully(expected);
      byte[] content = new byte[length];
      input.readFully(content);
      if (!MessageDigest.isEqual(expected, digest(content))) return null;
      return new String(content, StandardCharsets.UTF_8);
    } catch (EOFException incomplete) {
      return null;
    }
  }

  void write(String key, String response) throws IOException {
    byte[] content = response.getBytes(StandardCharsets.UTF_8);
    if (content.length == 0 || content.length > MAX_RESPONSE_BYTES) return;
    File destination = ownedFile(key, ".checkpoint");
    File staging = ownedFile(key, ".writing");
    try (FileOutputStream stream = new FileOutputStream(staging);
         DataOutputStream output = new DataOutputStream(stream)) {
      output.writeInt(MAGIC);
      output.writeInt(content.length);
      output.write(digest(content));
      output.write(content);
      output.flush();
      stream.getFD().sync();
    }
    // Android rename replaces the destination atomically on the same filesystem.
    // Do not delete the previous checkpoint before attempting the rename.
    if (!staging.renameTo(destination)) throw new IOException("Checkpoint commit failed");
    prune();
  }

  private File ownedFile(String key, String suffix) throws IOException {
    if (!key.matches("[a-f0-9]{64}")) throw new IOException("Invalid checkpoint key");
    File file = new File(directory, key + suffix);
    if (!directory.equals(file.getCanonicalFile().getParentFile())) {
      throw new IOException("Checkpoint outside private storage");
    }
    return file;
  }

  private void prune() throws IOException {
    File[] files = directory.listFiles((parent, name) -> name.matches("[a-f0-9]{64}\\.(checkpoint|writing)"));
    if (files == null) throw new IOException("Checkpoint directory cannot be read");
    Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
    long retainedBytes = 0;
    int retainedCount = 0;
    long now = System.currentTimeMillis();
    for (File file : files) {
      if (!file.isFile() || !directory.equals(file.getCanonicalFile().getParentFile())) continue;
      retainedBytes += file.length();
      retainedCount += 1;
      if (now - file.lastModified() > RETENTION_MS || retainedCount > MAX_ENTRIES || retainedBytes > MAX_BYTES) {
        if (!file.delete()) throw new IOException("Checkpoint storage limit could not be maintained");
      }
    }
  }

  private static byte[] digest(byte[] content) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(content);
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException("SHA-256 unavailable", impossible);
    }
  }
}
