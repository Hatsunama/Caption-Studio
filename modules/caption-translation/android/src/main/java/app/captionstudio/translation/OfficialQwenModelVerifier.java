package app.captionstudio.translation;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;
import java.util.function.IntConsumer;

final class OfficialQwenModelVerifier implements TranslationModelVerifier {
  static final long EXPECTED_MODEL_BYTES = 1_597_931_520L;
  static final String EXPECTED_MODEL_SHA256 =
      "faa60663b333290c1496c499828b21d3e3254a788cacd8cce917ce0f761a2dc9";
  static final String MODEL_ID = "qwen2.5-1.5b-q8";
  private VerifiedModel verifiedModel;

  @Override
  public synchronized void verify(
      File model,
      BooleanSupplier cancelled,
      IntConsumer progress
  ) throws NaturalCaptionTranslator.TranslationFailure {
    if (model.length() != EXPECTED_MODEL_BYTES) {
      throw unsupported();
    }
    String canonicalPath = model.getAbsolutePath();
    long modifiedAt = model.lastModified();
    if (verifiedModel != null
        && verifiedModel.path.equals(canonicalPath)
        && verifiedModel.size == model.length()
        && verifiedModel.modifiedAt == modifiedAt) {
      progress.accept(100);
      return;
    }

    MessageDigest digest;
    try {
      digest = MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException error) {
      throw new NaturalCaptionTranslator.TranslationFailure(
          NaturalCaptionTranslator.UNSUPPORTED,
          "This device cannot verify the local translation model."
      );
    }

    byte[] buffer = new byte[1024 * 1024];
    long processedBytes = 0L;
    int reportedPercent = -1;
    try (FileInputStream input = new FileInputStream(model)) {
      while (true) {
        if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) {
          throw new CancellationException("Caption translation was cancelled");
        }
        int count = input.read(buffer);
        if (count < 0) break;
        if (count == 0) continue;
        digest.update(buffer, 0, count);
        processedBytes += count;
        int percent = (int) Math.min(100L, processedBytes * 100L / EXPECTED_MODEL_BYTES);
        if (percent != reportedPercent) {
          progress.accept(percent);
          reportedPercent = percent;
        }
      }
    } catch (CancellationException error) {
      throw error;
    } catch (IOException | SecurityException error) {
      throw new NaturalCaptionTranslator.TranslationFailure(
          NaturalCaptionTranslator.INVALID_REQUEST,
          "The local translation model could not be read."
      );
    }

    String actualHash = toHex(digest.digest());
    if (!EXPECTED_MODEL_SHA256.equals(actualHash)) throw unsupported();
    verifiedModel = new VerifiedModel(canonicalPath, model.length(), modifiedAt);
    progress.accept(100);
  }

  private static NaturalCaptionTranslator.TranslationFailure unsupported() {
    return new NaturalCaptionTranslator.TranslationFailure(
        NaturalCaptionTranslator.UNSUPPORTED,
        "The selected file is not the supported local Qwen translation model."
    );
  }

  private static String toHex(byte[] value) {
    StringBuilder output = new StringBuilder(value.length * 2);
    for (byte item : value) output.append(String.format(Locale.ROOT, "%02x", item & 0xff));
    return output.toString();
  }

  private static final class VerifiedModel {
    final String path;
    final long size;
    final long modifiedAt;

    VerifiedModel(String path, long size, long modifiedAt) {
      this.path = path;
      this.size = size;
      this.modifiedAt = modifiedAt;
    }
  }
}
